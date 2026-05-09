app.post('/api/mpesa/stkpush', async (req, res) => {
  // Enable CORS for web
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

  const { amount, phone, accountRef, desc } = req.body;
  if (!amount || !phone) {
    return res.status(400).json({ error: 'Missing amount or phone' });
  }

  // Use your Till Number as the shortcode
  const shortcode = process.env.MPESA_SHORTCODE; // e.g., "4565717"
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL || 'https://gograb-backend-production.up.railway.app/mpesa/callback';

  try {
    // 1. Get OAuth token
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    const tokenRes = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: `Basic ${auth}` },
    });
    const accessToken = tokenRes.data.access_token;

    // 2. Generate timestamp and password
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    // 3. Build STK push payload for Buy Goods (Till Number)
    const payload = {
      BusinessShortCode: shortcode,        // Till number
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline', // ✅ Required for Till
      Amount: amount,
      PartyA: phone,                        // Customer's phone number
      PartyB: shortcode,                   // Same as BusinessShortCode for Buy Goods
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: accountRef || 'GoGrabWalletTopUp',
      TransactionDesc: desc || 'Wallet top-up',
    };

    const stkPushRes = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Store transaction in Firestore
    const transactionRef = db.collection('mpesa_transactions').doc(stkPushRes.data.CheckoutRequestID);
    await transactionRef.set({
      checkoutRequestID: stkPushRes.data.CheckoutRequestID,
      amount,
      phone,
      accountRef,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      message: 'STK push sent',
      checkoutRequestID: stkPushRes.data.CheckoutRequestID,
    });
  } catch (error) {
    console.error('STK push error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to initiate STK push. Please try again.' });
  }
});