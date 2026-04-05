const express = require('express');
const { admin, db } = require('../../shared/firestore');
const router = express.Router();

// GET /api/pricing/counties – return all county pricing data
router.get('/counties', async (req, res) => {
  try {
    const snapshot = await db.collection('pricing_counties').get();
    const counties = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ ok: true, counties });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
