const express = require("express");
const { admin, db } = require("../../shared/firestore");
const router = express.Router();

// ========== SPECIFIC ROUTES (must come before wildcard) ==========

// POST /api/orders/create
router.post("/create", async (req, res) => {
  try {
    const b = req.body || {};
    const orderId = b.orderId != null ? String(b.orderId) : "";
    const userId  = b.userId  != null ? String(b.userId)  : "";
    const vendorId = b.vendorId != null ? String(b.vendorId) : "";
    const vendorName = b.vendorName != null ? String(b.vendorName) : "";
    const customerName = b.customerName != null ? String(b.customerName) : "";
    const customerPhone = b.customerPhone != null ? String(b.customerPhone) : "";
    const deliveryAddress = b.deliveryAddress != null ? String(b.deliveryAddress) : "";
    const county = b.county != null ? String(b.county) : "";
    const total = b.total != null ? Number(b.total) : 0;
    const pickupLat = Number(b.pickupLat);
    const pickupLng = Number(b.pickupLng);
    if (!orderId) return res.status(400).json({ ok: false, error: "orderId required" });
    if (!userId)  return res.status(400).json({ ok: false, error: "userId required" });
    if (!vendorId) return res.status(400).json({ ok: false, error: "vendorId required" });
    if (Number.isNaN(pickupLat) || Number.isNaN(pickupLng))
      return res.status(400).json({ ok: false, error: "pickupLat and pickupLng must be numbers" });
    const doc = { 
      orderId, 
      userId, 
      vendorId,
      vendorName,
      customerName,
      customerPhone,
      deliveryAddress,
      county,
      total,
      pickupLat, 
      pickupLng, 
      status: "created", 
      createdAt: Date.now() 
    };
    await db.collection("orders").doc(orderId).set(doc, { merge: true });
        // Emit real-time event
    const io = req.app.get('io');
    io.emit('order_created', { orderId, ...doc });
    res.json({ ok: true, orderId, pickupLng, pickupLat });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/orders/ready
router.get('/ready', async (req, res) => {
  try {
    const snapshot = await db
      .collection('orders_shared')
      .where('status', '==', 'readyForPickup')
      .where('assignedRiderId', '==', null)
      .orderBy('updatedAt', 'desc')
      .get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/orders/my?riderId=xxx
router.get('/my', async (req, res) => {
  try {
    const { riderId } = req.query;
    if (!riderId) return res.status(400).json({ ok: false, error: 'riderId required' });
    const snapshot = await db
      .collection('orders_shared')
      .where('assignedRiderId', '==', riderId)
      .orderBy('updatedAt', 'desc')
      .get();
    const orders = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(order => order.status !== 'delivered');
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/orders/completed?riderId=xxx
router.get('/completed', async (req, res) => {
  try {
    const { riderId } = req.query;
    if (!riderId) return res.status(400).json({ ok: false, error: 'riderId required' });
    const snapshot = await db
      .collection('orders_shared')
      .where('assignedRiderId', '==', riderId)
      .where('status', '==', 'delivered')
      .orderBy('updatedAt', 'desc')
      .get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/orders/vendor?vendorId=xxx
router.get('/vendor', async (req, res) => {
  try {
    const { vendorId } = req.query;
    if (!vendorId) return res.status(400).json({ ok: false, error: 'vendorId required' });
    const snapshot = await db
      .collection('orders')
      .where('vendorId', '==', vendorId)
      .orderBy('createdAt', 'desc')
      .get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/orders/vendor/:orderId
router.get('/vendor/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
    const doc = await db.collection('orders').doc(orderId).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Order not found' });
    res.json({ ok: true, order: { id: doc.id, ...doc.data() } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/orders/vendor/status
router.post('/vendor/status', async (req, res) => {
  console.log('[vendor/status] received:', req.body);
  const { orderId, vendorId, newStatus } = req.body;
  if (!orderId || !vendorId || !newStatus) {
    return res.status(400).json({ ok: false, error: 'orderId, vendorId, newStatus required' });
  }

  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      console.log('[vendor/status] Order not found in orders');
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }
    const order = orderDoc.data();
    if (order.vendorId !== vendorId) {
      console.log('[vendor/status] Vendor mismatch:', order.vendorId, '!=', vendorId);
      return res.status(403).json({ ok: false, error: 'Not your order' });
    }

    const allowed = { created: 'accepted', pending: 'accepted', accepted: 'preparing', preparing: 'readyForPickup' };
    const current = order.status || '';
    if (allowed[current] !== newStatus) {
      console.log('[vendor/status] Invalid transition:', current, '->', newStatus);
      return res.status(400).json({ ok: false, error: `Invalid transition from "${current}" to "${newStatus}"` });
    }

    const updateData = {
      status: newStatus,
      orderStatus: newStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (newStatus === 'readyForPickup') {
      updateData.readyForPickupAt = admin.firestore.FieldValue.serverTimestamp();
    }
    await orderRef.update(updateData);

    // Also update orders_shared if the order becomes readyForPickup
    if (newStatus === 'readyForPickup') {
      const sharedRef = db.collection('orders_shared').doc(orderId);
      await sharedRef.set({
        status: 'readyForPickup',
        orderStatus: 'readyForPickup',
        assignedRiderId: null,
        vendorId: order.vendorId,
        vendorName: order.vendorName,
        customerName: order.customerName,
        deliveryAddress: order.deliveryAddress,
        total: order.total,
        createdAt: order.createdAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        readyForPickupAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    console.log('[vendor/status] Success for', orderId, '->', newStatus);
    res.json({ ok: true });
        // Emit real-time update
    const io = req.app.get('io');
    const updatedOrder = (await orderRef.get()).data();
    io.emit('order_updated', { id: orderId, ...updatedOrder });
  } catch (e) {
    console.error('[vendor/status] Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/orders/user/:userId
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
    const snapshot = await db
      .collection('orders')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/orders/admin
router.get('/admin', async (req, res) => {
  try {
    const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== WILDCARD ROUTES ==========

// GET /api/orders/:orderId

// POST /api/orders/claim
router.post('/claim', async (req, res) => {
  console.log('[claim] received:', req.body);
  const { orderId, riderId } = req.body;
  if (!orderId || !riderId) {
    console.log('[claim] missing fields');
    return res.status(400).json({ ok: false, error: 'orderId and riderId required' });
  }
  const orderRef = db.collection('orders').doc(orderId);
  const sharedRef = db.collection('orders_shared').doc(orderId);
  try {
    await db.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      const sharedSnap = await tx.get(sharedRef);
      console.log('[claim] order exists:', orderSnap.exists);
      console.log('[claim] shared exists:', sharedSnap.exists);
      if (!orderSnap.exists || !sharedSnap.exists) throw new Error('Order not found');
      const shared = sharedSnap.data();
      console.log('[claim] shared status:', shared.status);
      console.log('[claim] shared assignedRiderId:', shared.assignedRiderId);
      if (shared.status !== 'readyForPickup') {
        throw new Error(`Order status is ${shared.status}, not readyForPickup`);
      }
      if (shared.assignedRiderId != null) {
        throw new Error(`Order already assigned to ${shared.assignedRiderId}`);
      }
      const updateData = {
        assignedRiderId: riderId,
        status: 'assigned',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.update(orderRef, updateData);
      tx.update(sharedRef, updateData);
    });
    console.log('[claim] success for', orderId);
    res.json({ ok: true });
        // Emit real-time update
    const io = req.app.get('io');
    const updatedOrder = (await orderRef.get()).data();
    io.emit('order_updated', { id: orderId, ...updatedOrder });
  } catch (e) {
    console.error('[claim] error:', e.message);
    res.status(409).json({ ok: false, error: e.message });
  }
});

// GET /api/orders/shared/:orderId – fetch a single shared order
router.get('/shared/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
    const doc = await db.collection('orders_shared').doc(orderId).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Order not found' });
    res.json({ ok: true, order: { id: doc.id, ...doc.data() } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
router.get("/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const ref = db.collection("orders").doc(String(orderId));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "order not found" });
    res.json({ ok: true, order: snap.data() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/orders/:orderId
router.patch("/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const patch = req.body || {};
    patch.updatedAt = Date.now();
    const ref = db.collection("orders").doc(String(orderId));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "order not found" });
    await ref.set(patch, { merge: true });
    res.json({ ok: true });
        // Emit real-time update
    const io = req.app.get('io');
    const updatedOrder = (await orderRef.get()).data();
    io.emit('order_updated', { id: orderId, ...updatedOrder });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;






