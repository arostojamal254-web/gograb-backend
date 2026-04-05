const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const router = express.Router();

// POST /api/payouts/mpesa
router.post('/mpesa', async (req, res) => {
  const { payoutId, userId, amount, phone, transactionId } = req.body;

  try {
    // Validate input
    if (!payoutId || !userId || !amount || !phone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get M‑Pesa credentials from environment
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const businessShortCode = process.env.BUSINESS_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const env = process.env.NODE_ENV || 'development';
    const baseUrl = env === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';

    // Obtain OAuth token
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const tokenRes = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const accessToken = tokenRes.data.access_token;

    // Prepare B2C request
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const password = Buffer.from(`${businessShortCode}${passkey}${timestamp}`).toString('base64');

    // Format phone number (remove leading '0' or '+')
    let formattedPhone = phone.replace(/[^0-9]/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
    if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;

    const requestBody = {
      InitiatorName: 'api',
      SecurityCredential: '', // you need to generate this using the initiator certificate
      CommandID: 'BusinessPayment',
      Amount: amount,
      PartyA: businessShortCode,
      PartyB: formattedPhone,
      Remarks: `Payout ${payoutId}`,
      QueueTimeOutURL: `${process.env.CALLBACK_BASE_URL}/api/mpesa/timeout`,
      ResultURL: `${process.env.CALLBACK_BASE_URL}/api/mpesa/result`,
      Occasion: 'Payout',
    };

    // For sandbox, you can use a dummy SecurityCredential (the one provided in docs) or generate from cert.
    // This is a placeholder – you need to replace with actual generated credential.
    requestBody.SecurityCredential = 'PLACEHOLDER_CREDENTIAL';

    const response = await axios.post(
      `${baseUrl}/mpesa/b2c/v1/paymentrequest`,
      requestBody,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Update Firestore payout document with transaction details
    await admin.firestore().collection('payouts').doc(payoutId).update({
      status: 'paid',
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      transactionId: response.data.ConversationID,
      mpesaResponse: response.data,
    });

    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error('M‑Pesa payout error:', err.response?.data || err.message);
    // Update payout as failed
    await admin.firestore().collection('payouts').doc(payoutId).update({
      status: 'failed',
      failureReason: err.response?.data?.errorMessage || err.message,
    });
    res.status(500).json({ error: 'Payout failed', details: err.response?.data || err.message });
  }
});

module.exports = router;