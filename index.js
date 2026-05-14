const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

// Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://gograb-ke.firebaseio.com',
});

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ========== STK PUSH (customer payment) ==========
app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { amount, phone, accountRef, desc } = req.body;

    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const password = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const tokenResponse = await axios.get(
      'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { headers: { Authorization: `Basic ${auth}` } }
    );

    const accessToken = tokenResponse.data.access_token;

    const stkResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerBuyGoodsOnline',
        Amount: amount,
        PartyA: phone.replace(/^\+/, ''),
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: phone.replace(/^\+/, ''),
        CallBackURL: `${process.env.BASE_URL}/mpesa/callback`,
        AccountReference: accountRef,
        TransactionDesc: desc,
      },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    res.json({
      success: true,
      checkoutRequestID: stkResponse.data.CheckoutRequestID,
    });
  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.errorMessage || error.message,
    });
  }
});

// ========== STK CALLBACK (update wallet after payment) ==========
app.post('/mpesa/callback', async (req, res) => {
  try {
    const callback = req.body.Body.stkCallback;
    if (callback.ResultCode === 0) {
      const amount = callback.CallbackMetadata?.Item?.find(i => i.Name === 'Amount')?.Value;
      const phone = callback.CallbackMetadata?.Item?.find(i => i.Name === 'PhoneNumber')?.Value;
      const accountRef = callback.CallbackMetadata?.Item?.find(i => i.Name === 'AccountReference')?.Value;

      // Find the order/user and update wallet
      const ordersRef = admin.firestore().collection('orders');
      const orderSnapshot = await ordersRef.where('mpesaReceipt', '==', accountRef).limit(1).get();
      
      if (!orderSnapshot.empty) {
        const order = orderSnapshot.docs[0].data();
        const userId = order.userId;
        
        // Update wallet balance
        const walletRef = admin.firestore().collection('wallets').doc(userId);
        await walletRef.set({
          balance: admin.firestore.FieldValue.increment(Number(amount)),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    console.error('Callback error:', error);
    res.json({ ResultCode: 1, ResultDesc: 'Error' });
  }
});

// ========== WITHDRAWAL PROCESSING (admin only) ==========
// This endpoint is called by the admin app when processing a payout.
// It validates the admin token, deducts wallet, and initiates B2C payment.
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, userType, withdrawalId } = req.body;
    const idToken = req.headers.authorization?.split('Bearer ')[1];

    if (!idToken) {
      return res.status(401).json({ success: false, error: 'Missing auth token' });
    }

    // Verify the caller is an admin
    const decoded = await admin.auth().verifyIdToken(idToken);
    const adminUserDoc = await admin.firestore().collection('users').doc(decoded.uid).get();
    const adminRole = adminUserDoc.data()?.role;
    if (adminRole !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admins can process withdrawals' });
    }

    // Deduct from wallet
    const walletRef = admin.firestore().collection('wallets').doc(userId);
    const walletDoc = await walletRef.get();
    const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;

    if (currentBalance < amount) {
      return res.status(400).json({ success: false, error: 'Insufficient wallet balance' });
    }

    // Initiate B2C payment
    const b2cResult = await initiateB2C(userId, amount, userType);
    if (!b2cResult.success) {
      return res.status(500).json({ success: false, error: b2cResult.error || 'B2C payment failed' });
    }

    // Deduct wallet and mark withdrawal as processed
    await walletRef.update({
      balance: admin.firestore.FieldValue.increment(-amount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (withdrawalId) {
      await admin.firestore().collection('withdrawals').doc(withdrawalId).update({
        status: 'processed',
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json({ success: true, message: 'Withdrawal processed' });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== B2C Helper ==========
async function initiateB2C(userId, amount, userType) {
  try {
    // Get user phone from Firestore
    const userDoc = await admin.firestore().collection('users').doc(userId).get();
    const userPhone = userDoc.data()?.phone;
    if (!userPhone) {
      return { success: false, error: 'User phone not found' };
    }

    // Safaricom B2C API authentication
    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const tokenResponse = await axios.get(
      'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { headers: { Authorization: `Basic ${auth}` } }
    );

    const accessToken = tokenResponse.data.access_token;

    // B2C request
    const b2cResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
      {
        InitiatorName: process.env.MPESA_B2C_INITIATOR_NAME,
        SecurityCredential: process.env.MPESA_B2C_SECURITY_CREDENTIAL,
        CommandID: 'BusinessPayment',
        Amount: amount,
        PartyA: process.env.MPESA_B2C_SHORTCODE,
        PartyB: userPhone,
        Remarks: `Withdrawal for ${userType}`,
        QueueTimeOutURL: `${process.env.BASE_URL}/api/b2c/queue-timeout`,
        ResultURL: `${process.env.BASE_URL}/api/b2c/result`,
        Occasion: 'Withdrawal',
      },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (b2cResponse.data.ResponseCode === '0') {
      return { success: true };
    } else {
      return { success: false, error: b2cResponse.data.ResponseDescription };
    }
  } catch (error) {
    console.error('B2C error:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.errorMessage || error.message };
  }
}

// ========== ORDER STATUS LISTENER (FCM) ==========
function startFCMListener() {
  console.log('Starting FCM order status listener...');
  admin.firestore().collection('orders_shared').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'modified') {
        const order = change.doc.data();
        const previous = change.doc._previousData;
        const newStatus = order.status;
        const oldStatus = previous?.status;
        if (newStatus !== oldStatus) {
          console.log(`Order ${change.doc.id} changed from ${oldStatus} to ${newStatus}`);
          // Send FCM notification to involved users
          const userIds = [order.userId, order.vendorId, order.riderId].filter(Boolean);
          for (const userId of userIds) {
            try {
              const userTokensDoc = await admin.firestore().collection('fcm_tokens').doc(userId).get();
              if (userTokensDoc.exists) {
                const tokens = userTokensDoc.data()?.tokens || [];
                // Send notification (simplified – replace with actual messaging)
                console.log(`No FCM token found for user ${userId}`);
              }
            } catch (e) {
              console.error(`Error sending FCM to ${userId}:`, e);
            }
          }
        }
      }
    });
  });
}

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  startFCMListener();
});