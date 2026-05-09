const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const axios = require('axios');

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

// ========== M‑Pesa Configuration (from environment variables) ==========
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;           // Paybill/Till shortcode (e.g., 4565717)
const MPESA_TILL_NUMBER = process.env.MPESA_TILL_NUMBER;       // For Buy Goods (if different)
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL || 'https://gograb-backend-production.up.railway.app/mpesa/callback';

// B2C Credentials (from G2 Portal)
const MPESA_B2C_INITIATOR_NAME = process.env.MPESA_B2C_INITIATOR_NAME;       // e.g., "B2C_Initiator"
const MPESA_B2C_SECURITY_CREDENTIAL = process.env.MPESA_B2C_SECURITY_CREDENTIAL; // encrypted password
const MPESA_B2C_COMMAND_ID = process.env.MPESA_B2C_COMMAND_ID || 'BusinessPayment';
const MPESA_B2C_QUEUE_TIMEOUT_URL = process.env.MPESA_B2C_QUEUE_TIMEOUT_URL || 'https://gograb-backend-production.up.railway.app/b2c/timeout';
const MPESA_B2C_RESULT_URL = process.env.MPESA_B2C_RESULT_URL || 'https://gograb-backend-production.up.railway.app/b2c/result';

// Helper: Get OAuth token
async function getMpesaAccessToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const response = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` },
  });
  return response.data.access_token;
}

// Helper: Generate password for STK push
function generatePassword(shortcode, passkey, timestamp) {
  const str = shortcode + passkey + timestamp;
  return Buffer.from(str).toString('base64');
}

// ========== Health check ==========
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== STK Push (Buy Goods) – Customer payments (top‑up, checkout) ==========
app.post('/api/mpesa/stkpush', async (req, res) => {
  const { amount, phone, accountRef, desc } = req.body;
  if (!amount || !phone) {
    return res.status(400).json({ error: 'Missing amount or phone' });
  }

  try {
    const accessToken = await getMpesaAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = generatePassword(MPESA_SHORTCODE, MPESA_PASSKEY, timestamp);

    const data = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: MPESA_TILL_NUMBER || MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: accountRef || 'GoGrabPayment',
      TransactionDesc: desc || 'Payment for order/wallet',
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

    res.json({ success: true, message: 'STK push sent', checkoutRequestID: response.data.CheckoutRequestID });
  } catch (error) {
    console.error('STK push error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to initiate STK push. Please try again.' });
  }
});

// ========== B2C Withdrawal (GoGrab pays vendor/rider/customer) ==========
app.post('/api/b2c/withdraw', async (req, res) => {
  const { userId, amount, userType, withdrawalId, phoneNumber, reason } = req.body;
  if (!userId || !amount || !userType || !withdrawalId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Get phone number either from request body or Firestore
  let phone = phoneNumber;
  if (!phone) {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    phone = userDoc.data()?.phone;
    if (!phone) return res.status(400).json({ error: 'User phone number not found' });
  }
  // Format phone: remove leading 0 or +, ensure 254...
  phone = phone.replace(/\D/g, '');
  if (phone.startsWith('0')) phone = '254' + phone.substring(1);
  if (!phone.startsWith('254')) phone = '254' + phone;
  if (phone.length < 12) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    const accessToken = await getMpesaAccessToken();
    const b2cRequest = {
      InitiatorName: MPESA_B2C_INITIATOR_NAME,
      SecurityCredential: MPESA_B2C_SECURITY_CREDENTIAL,
      CommandID: MPESA_B2C_COMMAND_ID,
      Amount: amount,
      PartyA: MPESA_SHORTCODE,
      PartyB: phone,
      Remarks: reason || `Withdrawal for ${userType}`,
      QueueTimeOutURL: MPESA_B2C_QUEUE_TIMEOUT_URL,
      ResultURL: MPESA_B2C_RESULT_URL,
      Occasion: 'GoGrabWithdrawal',
    };

    const response = await axios.post(
      'https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
      b2cRequest,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Store withdrawal transaction reference
    const conversationID = response.data.ConversationID;
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'processing',
      b2cConversationID: conversationID,
      initiatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: 'Withdrawal initiated', conversationID });
  } catch (error) {
    console.error('B2C error:', error.response?.data || error.message);
    // Mark withdrawal as failed
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'failed',
      failureReason: error.response?.data?.errorMessage || error.message,
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(500).json({ error: 'Withdrawal initiation failed' });
  }
});

// ========== B2C Result Callback (Safaricom sends final status) ==========
app.post('/b2c/result', async (req, res) => {
  console.log('B2C result callback:', JSON.stringify(req.body, null, 2));
  const { Result, ConversationID, TransactionID, ResultCode, ResultDesc } = req.body;
  // Find withdrawal by conversationID
  const withdrawalSnapshot = await db.collection('withdrawals').where('b2cConversationID', '==', ConversationID).limit(1).get();
  if (withdrawalSnapshot.empty) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
  const withdrawalDoc = withdrawalSnapshot.docs[0];
  const withdrawalId = withdrawalDoc.id;
  const status = ResultCode === '0' ? 'completed' : 'failed';
  await withdrawalDoc.ref.update({
    status,
    resultCode: ResultCode,
    resultDesc: ResultDesc,
    transactionId: TransactionID,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  // If failed, refund the wallet balance? (optional: implement based on business logic)
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ========== B2C Timeout Callback ==========
app.post('/b2c/timeout', async (req, res) => {
  console.log('B2C timeout callback:', JSON.stringify(req.body, null, 2));
  const { ConversationID } = req.body;
  const withdrawalSnapshot = await db.collection('withdrawals').where('b2cConversationID', '==', ConversationID).limit(1).get();
  if (!withdrawalSnapshot.empty) {
    await withdrawalSnapshot.docs[0].ref.update({
      status: 'timeout',
      timedOutAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Timeout processed' });
});

// ========== Legacy /api/withdraw (redirects to B2C) ==========
app.post('/api/withdraw', async (req, res) => {
  // For compatibility with admin app
  req.body.userType = req.body.userType || 'vendor';
  return app._router.handle(req, res, '/api/b2c/withdraw');
});

// ========== M‑Pesa STK Callback (existing) ==========
app.post('/mpesa/callback', async (req, res) => {
  console.log('M-Pesa callback received', JSON.stringify(req.body, null, 2));
  const { Body } = req.body;
  if (!Body || !Body.stkCallback) {
    return res.json({ ResultCode: 1, ResultDesc: 'Invalid request' });
  }
  const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = Body.stkCallback;
  const transactionRef = db.collection('mpesa_transactions').doc(CheckoutRequestID);
  const transactionDoc = await transactionRef.get();
  if (!transactionDoc.exists) return res.json({ ResultCode: 1, ResultDesc: 'Transaction not found' });

  const transaction = transactionDoc.data();
  const updateData = {
    resultCode: ResultCode,
    resultDesc: ResultDesc,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (ResultCode === 0 && CallbackMetadata) {
    const items = CallbackMetadata.Item;
    let receiptNumber = '', paidAmount = 0;
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

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));