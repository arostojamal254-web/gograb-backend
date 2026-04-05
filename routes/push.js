const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();

// POST /api/send-push
router.post('/', async (req, res) => {
  const { title, message, targetRole, targetCounty } = req.body;

  try {
    // Build Firestore query for users to target
    let query = admin.firestore().collection('users');

    if (targetRole && targetRole !== 'all') {
      query = query.where('role', '==', targetRole);   // ✅ fixed
    }
    if (targetCounty) {
      query = query.where('county', '==', targetCounty); // ✅ fixed
    }

    const usersSnapshot = await query.get();
    if (usersSnapshot.empty) {
      return res.json({ success: true, message: 'No users found' });
    }

    // Collect FCM tokens from the users' fcmTokens subcollection
    const tokens = [];
    for (const doc of usersSnapshot.docs) {
      const tokensSnapshot = await doc.ref.collection('fcmTokens').get();
      tokensSnapshot.forEach((tokenDoc) => {
        const token = tokenDoc.data().token;
        if (token) tokens.push(token);
      });
    }

    if (tokens.length === 0) {
      return res.json({ success: true, message: 'No FCM tokens found' });
    }

    // Send notification via Firebase Admin
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body: message },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });

    console.log(`Push sent to ${response.successCount} devices, failures: ${response.failureCount}`);
    res.json({ success: true, successCount: response.successCount, failureCount: response.failureCount });
  } catch (err) {
    console.error('Push error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;