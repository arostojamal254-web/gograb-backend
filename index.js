require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// ========== ALL YOUR EXISTING ROUTES ==========
const deliveriesRoutes = require("./src/modules/deliveries/delivery.routes");
const driversRoutes = require("./src/modules/drivers/driver.routes");
const batchingRoutes = require("./src/modules/batching/batching.routes");
const routesRoutes = require("./src/modules/routes/routes.routes");
const dispatchRoutes = require("./src/modules/dispatch/dispatch.routes");
const dispatchWaveRoutes = require("./src/modules/dispatch/dispatch.wave.routes");
const orderRoutes = require("./routes/order.routes");
const geoDispatchRoutes = require("./routes/geoDispatch.routes");
const realtimeRoutes = require("./src/modules/routes/realtime.routes");
const systemRoutes = require("./src/modules/system/county.routes");
const pricingRoutes = require("./src/modules/pricing/pricing.routes");
const assignmentsRouter = require('./routes/assignments');
const geocodeRouter = require('./routes/geocode');
const pushRouter = require('./routes/push');
const payoutsRouter = require('./routes/payouts');
const ridesRouter = require('./routes/rides');
const parcelsRouter = require('./routes/parcels');

const app = express();

// ========== HEALTH & ROOT – MUST BE FIRST ==========
app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/", (_, res) => res.json({ ok: true }));

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

// ========== MOUNT EXISTING ROUTES ==========
app.use("/api/orders", orderRoutes);
app.use("/api/dispatch", dispatchRoutes);
app.use("/api/dispatch", geoDispatchRoutes);
app.use("/api/dispatch", dispatchWaveRoutes);
app.use("/api/deliveries", deliveriesRoutes);
app.use("/api/batching", batchingRoutes);
app.use("/api/routes", routesRoutes);
app.use("/api/drivers", driversRoutes);
app.use("/api", realtimeRoutes);
app.use("/api/system", systemRoutes);
app.use("/api/pricing", pricingRoutes);
app.use('/api/assignments', assignmentsRouter);
app.use('/api/geocode', geocodeRouter);
app.use('/api/send-push', pushRouter);
app.use('/api/payouts', payoutsRouter);
app.use('/api/rides', ridesRouter);
app.use('/api/parcels', parcelsRouter);

// ========== M‑PESA ENDPOINTS ==========
app.post('/mpesa/stkpush', async (req, res) => {
  const { orderId, phone, amount } = req.body;
  if (!orderId || !phone || !amount) {
    return res.status(400).json({ error: 'Missing orderId, phone, or amount' });
  }

  let formattedPhone = phone.replace(/\D/g, '');
  if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
  if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;

  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  if (!shortcode || !passkey || !callbackUrl || !consumerKey || !consumerSecret) {
    console.error('Missing M-Pesa environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const tokenUrl = 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    const tokenRes = await fetch(tokenUrl, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const tokenText = await tokenRes.text();
    if (!tokenRes.ok) {
      console.error('OAuth error:', tokenRes.status, tokenText);
      return res.status(500).json({ success: false, error: `OAuth HTTP ${tokenRes.status}` });
    }
    const { access_token } = JSON.parse(tokenText);
    if (!access_token) throw new Error('No access_token');

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
    const stkRes = await fetch('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: formattedPhone,
        PartyB: shortcode,
        PhoneNumber: formattedPhone,
        CallBackURL: callbackUrl,
        AccountReference: orderId,
        TransactionDesc: 'GoGrab Order Payment',
      }),
    });
    const data = await stkRes.json();
    if (stkRes.ok) {
      await db.collection('mpesa_transactions').doc(orderId).set({
        checkoutRequestID: data.CheckoutRequestID,
        phoneNumber: formattedPhone,
        amount: amount,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.json({ success: true, checkoutRequestID: data.CheckoutRequestID });
    } else {
      console.error('STK Push error:', data);
      res.status(400).json({ success: false, error: data });
    }
  } catch (error) {
    console.error('M-Pesa error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/mpesa/callback', async (req, res) => {
  console.log('M-Pesa callback received:', JSON.stringify(req.body));
  const { Body } = req.body;
  if (Body && Body.stkCallback) {
    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = Body.stkCallback;
    const querySnapshot = await db.collection('mpesa_transactions')
      .where('checkoutRequestID', '==', CheckoutRequestID)
      .limit(1)
      .get();
    if (!querySnapshot.empty) {
      const doc = querySnapshot.docs[0];
      const orderId = doc.id;
      const status = ResultCode === 0 ? 'completed' : 'failed';
      await db.collection('mpesa_transactions').doc(orderId).update({
        status: status,
        resultCode: ResultCode,
        resultDesc: ResultDesc,
        callbackMetadata: CallbackMetadata,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (ResultCode === 0) {
        await db.collection('orders_shared').doc(orderId).update({ paymentStatus: 'paid', status: 'readyForPickup' });
        await db.collection('orders').doc(orderId).update({ paymentStatus: 'paid', status: 'readyForPickup' });
      }
    } else {
      console.log('No transaction found for CheckoutRequestID:', CheckoutRequestID);
    }
  }
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ========== RIDER WALLET CREDIT ON DELIVERY (with rider share %) ==========
const creditRiderOnDelivery = async (change, orderId) => {
  const newStatus = change.after.get('status');
  const oldStatus = change.before.get('status');
  if (newStatus === oldStatus) return;
  if (newStatus !== 'delivered') return;

  const orderData = change.after.data();
  const riderId = orderData.riderId;
  const deliveryFee = orderData.deliveryFee || 0;
  if (!riderId || deliveryFee <= 0) return;

  // Fetch rider share percentage from settings
  let riderSharePercent = 80; // default
  try {
    const settingsDoc = await db.collection('settings').doc('assignment').get();
    if (settingsDoc.exists) {
      riderSharePercent = settingsDoc.data().riderSharePercent || 80;
    }
  } catch (err) {
    console.error('Error fetching rider share percent:', err);
  }

  const riderShare = (deliveryFee * riderSharePercent) / 100;
  if (riderShare <= 0) return;

  const walletRef = db.collection('wallets').doc(riderId);
  const transactionRef = walletRef.collection('transactions').doc();

  await db.runTransaction(async (t) => {
    const walletDoc = await t.get(walletRef);
    const currentBalance = walletDoc.exists ? walletDoc.data().balance || 0 : 0;
    const newBalance = currentBalance + riderShare;

    if (!walletDoc.exists) {
      t.set(walletRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } else {
      t.update(walletRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    t.set(transactionRef, {
      amount: riderShare,
      type: 'credit',
      description: `Earnings from order ${orderId} (${riderSharePercent}% of delivery fee)`,
      orderId: orderId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  console.log(`✅ Credited ${riderShare} to rider ${riderId} for order ${orderId} (${riderSharePercent}% of delivery fee)`);
};

// Listen to real‑time changes on orders_shared collection
db.collection('orders_shared').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach((change) => {
    if (change.type === 'modified') {
      creditRiderOnDelivery(change, change.doc.id);
    }
  });
});

// ========== START THE SERVER ==========
const PORT = Number(process.env.PORT || 8080);
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log("[redis] connected");
});

// ========== SOCKET.IO ==========
const io = require('socket.io')(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});
io.on('connection', (socket) => {
  console.log('[socket] client connected');
  socket.on('disconnect', () => console.log('[socket] client disconnected'));
});
app.set('io', io);

// ========== AUTO‑ASSIGNMENT WORKER ==========
require('./workers/assignmentWorker');