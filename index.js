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

// ========== M‑Pesa Configuration (live credentials) ==========
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;          // e.g., 4565717
const MPESA_TILL_NUMBER = process.env.MPESA_TILL_NUMBER;      // e.g., 4565781 (for Buy Goods)
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL || 'https://gograb-backend-production.up.railway.app/mpesa/callback';

// B2C credentials (from G2 portal)
const MPESA_INITIATOR_NAME = process.env.MPESA_INITIATOR_NAME;
const MPESA_SECURITY_CREDENTIAL = process.env.MPESA_SECURITY_CREDENTIAL;  // encrypted password
const MPESA_B2C_RESULT_URL = process.env.MPESA_B2C_RESULT_URL || 'https://gograb-backend-production.up.railway.app/b2c/result';
const MPESA_B2C_TIMEOUT_URL = process.env.MPESA_B2C_TIMEOUT_URL || 'https://gograb-backend-production.up.railway.app/b2c/timeout';

// Helper: Get OAuth token (live)
async function getMpesaAccessToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const response = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` },
  });
  return response.data.access_token;
}

// Helper: Generate password for STK push (Buy Goods)
function generatePassword(shortcode, passkey, timestamp) {
  const str = shortcode + passkey + timestamp;
  return Buffer.from(str).toString('base64');
}

// ========== Health check ==========
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== STK Push (Buy Goods) – for customer payments ==========
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

    // Store transaction in Firestore
    const transactionRef = db.collection('mpesa_transactions').doc(response.data.CheckoutRequestID);
    await transactionRef.set({
      checkoutRequestID: response.data.CheckoutRequestID,
      amount,
      phone,
      accountRef,
      type: 'stkpush',
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
    res.status(500).json({ error: 'Failed to initiate STK push. Please try again.' });
  }
});

// ========== M‑Pesa Callback (STK Push result) ==========
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

// ========== B2C Withdrawal (for vendors, riders, customers) ==========
app.post('/api/b2c/withdraw', async (req, res) => {
  const { userId, amount, userType, withdrawalId } = req.body;
  if (!userId || !amount || !userType || !withdrawalId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Fetch user details
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();
    const phone = userData.phone; // must be in format 254XXXXXXXXX

    if (!phone) {
      return res.status(400).json({ error: 'User has no phone number' });
    }

    const accessToken = await getMpesaAccessToken();

    // B2C request payload (live)
    const requestData = {
      InitiatorName: MPESA_INITIATOR_NAME,
      SecurityCredential: MPESA_SECURITY_CREDENTIAL,
      CommandID: 'BusinessPayment',   // or 'SalaryPayment', 'PromotionPayment'
      Amount: amount,
      PartyA: MPESA_SHORTCODE,
      PartyB: phone,
      Remarks: `GoGrab withdrawal for ${userType}`,
      QueueTimeOutURL: MPESA_B2C_TIMEOUT_URL,
      ResultURL: MPESA_B2C_RESULT_URL,
      Occasion: 'Withdrawal',
    };

    const response = await axios.post(
      'https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
      requestData,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Store transaction in Firestore for callback tracking
    const transactionRef = db.collection('b2c_transactions').doc(response.data.ConversationID);
    await transactionRef.set({
      conversationID: response.data.ConversationID,
      originatorConversationID: response.data.OriginatorConversationID,
      userId,
      withdrawalId,
      amount,
      userType,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Immediately mark withdrawal as processing (optional, not deducted yet)
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'processing',
      initiatedAt: admin.firestore.FieldValue.serverTimestamp(),
      conversationID: response.data.ConversationID,
    });

    // Do NOT deduct wallet balance here – will be done on successful callback
    res.json({ success: true, message: 'Withdrawal initiated', conversationID: response.data.ConversationID });
  } catch (error) {
    console.error('B2C withdrawal error:', error.response?.data || error.message);
    // Mark withdrawal as failed
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'failed',
      failureReason: error.response?.data?.errorMessage || error.message,
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(500).json({ error: 'Failed to initiate withdrawal. Please try again.' });
  }
});

// ========== B2C Result Callback (Safaricom sends final status) ==========
app.post('/b2c/result', async (req, res) => {
  console.log('B2C result callback received:', JSON.stringify(req.body, null, 2));
  const { Result, ResultParameters } = req.body;
  if (!Result) {
    return res.status(200).send('OK');
  }

  const conversationID = Result.ConversationID;
  const resultCode = Result.ResultCode;
  const resultDesc = Result.ResultDesc;
  const transactionRef = db.collection('b2c_transactions').doc(conversationID);
  const transactionDoc = await transactionRef.get();

  if (!transactionDoc.exists) {
    return res.status(200).send('OK');
  }

  const transaction = transactionDoc.data();
  const withdrawalId = transaction.withdrawalId;
  const userId = transaction.userId;
  const amount = transaction.amount;

  const updateData = {
    resultCode,
    resultDesc,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (resultCode === 0) {
    // Successful B2C – deduct wallet balance
    updateData.status = 'completed';
    const walletRef = db.collection('wallets').doc(userId);
    await db.runTransaction(async (t) => {
      const walletDoc = await t.get(walletRef);
      const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
      const newBalance = currentBalance - amount;
      if (newBalance < 0) throw new Error('Insufficient balance');
      t.set(walletRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      conversationID,
    });
  } else {
    updateData.status = 'failed';
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'failed',
      failureReason: resultDesc,
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await transactionRef.update(updateData);
  res.status(200).send('OK');
});

// ========== B2C Timeout Callback ==========
app.post('/b2c/timeout', async (req, res) => {
  console.log('B2C timeout callback received:', JSON.stringify(req.body, null, 2));
  const { Result } = req.body;
  if (Result && Result.ConversationID) {
    const conversationID = Result.ConversationID;
    const transactionRef = db.collection('b2c_transactions').doc(conversationID);
    const transactionDoc = await transactionRef.get();
    if (transactionDoc.exists) {
      const transaction = transactionDoc.data();
      await db.collection('withdrawals').doc(transaction.withdrawalId).update({
        status: 'failed',
        failureReason: 'Request timed out',
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await transactionRef.update({ status: 'timed_out', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  }
  res.status(200).send('OK');
});

// ========== Legacy withdrawal endpoint (redirects to B2C) ==========
app.post('/api/withdraw', async (req, res) => {
  // Same as /api/b2c/withdraw
  return app._router.handle(req, res, '/api/b2c/withdraw');
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));