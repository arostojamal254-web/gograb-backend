const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();

const db = admin.firestore();

// GET /api/rides/pending – list pending rides
router.get('/pending', async (req, res) => {
  try {
    const snapshot = await db.collection('rides')
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'desc')
      .get();
    const rides = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ rides });
  } catch (err) {
    console.error('Error fetching pending rides:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rides/accept – assign rider to ride
router.post('/accept', async (req, res) => {
  const { rideId, riderId } = req.body;
  if (!rideId || !riderId) {
    return res.status(400).json({ error: 'Missing rideId or riderId' });
  }

  try {
    // Fetch rider's name from users collection
    const riderDoc = await db.collection('users').doc(riderId).get();
    if (!riderDoc.exists) {
      return res.status(404).json({ error: 'Rider not found' });
    }
    const riderName = riderDoc.data()?.name || 'Rider';

    // Update ride
    await db.collection('rides').doc(rideId).update({
      status: 'accepted',
      riderId: riderId,
      riderName: riderName,
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error accepting ride:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;