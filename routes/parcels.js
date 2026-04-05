const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();

const db = admin.firestore();

// GET /api/parcels/pending – list pending parcels
router.get('/pending', async (req, res) => {
  try {
    const snapshot = await db.collection('parcels')
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'desc')
      .get();
    const parcels = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ parcels });
  } catch (err) {
    console.error('Error fetching pending parcels:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/parcels/accept – assign rider to parcel
router.post('/accept', async (req, res) => {
  const { parcelId, riderId } = req.body;
  if (!parcelId || !riderId) {
    return res.status(400).json({ error: 'Missing parcelId or riderId' });
  }

  try {
    // Fetch rider's name
    const riderDoc = await db.collection('users').doc(riderId).get();
    if (!riderDoc.exists) {
      return res.status(404).json({ error: 'Rider not found' });
    }
    const riderName = riderDoc.data()?.name || 'Rider';

    // Update parcel
    await db.collection('parcels').doc(parcelId).update({
      status: 'accepted',
      riderId: riderId,
      riderName: riderName,
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error accepting parcel:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;