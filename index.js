const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

// ========== Firebase Admin SDK ==========
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  } catch (e) {
    console.error('Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON', e.message);
  }
} else {
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || 'gograb-ke',
  });
}
const db = admin.firestore();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

// ========== Health check ==========
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== Live M‑Pesa STK Push ==========
app.post('/api/mpesa/stkpush', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

  const { amount, phone, accountRef, desc } = req.body;
  if (!amount || !phone) {
    return res.status(400).json({ error: 'Missing amount or phone' });
  }

  // Format phone to 254XXXXXXXXX
  let cleanedPhone = phone.replace(/\D/g, '');
  if (cleanedPhone.startsWith('0')) cleanedPhone = '254' + cleanedPhone.substring(1);
  if (!cleanedPhone.startsWith('254')) cleanedPhone = '254' + cleanedPhone;
  if (cleanedPhone.length < 12) {
    return res.status(400).json({ error: 'Invalid phone number format. Use 254XXXXXXXXX' });
  }

  const missingVars = [];
  if (!process.env.MPESA_CONSUMER_KEY) missingVars.push('MPESA_CONSUMER_KEY');
  if (!process.env.MPESA_CONSUMER_SECRET) missingVars.push('MPESA_CONSUMER_SECRET');
  if (!process.env.MPESA_PASSKEY) missingVars.push('MPESA_PASSKEY');
  if (!process.env.MPESA_SHORTCODE) missingVars.push('MPESA_SHORTCODE');

  if (missingVars.length > 0) {
    console.error('Missing M-Pesa environment variables:', missingVars);
    return res.status(500).json({ error: 'Payment gateway not configured. Missing credentials.' });
  }

  try {
    // 1. Get OAuth token (LIVE)
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    const tokenRes = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 10000,
    });
    const accessToken = tokenRes.data.access_token;
    console.log('✅ Access token obtained');

    // 2. Generate timestamp and password
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp).toString('base64');

    // 3. Build payload
    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: cleanedPhone,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: cleanedPhone,
      CallBackURL: process.env.MPESA_CALLBACK_URL || 'https://gograb-backend-production.up.railway.app/mpesa/callback',
      AccountReference: accountRef || 'GoGrab',
      TransactionDesc: desc || 'Payment',
    };

    // 4. Send STK push (LIVE)
    const stkRes = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }
    );

    console.log('✅ Safaricom STK push response:', JSON.stringify(stkRes.data, null, 2));

    // Store transaction
    await db.collection('mpesa_transactions').doc(stkRes.data.CheckoutRequestID).set({
      checkoutRequestID: stkRes.data.CheckoutRequestID,
      amount,
      phone: cleanedPhone,
      accountRef,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      message: 'STK push sent',
      checkoutRequestID: stkRes.data.CheckoutRequestID,
    });
  } catch (error) {
    console.error('❌ STK push error:', error.response?.data || error.message);
    if (error.response?.data?.errorCode) {
      return res.status(500).json({ error: `Safaricom error: ${error.response.data.errorCode} - ${error.response.data.errorMessage}` });
    }
    res.status(500).json({ error: 'Failed to initiate STK push. Please try again.' });
  }
});

// ========== Callback (same as before) ==========
app.post('/mpesa/callback', async (req, res) => {
  console.log('📞 M-Pesa callback received', JSON.stringify(req.body, null, 2));
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
    if (accountRef === 'WalletTopUp') {
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

// ========== Withdrawal endpoint ==========
app.post('/api/withdraw', async (req, res) => {
  const { userId, amount, userType, withdrawalId } = req.body;
  if (!userId || !amount || !userType || !withdrawalId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();

    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'processed',
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      transactionId: `WTH_${Date.now()}`,
    });

    const walletRef = db.collection('wallets').doc(userId);
    await db.runTransaction(async (t) => {
      const walletDoc = await t.get(walletRef);
      const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
      const newBalance = currentBalance - amount;
      t.set(walletRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });

    res.json({ success: true, message: 'Withdrawal processed' });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));