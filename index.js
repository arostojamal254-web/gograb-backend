const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

dotenv.config();

// ========== Firebase Admin SDK ==========
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
} else {
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || 'gograb-ke',
  });
}
const db = admin.firestore();

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

// ========== M‑Pesa Configuration ==========
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || '6xYLGMHo62G8ryNAgraLDvcXEKEJKmG0Zb2b0R2NZj3q6uim';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || 'l8gq8Z6LnmZ24eD8hsK8r7uwiarD5gVEnmEjmP03itmQQMZr2Iyz2B9YbTQnoqpe';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '5c864834abc95f672da6591a6bb4a46bfbe41ccd18888cb84003db4a879915f6';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '4565717';        // Paybill/Till shortcode
const MPESA_TILL_NUMBER = process.env.MPESA_TILL_NUMBER || '4565781';    // Till number for Buy Goods
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL || 'https://gograb-backend-production.up.railway.app/mpesa/callback';

// B2C credentials
const MPESA_B2C_INITIATOR_NAME = process.env.MPESA_B2C_INITIATOR_NAME || 'arosto';
const MPESA_B2C_SECURITY_CREDENTIAL = process.env.MPESA_B2C_SECURITY_CREDENTIAL; // Must be set – pre‑generated
const MPESA_B2C_SHORTCODE = process.env.MPESA_B2C_SHORTCODE || MPESA_SHORTCODE;

// Helper: Get OAuth token (same for both APIs)
async function getMpesaAccessToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const response = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` },
  });
  return response.data.access_token;
}

// Helper: Generate password for STK push
function generateSTKPassword(shortcode, passkey, timestamp) {
  const str = shortcode + passkey + timestamp;
  return Buffer.from(str).toString('base64');
}

// ========== Health check ==========
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== 1. STK Push (CustomerBuyGoodsOnline – Till Payment) ==========
app.post('/api/mpesa/stkpush', async (req, res) => {
  const { amount, phone, accountRef, desc } = req.body;
  if (!amount || !phone) {
    return res.status(400).json({ error: 'Missing amount or phone' });
  }

  try {
    const accessToken = await getMpesaAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = generateSTKPassword(MPESA_SHORTCODE, MPESA_PASSKEY, timestamp);

    const data = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: MPESA_TILL_NUMBER,
      PhoneNumber: phone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: accountRef || 'GoGrabPayment',
      TransactionDesc: desc || 'Payment',
    };

    const response = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      data,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const transactionRef = db.collection('mpesa_transactions').doc(response.data.CheckoutRequestID);
    await transactionRef.set({
      checkoutRequestID: response.data.CheckoutRequestID,
      amount,
      phone,
      accountRef,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      message: 'STK push sent',
      checkoutRequestID: response.data.CheckoutRequestID,
    });
  } catch (error) {
    console.error('STK push error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to initiate STK push' });
  }
});

// ========== 2. M‑Pesa Callback (for STK Push) ==========
app.post('/mpesa/callback', async (req, res) => {
  console.log('M-Pesa callback received', JSON.stringify(req.body, null, 2));
  const { Body } = req.body;
  if (!Body || !Body.stkCallback) {
    return res.json({ ResultCode: 1, ResultDesc: 'Invalid request' });
  }

  const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = Body.stkCallback;
  const transactionRef = db.collection('mpesa_transactions').doc(CheckoutRequestID);
  const transactionDoc = await transactionRef.get();

  if (!transactionDoc.exists) {
    return res.json({ ResultCode: 1, ResultDesc: 'Transaction not found' });
  }

  const transaction = transactionDoc.data();
  const updateData = {
    resultCode: ResultCode,
    resultDesc: ResultDesc,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (ResultCode === 0 && CallbackMetadata) {
    const items = CallbackMetadata.Item;
    let receiptNumber = '';
    let paidAmount = 0;
    for (let item of items) {
      if (item.Name === 'MpesaReceiptNumber') receiptNumber = item.Value;
      if (item.Name === 'Amount') paidAmount = item.Value;
    }
    updateData.receiptNumber = receiptNumber;
    updateData.paidAmount = paidAmount;
    updateData.status = 'completed';

    const { accountRef, amount, phone } = transaction;
    if (accountRef.startsWith('Order')) {
      const orderId = accountRef.replace('Order', '');
      await db.collection('orders').doc(orderId).update({
        paymentStatus: 'paid',
        mpesaReceipt: receiptNumber,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else if (accountRef === 'WalletTopUp') {
      const userQuery = await db.collection('users').where('phone', '==', phone).limit(1).get();
      if (!userQuery.empty) {
        const userId = userQuery.docs[0].id;
        const walletRef = db.collection('wallets').doc(userId);
        await db.runTransaction(async (t) => {
          const walletDoc = await t.get(walletRef);
          const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
          t.set(walletRef, { balance: currentBalance + amount, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        });
      }
    }
  } else {
    updateData.status = 'failed';
  }

  await transactionRef.update(updateData);
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ========== 3. B2C Withdrawal (GoGrab → Vendor/Rider/Customer) ==========
app.post('/api/b2c/withdraw', async (req, res) => {
  const { userId, amount, userType, withdrawalId, phoneNumber } = req.body;
  if (!userId || !amount || !userType || !withdrawalId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate B2C credential is set
  if (!MPESA_B2C_SECURITY_CREDENTIAL) {
    console.error('B2C Security Credential not set in environment variables');
    return res.status(500).json({ error: 'B2C not configured' });
  }

  // Get user's phone number (if not provided, fetch from Firestore)
  let phone = phoneNumber;
  if (!phone) {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    phone = userDoc.data()?.phone;
    if (!phone) return res.status(400).json({ error: 'User phone number missing' });
  }

  // Format phone number to 254XXXXXXXXX
  phone = phone.replace(/\D/g, '');
  if (phone.startsWith('0')) phone = '254' + phone.substring(1);
  if (!phone.startsWith('254')) phone = '254' + phone;

  try {
    const accessToken = await getMpesaAccessToken();

    const b2cData = {
      InitiatorName: MPESA_B2C_INITIATOR_NAME,
      SecurityCredential: MPESA_B2C_SECURITY_CREDENTIAL,
      CommandID: 'BusinessPayment',                      // For paying vendors/riders/customers
      Amount: Math.round(amount),
      PartyA: MPESA_B2C_SHORTCODE,
      PartyB: phone,
      Remarks: `Withdrawal for ${userType}`,
      QueueTimeOutURL: `${MPESA_CALLBACK_URL}/b2c/timeout`,
      ResultURL: `${MPESA_CALLBACK_URL}/b2c/result`,
      Occasion: `GoGrab_Withdrawal_${withdrawalId}`,
    };

    const response = await axios.post(
      'https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
      b2cData,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Store B2C transaction in Firestore
    const b2cRef = db.collection('b2c_transactions').doc(response.data.ConversationID);
    await b2cRef.set({
      conversationID: response.data.ConversationID,
      originatorCoversationID: response.data.OriginatorCoversationID,
      userId,
      withdrawalId,
      amount,
      phone,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update withdrawal record as processing
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'processing',
      b2cInitiatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: 'B2C withdrawal initiated', conversationID: response.data.ConversationID });
  } catch (error) {
    console.error('B2C withdrawal error:', error.response?.data || error.message);
    // Mark withdrawal as failed
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'failed',
      failureReason: error.response?.data?.errorMessage || error.message,
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(500).json({ error: 'B2C withdrawal failed' });
  }
});

// B2C Result Callback (Safaricom sends final status)
app.post('/mpesa/b2c/result', async (req, res) => {
  console.log('B2C Result callback:', JSON.stringify(req.body, null, 2));
  const { Result, OriginatorConversationID } = req.body;
  if (!Result || !OriginatorConversationID) {
    return res.status(200).json({ success: false });
  }

  const b2cRef = db.collection('b2c_transactions').doc(OriginatorConversationID);
  const b2cDoc = await b2cRef.get();
  if (!b2cDoc.exists) return res.status(200).json({ success: false });

  const b2cData = b2cDoc.data();
  const withdrawalId = b2cData.withdrawalId;
  const success = Result.ResultCode === 0;
  const status = success ? 'completed' : 'failed';

  await db.collection('withdrawals').doc(withdrawalId).update({
    status,
    processedAt: admin.firestore.FieldValue.serverTimestamp(),
    b2cResultCode: Result.ResultCode,
    b2cResultDesc: Result.ResultDesc,
  });

  await b2cRef.update({
    status,
    resultCode: Result.ResultCode,
    resultDesc: Result.ResultDesc,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.status(200).json({ success: true });
});

// B2C Timeout Callback
app.post('/mpesa/b2c/timeout', async (req, res) => {
  console.log('B2C Timeout callback:', JSON.stringify(req.body, null, 2));
  const { OriginatorConversationID } = req.body;
  if (!OriginatorConversationID) return res.status(200).json({ success: false });

  const b2cRef = db.collection('b2c_transactions').doc(OriginatorConversationID);
  const b2cDoc = await b2cRef.get();
  if (b2cDoc.exists) {
    const withdrawalId = b2cDoc.data().withdrawalId;
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'timeout',
      timeoutAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await b2cRef.update({ status: 'timeout', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  res.status(200).json({ success: true });
});

// Legacy withdrawal endpoint (redirect to B2C)
app.post('/api/withdraw', async (req, res) => {
  // Forward to the new B2C endpoint
  const { userId, amount, userType, withdrawalId, phoneNumber } = req.body;
  req.body.phoneNumber = phoneNumber || (await db.collection('users').doc(userId).get()).data()?.phone;
  return app.handle(req, res, '/api/b2c/withdraw');
});

// ========== 4. FCM Push Notifications on Order Status Change ==========
// This listener runs in the background and sends FCM messages to customers,
// vendors, and riders when an order's status changes.
(async function startFCMListener() {
  console.log('Starting FCM order status listener...');
  
  db.collection('orders_shared')
    .where('status', 'in', [
      'pending',
      'accepted',
      'preparing',
      'readyForPickup',
      'rider_assigned',
      'picked_up',
      'delivering',
      'delivered'
    ])
    .onSnapshot(async (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        // Only handle modified documents (status changes)
        if (change.type !== 'modified') return;

        const beforeData = change.doc._previousData;  // may be undefined
        const afterData = change.doc.data();
        const orderId = change.doc.id;

        const oldStatus = beforeData ? beforeData.status : null;
        const newStatus = afterData.status;

        // Avoid duplicate notifications if status didn't change
        if (oldStatus === newStatus) return;

        console.log(`Order ${orderId} changed from ${oldStatus} to ${newStatus}`);

        const customerId = afterData.userId || afterData.customerId;
        const vendorId = afterData.vendorId;
        const riderId = afterData.riderId;

        // Decide who to notify based on new status
        switch (newStatus) {
          case 'pending':
            // New order – notify vendor
            if (vendorId) await sendFCM(vendorId, '🛎️ New Order', `Order #${orderId.substring(0,6)} just placed`, orderId, 'delivery');
            break;

          case 'accepted':
            if (customerId) await sendFCM(customerId, '✅ Vendor Accepted', `Your order #${orderId.substring(0,6)} has been accepted`, orderId, 'delivery');
            break;

          case 'preparing':
            if (customerId) await sendFCM(customerId, '🍳 Order Preparing', `Your order #${orderId.substring(0,6)} is being prepared`, orderId, 'delivery');
            break;

          case 'readyForPickup':
            if (customerId) await sendFCM(customerId, '📦 Order Ready', `Your order #${orderId.substring(0,6)} is ready for pickup`, orderId, 'delivery');
            // Optionally notify riders (you already have Redis for auto‑assignment)
            break;

          case 'rider_assigned':
            if (customerId) await sendFCM(customerId, '🛵 Rider Assigned', `A rider is heading to pick up your order #${orderId.substring(0,6)}`, orderId, 'delivery');
            if (riderId) await sendFCM(riderId, '🛵 New Delivery', `You have been assigned to deliver order #${orderId.substring(0,6)}`, orderId, 'delivery');
            break;

          case 'picked_up':
            if (customerId) await sendFCM(customerId, '📦 Order Picked Up', `Your order #${orderId.substring(0,6)} is on the way`, orderId, 'delivery');
            break;

          case 'delivering':
            if (customerId) await sendFCM(customerId, '🚚 On the Way', `Your order #${orderId.substring(0,6)} is being delivered`, orderId, 'delivery');
            break;

          case 'delivered':
            if (customerId) await sendFCM(customerId, '📬 Delivered!', `Your order #${orderId.substring(0,6)} has been delivered`, orderId, 'delivery');
            if (vendorId) await sendFCM(vendorId, '🏁 Order Delivered', `Order #${orderId.substring(0,6)} was delivered successfully`, orderId, 'delivery');
            break;
        }
      });
    }, (error) => {
      console.error('FCM listener error:', error);
    });
})();

// Helper function to send FCM push notification to a specific user
async function sendFCM(userId, title, body, orderId, type) {
  try {
    // Retrieve the user's FCM token from Firestore (assumes tokens stored in `fcm_tokens/{userId}`)
    const tokenDoc = await db.collection('fcm_tokens').doc(userId).get();
    if (!tokenDoc.exists) {
      console.log(`No FCM token found for user ${userId}`);
      return;
    }

    const token = tokenDoc.data().token;
    if (!token) return;

    const message = {
      token: token,
      notification: {
        title: title,
        body: body,
      },
      data: {
        orderId: orderId,
        type: type,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'gograb_channel',
          icon: 'ic_launcher',
        },
      },
    };

    const response = await admin.messaging().send(message);
    console.log(`FCM sent to ${userId}: ${response}`);
  } catch (error) {
    console.error(`Error sending FCM to ${userId}:`, error);
  }
}

// ========== Start Server ==========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));