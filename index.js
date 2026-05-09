const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const axios = require('axios');
const crypto = require('crypto');

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

// ========== Live M‑Pesa Credentials ==========
const MPESA_CONSUMER_KEY = '6xYLGMHo62G8ryNAgraLDvcXEKEJKmG0Zb2b0R2NZj3q6uim';
const MPESA_CONSUMER_SECRET = 'l8gq8Z6LnmZ24eD8hsK8r7uwiarD5gVEnmEjmP03itmQQMZr2Iyz2B9YbTQnoqpe';
const MPESA_PASSKEY = '5c864834abc95f672da6591a6bb4a46bfbe41ccd18888cb84003db4a879915f6';
const MPESA_SHORTCODE = '4565717';           // Business Shortcode
const MPESA_TILL_NUMBER = '4565781';         // Till Number for Buy Goods
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL || 'https://gograb-backend-production.up.railway.app/mpesa/callback';

// B2C Credentials
const B2C_INITIATOR_NAME = 'arosto';
const B2C_INITIATOR_PASSWORD = '26148482.Gograb-ke';
const B2C_SECURITY_CREDENTIAL = (() => {
  // You should pre‑generate this using Safaricom's public certificate.
  // For now, we'll generate it at runtime (may be slow).
  // In production, compute once and store as env var.
  const publicCert = `-----BEGIN CERTIFICATE-----
MIICnjCCAgWgAwIBAgIBADANBgkqhkiG9w0BAQ0FADCBgzELMAkGA1UEBhMCS0Ux
EzARBgNVBAgTCk5haXJvYmktNDYxEjAQBgNVBAcTCU5haXJvYmktNDYxGjAYBgNV
BAoTEVNhZmFyaWNvbSBMSU1JVEVEMR0wGwYDVQQLExRNb2JpbGUgTW9uZXkgU2Vj
dXJpdHkxFDASBgNVBAMTC3NhZmFyaWNvbS5jMB4XDTE2MDYyMTEyMTUyNVoXDTI2
MDYxOTEyMTUyNVowgYMxCzAJBgNVBAYTAktFMRMwEQYDVQQIEwpOYWlyb2JpLTQ2
MRIwEAYDVQQHEwlOYWlyb2JpLTQ2MRowGAYDVQQKExFzYWZhcmljb20gTElNSVRF
RDEbMBkGA1UECxMSTW9iaWxlIE1vbmV5IFNlY3VyaXR5MRQwEgYDVQQDEwtzYWZh
cmljb20uYzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAw4M3jTlV5Hx5/0nv
e/6x3tNOnqGTcFZz0z2cF1cQlNpM0Vn3w3JvZ3tV3y7f2z8BcK2lRv1NqCz2sR8H
3b9M5t2TqF3w5yX9h0L7vKj8nP9uQ1v0Rc2TqF3w5yX9h0L7vKj8nP9uQ1vG0Rc2TqF
0C2sR8H3b9M5t2TqF3w5yX9h0L7vKj8nP9uQ1v0RcAgMBAAEwDQYJKoZIhvcNAQEN
BQADgYEAx7pQxY8Y3pJ8VjxJv7Zw2zX5d0cQ8v8X5nR2kF2m76aDxLqK0pKj5Z7t
+4LwH2nX3vP5zQ8cLgV2nL7vKj8nP9uQ1v0Rc2TqF3w5yX9h0L7vKj8nP9uQ1vG0Rc
2TqF0C2sR8H3b9M5t2TqF3w5yX9h0L7vKj8nP9uQ1v0Rc2TqF3w5yX9h0L7vKj8nP9uQ1v
0Rc2TqF3w5yX9h0L7vKj8nP9uQ1v0Rc=
-----END CERTIFICATE-----`;
  const encrypted = crypto.publicEncrypt(publicCert, Buffer.from(B2C_INITIATOR_PASSWORD));
  return encrypted.toString('base64');
})();

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

// ========== STK Push (Buy Goods – Customer Payments) ==========
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

// ========== M‑Pesa Callback (for STK Push) ==========
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

// ========== B2C Withdrawal (GoGrab pays vendors/riders/customers) ==========
async function b2cWithdrawal(amount, phoneNumber, remarks, transactionId, userId, userType) {
  const accessToken = await getMpesaAccessToken();
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  
  const data = {
    InitiatorName: B2C_INITIATOR_NAME,
    SecurityCredential: B2C_SECURITY_CREDENTIAL,
    CommandID: 'BusinessPayment',
    Amount: amount,
    PartyA: MPESA_SHORTCODE,
    PartyB: phoneNumber,
    Remarks: remarks,
    QueueTimeOutURL: `${MPESA_CALLBACK_URL.replace('/mpesa/callback', '')}/b2c/timeout`,
    ResultURL: `${MPESA_CALLBACK_URL.replace('/mpesa/callback', '')}/b2c/result`,
    Occasion: 'GoGrab Withdrawal',
  };

  const response = await axios.post(
    'https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
    data,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return response.data;
}

app.post('/api/b2c/withdraw', async (req, res) => {
  const { userId, amount, userType, withdrawalId } = req.body;
  if (!userId || !amount || !userType || !withdrawalId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const phone = userDoc.data().phone;
    if (!phone) return res.status(400).json({ error: 'User has no phone number' });

    const remarks = `${userType} withdrawal of KES ${amount}`;
    const b2cResponse = await b2cWithdrawal(amount, phone, remarks, withdrawalId, userId, userType);

    // Store withdrawal request in Firestore with B2C response
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'processing',
      b2cResponse: b2cResponse,
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      transactionId: b2cResponse.ConversationID,
    });

    res.json({ success: true, message: 'Withdrawal initiated', conversationID: b2cResponse.ConversationID });
  } catch (error) {
    console.error('B2C withdrawal error:', error.response?.data || error.message);
    // Refund wallet if B2C fails
    const walletRef = db.collection('wallets').doc(userId);
    await db.runTransaction(async (t) => {
      const walletDoc = await t.get(walletRef);
      const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
      t.set(walletRef, { balance: currentBalance + amount, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'failed',
      error: error.message,
    });
    res.status(500).json({ error: 'Withdrawal failed, wallet refunded' });
  }
});

// Legacy withdrawal endpoint – redirect to B2C
app.post('/api/withdraw', async (req, res) => {
  // Forward to B2C endpoint
  const { userId, amount, userType, withdrawalId } = req.body;
  req.url = '/api/b2c/withdraw';
  return app._router.handle(req, res);
});

// B2C Result URL (Safaricom sends final status)
app.post('/b2c/result', async (req, res) => {
  console.log('B2C result received', JSON.stringify(req.body, null, 2));
  const { Result, ResultParameters, ReferenceData } = req.body;
  if (!Result || !Result.ResultCode) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'OK' });
  }

  const conversationID = ReferenceData.ConversationID;
  const withdrawalQuery = await db.collection('withdrawals').where('transactionId', '==', conversationID).get();
  if (withdrawalQuery.empty) return res.status(200).json({ ResultCode: 0, ResultDesc: 'OK' });

  const withdrawalDoc = withdrawalQuery.docs[0];
  const withdrawalId = withdrawalDoc.id;
  const userId = withdrawalDoc.data().userId;
  const amount = withdrawalDoc.data().amount;

  if (Result.ResultCode === 0) {
    // Success
    await withdrawalDoc.ref.update({
      status: 'completed',
      resultCode: Result.ResultCode,
      resultDesc: Result.ResultDesc,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    // Failed – refund wallet
    await withdrawalDoc.ref.update({
      status: 'failed',
      resultCode: Result.ResultCode,
      resultDesc: Result.ResultDesc,
    });
    const walletRef = db.collection('wallets').doc(userId);
    await db.runTransaction(async (t) => {
      const walletDoc = await t.get(walletRef);
      const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
      t.set(walletRef, { balance: currentBalance + amount, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
  }
  res.status(200).json({ ResultCode: 0, ResultDesc: 'OK' });
});

// B2C Timeout URL
app.post('/b2c/timeout', async (req, res) => {
  console.log('B2C timeout received', JSON.stringify(req.body, null, 2));
  // Similar to failure – refund wallet
  const { ReferenceData } = req.body;
  if (ReferenceData && ReferenceData.ConversationID) {
    const withdrawalQuery = await db.collection('withdrawals').where('transactionId', '==', ReferenceData.ConversationID).get();
    if (!withdrawalQuery.empty) {
      const withdrawalDoc = withdrawalQuery.docs[0];
      const userId = withdrawalDoc.data().userId;
      const amount = withdrawalDoc.data().amount;
      await withdrawalDoc.ref.update({ status: 'timeout' });
      const walletRef = db.collection('wallets').doc(userId);
      await db.runTransaction(async (t) => {
        const walletDoc = await t.get(walletRef);
        const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
        t.set(walletRef, { balance: currentBalance + amount, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      });
    }
  }
  res.status(200).json({ ResultCode: 0, ResultDesc: 'OK' });
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));