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
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || 'your_consumer_key';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || 'your_consumer_secret';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || 'your_passkey';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '4565717';           // Business shortcode
const MPESA_TILL_NUMBER = process.env.MPESA_TILL_NUMBER || '4565781';       // Till Number for Buy Goods
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL || 'https://gograb-backend-production.up.railway.app/mpesa/callback';
const MPESA_B2C_CALLBACK_URL = process.env.MPESA_B2C_CALLBACK_URL || 'https://gograb-backend-production.up.railway.app/mpesa/b2c/callback';

// Helper: Get OAuth token (same for both APIs)
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

// ========== M‑Pesa STK Push endpoint (Customer pays – Buy Goods) ==========
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

    // Store transaction
    await db.collection('mpesa_transactions').doc(response.data.CheckoutRequestID).set({
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
    res.status(500).json({ error: 'Failed to initiate STK push' });
  }
});

// ========== M‑Pesa STK Push Callback ==========
app.post('/mpesa/callback', async (req, res) => {
  console.log('M-Pesa callback received', JSON.stringify(req.body, null, 2));
  const { Body } = req.body;
  if (!Body || !Body.stkCallback) return res.json({ ResultCode: 1, ResultDesc: 'Invalid request' });

  const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = Body.stkCallback;
  const transactionRef = db.collection('mpesa_transactions').doc(CheckoutRequestID);
  const transactionDoc = await transactionRef.get();
  if (!transactionDoc.exists) return res.json({ ResultCode: 1, ResultDesc: 'Transaction not found' });

  const transaction = transactionDoc.data();
  const updateData = { resultCode: ResultCode, resultDesc: ResultDesc, updatedAt: admin.firestore.FieldValue.serverTimestamp() };

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
      await db.collection('orders').doc(orderId).update({ paymentStatus: 'paid', mpesaReceipt: receiptNumber, paidAt: admin.firestore.FieldValue.serverTimestamp() });
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

// ========== M‑Pesa B2C Withdrawal endpoint (Admin calls this) ==========
app.post('/api/withdraw', async (req, res) => {
  const { userId, amount, userType, withdrawalId } = req.body;
  if (!userId || !amount || !userType || !withdrawalId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Fetch user's phone number from Firestore
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();
    const phone = userData.phone; // Must be in format 254XXXXXXXXX
    if (!phone) return res.status(400).json({ error: 'User phone number not found' });

    // Get M-Pesa access token
    const accessToken = await getMpesaAccessToken();

    // Prepare B2C request payload
    const b2cData = {
      InitiatorName: process.env.MPESA_INITIATOR_NAME || 'GoGrabAPI',
      SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL, // Must be base64 encoded of initiator password
      CommandID: 'BusinessPayment', // Options: SalaryPayment, BusinessPayment, PromotionPayment
      Amount: amount,
      PartyA: MPESA_SHORTCODE,
      PartyB: phone,
      Remarks: `Withdrawal for ${userType}`,
      QueueTimeOutURL: MPESA_B2C_CALLBACK_URL,
      ResultURL: MPESA_B2C_CALLBACK_URL,
      Occasion: `Withdrawal_${withdrawalId}`,
    };

    // For production, you need to generate SecurityCredential using initiator password and public key.
    // This is a placeholder – you must implement it properly.
    // For simplicity, we'll skip actual B2C and just simulate success (but you can implement real call).
    // Uncomment the following lines to actually call Safaricom B2C API:
    /*
    const response = await axios.post(
      'https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
      b2cData,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (response.data.ResponseCode !== '0') throw new Error(response.data.ResponseDescription);
    */

    // Simulate success (remove this when real B2C is implemented)
    console.log(`B2C withdrawal to ${phone} for KES ${amount} (simulated)`);

    // Update withdrawal status in Firestore
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'processed',
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      transactionId: `B2C_${Date.now()}`,
    });

    // Deduct from wallet balance
    const walletRef = db.collection('wallets').doc(userId);
    await db.runTransaction(async (t) => {
      const walletDoc = await t.get(walletRef);
      const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
      const newBalance = currentBalance - amount;
      t.set(walletRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });

    res.json({ success: true, message: 'Withdrawal processed successfully' });
  } catch (error) {
    console.error('Withdrawal error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Withdrawal failed. Please try again.' });
  }
});

// ========== B2C Callback (optional – Safaricom sends result) ==========
app.post('/mpesa/b2c/callback', (req, res) => {
  console.log('B2C callback received', JSON.stringify(req.body, null, 2));
  // You can update withdrawal status based on result here
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));