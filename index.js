const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://gograb-ke.firebaseio.com',
});

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || 'https://gograb-backend-production.up.railway.app';

// ✅ PAYBILL 4053477 – used for both STK Push and B2C
const SHORTCODE = '4053477';

// ========== STK PUSH ==========
app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { amount, phone, accountRef, desc, BusinessShortCode, PartyB, TransactionType } = req.body;

    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const password = Buffer.from(
      `${SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const tokenResponse = await axios.get(
      'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { headers: { Authorization: `Basic ${auth}` } }
    );

    const accessToken = tokenResponse.data.access_token;

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: TransactionType || 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: PartyB || SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: `${BASE_URL}/mpesa/callback`,
      AccountReference: accountRef,
      TransactionDesc: desc,
    };

    console.log('STK Push payload:', JSON.stringify(payload, null, 2));

    const stkResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    console.log('STK Push response:', JSON.stringify(stkResponse.data, null, 2));

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

// ========== STK CALLBACK ==========
app.post('/mpesa/callback', async (req, res) => {
  try {
    console.log('📩 Callback received:', JSON.stringify(req.body, null, 2));

    const callback = req.body.Body.stkCallback;
    if (callback && callback.ResultCode === 0) {
      console.log('✅ Payment successful');

      let amount = null;
      let accountRef = null;

      const items = callback.CallbackMetadata?.Item;
      if (items) {
        for (const item of items) {
          if (item.Name === 'Amount') amount = item.Value;
          if (item.Name === 'AccountReference') accountRef = item.Value;
        }
      }

      if (!amount || !accountRef) {
        console.log('⚠️ Missing Amount or AccountReference – wallet not updated');
        return res.json({ ResultCode: 0, ResultDesc: 'Success' });
      }

      console.log(`Amount: ${amount}, AccountRef: ${accountRef}`);

      const ordersSharedRef = admin.firestore().collection('orders_shared');
      const orderSnapshot = await ordersSharedRef.where('mpesaReceipt', '==', accountRef).limit(1).get();

      if (!orderSnapshot.empty) {
        const orderDoc = orderSnapshot.docs[0];
        const order = orderDoc.data();
        const userId = order.userId;

        await orderDoc.ref.update({
          paymentStatus: 'paid',
          mpesaReceiptNumber: accountRef,
        });

        const walletRef = admin.firestore().collection('wallets').doc(userId);
        await walletRef.set({
          balance: admin.firestore.FieldValue.increment(Number(amount)),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        console.log('✅ Wallet updated and order status set to paid');
      } else {
        const ordersRef = admin.firestore().collection('orders');
        const legacySnapshot = await ordersRef.where('mpesaReceipt', '==', accountRef).limit(1).get();
        if (!legacySnapshot.empty) {
          const orderDoc = legacySnapshot.docs[0];
          const order = orderDoc.data();
          const userId = order.userId;

          await orderDoc.ref.update({
            paymentStatus: 'paid',
            mpesaReceiptNumber: accountRef,
          });

          const walletRef = admin.firestore().collection('wallets').doc(userId);
          await walletRef.set({
            balance: admin.firestore.FieldValue.increment(Number(amount)),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });

          console.log('✅ Wallet updated (legacy orders)');
        } else {
          console.log(`❌ No order found with mpesaReceipt: ${accountRef}`);
        }
      }
    } else {
      console.log('❌ Payment failed/cancelled:', callback?.ResultDesc);
    }

    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    console.error('Callback error:', error);
    res.json({ ResultCode: 1, ResultDesc: 'Error' });
  }
});

// ========== GENERIC WITHDRAWAL (with auth token) ==========
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, userType, accountDetails } = req.body;
    const idToken = req.headers.authorization?.split('Bearer ')[1];

    if (!idToken) {
      return res.status(401).json({ success: false, error: 'Missing auth token' });
    }

    await admin.auth().verifyIdToken(idToken);

    const b2cResult = await initiateB2C(userId, amount, userType, accountDetails);
    if (!b2cResult.success) {
      return res.status(400).json({
        success: false,
        error: b2cResult.error || 'B2C payment failed',
        details: b2cResult.details || null,
      });
    }

    res.json({ success: true, message: 'Withdrawal processed' });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== VENDOR WITHDRAWAL (from vendor app) ==========
app.post('/api/request-withdrawal', async (req, res) => {
  try {
    const { vendorId, amount, phoneNumber } = req.body;
    if (!vendorId || !amount || !phoneNumber) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }
    if (amount < 50 || amount > 150000) {
      return res.status(400).json({ success: false, message: 'Amount must be between 50 and 150,000' });
    }

    const b2cResult = await initiateB2C(vendorId, amount, 'vendor', phoneNumber);
    if (!b2cResult.success) {
      return res.status(400).json({
        success: false,
        message: b2cResult.error || 'B2C payment failed',
      });
    }

    res.json({ success: true, message: 'Withdrawal processed' });
  } catch (error) {
    console.error('Vendor Withdrawal error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 🆕 RIDER WITHDRAWAL (from rider app)
app.post('/api/rider-request-withdrawal', async (req, res) => {
  try {
    const { riderId, amount, phoneNumber } = req.body;
    if (!riderId || !amount || !phoneNumber) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }
    if (amount < 50 || amount > 150000) {
      return res.status(400).json({ success: false, message: 'Amount must be between 50 and 150,000' });
    }

    const b2cResult = await initiateB2C(riderId, amount, 'rider', phoneNumber);
    if (!b2cResult.success) {
      return res.status(400).json({
        success: false,
        message: b2cResult.error || 'B2C payment failed',
      });
    }

    res.json({ success: true, message: 'Withdrawal processed' });
  } catch (error) {
    console.error('Rider Withdrawal error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== B2C Helper ==========
async function initiateB2C(userId, amount, userType, accountDetails) {
  try {
    console.log('Initiating B2C payment...');
    console.log(`UserId: ${userId}, Amount: ${amount}, UserType: ${userType}, AccountDetails: ${accountDetails}`);

    let userPhone = accountDetails;

    if (!userPhone || userPhone.startsWith('4')) {
      const userDoc = await admin.firestore().collection('users').doc(userId).get();
      const userData = userDoc.data() || {};
      userPhone = userData.phone || userData.phoneNumber || accountDetails;
    }

    if (!userPhone || userPhone === '0700000005') {
      return { success: false, error: 'No valid phone number found for user' };
    }

    const cleanPhone = userPhone.replace(/^\+/, '').replace(/^0/, '254');
    console.log(`Final phone: ${cleanPhone}`);

    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const tokenResponse = await axios.get(
      'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { headers: { Authorization: `Basic ${auth}` } }
    );

    const accessToken = tokenResponse.data.access_token;

    const b2cPayload = {
      InitiatorName: process.env.MPESA_B2C_INITIATOR_NAME,
      SecurityCredential: process.env.MPESA_B2C_SECURITY_CREDENTIAL,
      CommandID: 'BusinessPayment',
      Amount: amount,
      PartyA: SHORTCODE,
      PartyB: cleanPhone,
      Remarks: `Withdrawal for ${userType}`,
      QueueTimeOutURL: `${BASE_URL}/api/b2c/queue-timeout`,
      ResultURL: `${BASE_URL}/api/b2c/result`,
      Occasion: 'Withdrawal',
    };

    const b2cResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
      b2cPayload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    console.log('B2C response:', JSON.stringify(b2cResponse.data, null, 2));

    if (b2cResponse.data.ResponseCode === '0') {
      return { success: true };
    } else {
      return {
        success: false,
        error: b2cResponse.data.ResponseDescription || b2cResponse.data.errorMessage,
        details: b2cResponse.data,
      };
    }
  } catch (error) {
    console.error('B2C error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.errorMessage || error.message,
      details: error.response?.data || null,
    };
  }
}

// ========== ORDER STATUS LISTENER ==========
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