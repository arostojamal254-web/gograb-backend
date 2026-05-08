const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

// Initialize Firebase Admin SDK
let firebaseApp;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  } catch (e) {
    console.error('Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON', e.message);
  }
} else {
  // Use default credentials (works on Railway if environment set)
  firebaseApp = admin.initializeApp({
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

// Existing M-Pesa callback endpoint (keep your logic)
app.post('/mpesa/callback', async (req, res) => {
  console.log('M-Pesa callback received', req.body);
  // Your existing callback logic here (e.g., update order payment status)
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ========== Withdrawal endpoint (used by admin app) ==========
app.post('/api/withdraw', async (req, res) => {
  const { userId, amount, userType, withdrawalId } = req.body;

  if (!userId || !amount || !userType || !withdrawalId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Fetch user's payment details (phone, till number, etc.)
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userData = userDoc.data();
    const phone = userData.phone;
    const tillNumber = userData.tillNumber;

    console.log(`Processing withdrawal for ${userType} ${userId}: KES ${amount}`);

    // TODO: Implement actual M-Pesa B2C using Daraja API
    // For now, simulate success and update Firestore

    // Update withdrawal status
    await db.collection('withdrawals').doc(withdrawalId).update({
      status: 'processed',
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      transactionId: `WTH_${Date.now()}`,
      message: 'Withdrawal processed (simulated)',
    });

    // Deduct from wallet balance (if you store wallet balance)
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