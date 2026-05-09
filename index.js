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

// ========== M‑Pesa Configuration ==========
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;               // e.g., 4565717
const MPESA_TILL_NUMBER = process.env.MPESA_TILL_NUMBER || MPESA_SHORTCODE; // For Buy Goods
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL || 'https://gograb-backend-production.up.railway.app/mpesa/callback';
const MPESA_B2C_RESULT_URL = process.env.MPESA_B2C_RESULT_URL || 'https://gograb-backend-production.up.railway.app/mpesa/b2c/result';
const MPESA_B2C_TIMEOUT_URL = process.env.MPESA_B2C_TIMEOUT_URL || 'https://gograb-backend-production.up.railway.app/mpesa/b2c/timeout';
const MPESA_B2C_INITIATOR_NAME = process.env.MPESA_B2C_INITIATOR_NAME || 'GoGrabAdmin';
const MPESA_B2C_INITIATOR_PASSWORD = process.env.MPESA_B2C_INITIATOR_PASSWORD;
const MPESA_B2C_SECURITY_CREDENTIAL = process.env.MPESA_B2C_SECURITY_CREDENTIAL;

// Helper: Get OAuth token
async function getMpesaAccessToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const response = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` },
  });
  return response.data.access_token;
}

// Helper: Generate password for STK push
function generateStkPassword(shortcode, passkey, timestamp) {
  const str = shortcode + passkey + timestamp;
  return Buffer.from(str).toString('base64');
}

// ========== Health check ==========
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== 1. STK Push (Customer pays GoGrab – Wallet Top‑up / Order Payment) ==========
app.post('/api/mpesa/stkpush', async (req, res) => {
  const { amount, phone, accountRef, desc } = req.body;
  if (!amount || !phone) {
    return res.status(400).json({ error: 'Missing amount or phone' });
  }

  try {
    const accessToken = await getMpesaAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = generateStkPassword(MPESA_SHORTCODE, MPESA_PASSKEY, timestamp);

    const data = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: MPESA_TILL_NUMBER,
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

    await db.collection('mpesa_transactions').doc(response.data.CheckoutRequestID).set({
      checkoutRequestID: response.data.CheckoutRequestID,
      amount,
      phone,
      accountRef,
      status: 'pending',
      type: 'stkpush',
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

// ========== 2. M‑Pesa STK Push Callback ==========
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

// ========== 3. B2C Withdrawal (GoGrab pays Vendor/Rider/Customer) ==========
app.post('/api/b2c/withdraw', async (req, res) => {
  const { userId, amount, userType, withdrawalId } = req.body;
  if (!userId || !amount || !userType || !withdrawalId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();
    const phone = userData.phone; // Must be in format 2547XXXXXXXX
    if (!phone || !phone.startsWith('254')) {
      return res.status(400).json({ error: 'Invalid phone number (must start with 254)' });
    }

    const accessToken = await getMpesaAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const securityCredential = Buffer.from(MPESA_B2C_SECURITY_CREDENTIAL).toString('base64'); // Should be the base64 encoded certificate

    const data = {
      InitiatorName: MPESA_B2C_INITIATOR_NAME,
      SecurityCredential: securityCredential,
      CommandID: 'BusinessPayment',   // For paying vendors/riders (could also be 'SalaryPayment' or 'PromotionPayment')
      Amount: amount,
      PartyA: MPESA_SHORTCODE,
      PartyB: phone,
      Remarks: `Withdrawal for ${userType}`,
      QueueTimeOutURL: MPESA_B2C_TIMEOUT_URL,
      ResultURL: MPESA_B2C_RESULT_URL,
      Occasion: `Withdrawal ${withdrawalId}`,
    };

    const response = await axios.post(
      'https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
      data,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Store B2C transaction in Firestore
    const b2cRef = db.collection('b2c_transactions').doc(response.data.ConversationID);
    await b2cRef.set({
      conversationID: response.data.ConversationID,
      originatorConversationID: response.data.OriginatorConversationID,
      userId,
      amount,
      userType,
      withdrawalId,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update withdrawal status to 'processing'
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'processing',
      initiatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: 'B2C withdrawal initiated', conversationID: response.data.ConversationID });
  } catch (error) {
    console.error('B2C error:', error.response?.data || error.message);
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'failed',
      failureReason: error.response?.data?.errorMessage || error.message,
    });
    res.status(500).json({ error: 'Failed to initiate B2C payment' });
  }
});

// ========== 4. B2C Result URL (Safaricom sends result) ==========
app.post('/mpesa/b2c/result', async (req, res) => {
  console.log('B2C Result received:', JSON.stringify(req.body, null, 2));
  const { Result } = req.body;
  if (!Result) return res.status(200).send();

  const { ConversationID, ResultCode, ResultDesc, TransactionID } = Result;
  const b2cRef = db.collection('b2c_transactions').doc(ConversationID);
  const b2cDoc = await b2cRef.get();
  if (!b2cDoc.exists) return res.status(200).send();

  const b2cData = b2cDoc.data();
  const withdrawalRef = db.collection('withdrawals').doc(b2cData.withdrawalId);
  if (ResultCode === 0) {
    await b2cRef.update({ status: 'completed', resultCode: ResultCode, resultDesc: ResultDesc, transactionID: TransactionID });
    await withdrawalRef.update({
      status: 'processed',
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      transactionId: TransactionID,
    });
    // Deduct from user's wallet (already done in admin withdrawal initiation? We'll ensure it's deducted once)
    // In the initiation, we already deducted. If not, deduct here.
  } else {
    await b2cRef.update({ status: 'failed', resultCode: ResultCode, resultDesc: ResultDesc });
    await withdrawalRef.update({
      status: 'failed',
      failureReason: ResultDesc,
    });
    // Refund the wallet (re-add the amount)
    const userId = b2cData.userId;
    const amount = b2cData.amount;
    const walletRef = db.collection('wallets').doc(userId);
    await db.runTransaction(async (t) => {
      const walletDoc = await t.get(walletRef);
      const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
      t.set(walletRef, { balance: currentBalance + amount, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
  }
  res.status(200).send();
});

// ========== 5. B2C Timeout URL ==========
app.post('/mpesa/b2c/timeout', async (req, res) => {
  console.log('B2C Timeout received:', JSON.stringify(req.body, null, 2));
  const { ConversationID } = req.body;
  if (ConversationID) {
    const b2cRef = db.collection('b2c_transactions').doc(ConversationID);
    const b2cDoc = await b2cRef.get();
    if (b2cDoc.exists) {
      await b2cRef.update({ status: 'timeout' });
      const b2cData = b2cDoc.data();
      await db.collection('withdrawals').doc(b2cData.withdrawalId).update({
        status: 'failed',
        failureReason: 'Timeout',
      });
      // Refund wallet
      const userId = b2cData.userId;
      const amount = b2cData.amount;
      const walletRef = db.collection('wallets').doc(userId);
      await db.runTransaction(async (t) => {
        const walletDoc = await t.get(walletRef);
        const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
        t.set(walletRef, { balance: currentBalance + amount, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      });
    }
  }
  res.status(200).send();
});

// ========== 6. Legacy /api/withdraw (for admin app – just calls B2C) ==========
app.post('/api/withdraw', async (req, res) => {
  const { userId, amount, userType, withdrawalId } = req.body;
  if (!userId || !amount || !userType || !withdrawalId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  // Forward to the B2C endpoint
  try {
    const b2cResp = await axios.post(`http://localhost:${process.env.PORT || 8080}/api/b2c/withdraw`, req.body);
    res.json(b2cResp.data);
  } catch (error) {
    console.error('Legacy withdraw error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to process withdrawal' });
  }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));