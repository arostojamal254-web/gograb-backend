
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const db = admin.firestore();

// Existing dispatch endpoint (if any)
router.post('/dispatch/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { pickupLat, pickupLng } = req.body;
    // your dispatch logic
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// GET /api/orders/ready
router.get('/ready', async (req, res) => {
  try {
    const snapshot = await db.collection('orders')
      .where('status', '==', 'readyForPickup')
      .get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ orders });
  } catch (err) {
    console.error('Error fetching ready orders:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/my?riderId=xxx
router.get('/my', async (req, res) => {
  const { riderId } = req.query;
  if (!riderId) return res.status(400).json({ error: 'riderId required' });
  try {
    const snapshot = await db.collection('orders')
      .where('riderId', '==', riderId)
      .where('status', 'in', ['accepted', 'preparing', 'readyForPickup', 'riderAssigned', 'pickedUp', 'delivering'])
      .get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ orders });
  } catch (err) {
    console.error('Error fetching active jobs:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/completed?riderId=xxx
router.get('/completed', async (req, res) => {
  const { riderId } = req.query;
  if (!riderId) return res.status(400).json({ error: 'riderId required' });
  try {
    const snapshot = await db.collection('orders')
      .where('riderId', '==', riderId)
      .where('status', '==', 'delivered')
      .orderBy('deliveredAt', 'desc')
      .get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ orders });
  } catch (err) {
    console.error('Error fetching completed jobs:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/claim
router.post('/claim', async (req, res) => {
  const { orderId, riderId } = req.body;
  if (!orderId || !riderId) return res.status(400).json({ error: 'orderId and riderId required' });
  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Order not found' });
    const orderData = orderDoc.data();
    if (orderData.status !== 'readyForPickup') {
      return res.status(409).json({ error: 'Order no longer available' });
    }
    const riderDoc = await db.collection('users').doc(riderId).get();
    const riderName = riderDoc.exists ? riderDoc.data().name : 'Rider';
    await orderRef.update({
      status: 'riderAssigned',
      riderId: riderId,
      riderName: riderName,
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true, orderId, riderId });
  } catch (err) {
    console.error('Error claiming order:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;