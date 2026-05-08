const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

// Initialize Firebase Admin SDK
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

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Existing M-Pesa callback (from your original code)
app.post('/mpesa/callback', async (req, res) => {
  console.log('M-Pesa callback received', req.body);
  // Your existing logic here (update order payment status, etc.)
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ========== STK Push endpoint (initiate M-Pesa payment) ==========
app.post('/api/mpesa/stkpush', async (req, res) => {
  const { amount, phone, accountRef, desc } = req.body;
  if (!amount || !phone) {
    return res.status(400).json({ error: 'Missing amount or phone' });
  }

  console.log(`STK Push request: ${amount} to ${phone} (${accountRef})`);

  // TODO: Implement actual Daraja API call here
  // For now, simulate a successful push
  // Later, replace with real Safaricom STK push using access token

  // Simulate success response
  res.json({
    success: true,
    message: 'STK push initiated (simulated)',
    receiptNumber: 'MPESA_SIM_' + Date.now(),
  });
});

// ========== Withdrawal endpoint ==========
app.post('/api/withdraw', async (req, res) => {
  const { userId, amount, userType, withdrawalId } = req.body;

  if (!userId || !amount || !userType || !withdrawalId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userData = userDoc.data();
    const phone = userData.phone;
    const tillNumber = userData.tillNumber;

    console.log(`Processing withdrawal for ${userType} ${userId}: KES ${amount}`);

    // Update withdrawal status
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'processed',
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      transactionId: `WTH_${Date.now()}`,
      message: 'Withdrawal processed (simulated)',
    });

    // Deduct from wallet balance
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

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});