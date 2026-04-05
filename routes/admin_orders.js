const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();

const db = admin.firestore();

// GET /api/orders/admin?county=...
router.get('/', async (req, res) => {
  try {
    const county = req.query.county; // optional
    let query = db.collection('orders').orderBy('createdAt', 'desc');
    
    if (county) {
      query = query.where('county', '==', county);
    }
    
    const snapshot = await query.get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ orders });
  } catch (err) {
    console.error('Error fetching admin orders:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;