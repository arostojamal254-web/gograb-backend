const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK once
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
let credential;
if (credentialsJson && credentialsJson !== '{}') {
  const serviceAccount = JSON.parse(credentialsJson);
  credential = admin.credential.cert(serviceAccount);
} else {
  credential = admin.credential.applicationDefault();
}
admin.initializeApp({ credential });

const db = admin.firestore();
const messaging = admin.messaging();

// Helper: send push to multiple tokens
async function sendPushToTokens(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return { successCount: 0, failureCount: 0 };
  const batches = [];
  for (let i = 0; i < tokens.length; i += 500) batches.push(tokens.slice(i, i + 500));
  let successCount = 0, failureCount = 0;
  for (const batch of batches) {
    const message = { notification: { title, body }, data, tokens: batch };
    const response = await messaging.sendEachForMulticast(message);
    successCount += response.successCount;
    failureCount += response.failureCount;
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) console.error(`Failed token ${batch[idx]}: ${resp.error?.message}`);
      });
    }
  }
  return { successCount, failureCount };
}

// ========== Exported Cloud Functions ==========

exports.createOrder = functions.https.onCall(async (data, context) => {
  const { items, userId, vendorId, total, deliveryFee, address, lat, lng, county, paymentMethod } = data;
  if (!items || !userId || !vendorId) throw new functions.https.HttpsError('invalid-argument', 'Missing fields');
  const orderRef = db.collection('orders').doc();
  const orderId = orderRef.id;
  const orderData = {
    id: orderId, userId, vendorId, items, total, deliveryFee, address, lat, lng, county,
    paymentMethod: paymentMethod || 'pending', paymentStatus: 'pending', status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await orderRef.set(orderData);
  await db.collection('orders_shared').doc(orderId).set(orderData);
  console.log(`Order created: ${orderId}`);
  return { orderId };
});

exports.applyLedgerForPaidOrder = functions.firestore.document('orders/{orderId}').onUpdate(async (change, context) => {
  const before = change.before.data();
  const after = change.after.data();
  if (before.paymentStatus === 'paid' || after.paymentStatus !== 'paid') return;
  const orderId = context.params.orderId;
  const vendorId = after.vendorId;
  const total = after.total;
  const platformFee = after.platformFee || Math.round(total * 0.05);
  const vendorEarnings = total - platformFee;
  await db.collection('ledger').add({
    orderId, vendorId, total, platformFee, vendorEarnings, type: 'order_paid',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await db.collection('wallets').doc(vendorId).set({
    pendingBalance: admin.firestore.FieldValue.increment(vendorEarnings),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  console.log(`Ledger applied for order ${orderId}, vendor earnings: ${vendorEarnings}`);
});

exports.applyMonetizationFromMpesaStkMap = functions.firestore.document('pending_mpesa/{docId}').onCreate(async (snap, context) => {
  const data = snap.data();
  const { orderId, userId, amount, serviceType } = data;
  if (!orderId || !userId) return;
  await db.collection('monetization_log').add({
    orderId, userId, amount, serviceType, source: 'mpesa_stk',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log(`Monetization log for order ${orderId}, amount ${amount}`);
});

exports.checkDailyPhotos = functions.pubsub.schedule('0 22 * * *').timeZone('Africa/Nairobi').onRun(async (context) => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const ridersSnapshot = await db.collection('users').where('role', '==', 'rider').get();
  for (const doc of ridersSnapshot.docs) {
    const riderId = doc.id;
    const photoQuery = await db.collection('daily_photos')
      .where('riderId', '==', riderId)
      .where('date', '==', yesterday)
      .limit(1)
      .get();
    if (photoQuery.empty) {
      console.warn(`Rider ${riderId} missed daily photo for ${yesterday.toISOString().split('T')[0]}`);
    }
  }
});

exports.cleanupPodsOnCancel = functions.firestore.document('rides/{rideId}').onUpdate(async (change, context) => {
  const before = change.before.data();
  const after = change.after.data();
  if (before.status === 'cancelled' || after.status !== 'cancelled') return;
  const rideId = context.params.rideId;
  const podsSnapshot = await db.collection('pods').where('rideId', '==', rideId).get();
  const batch = db.batch();
  podsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  console.log(`Cleaned up pods for cancelled ride ${rideId}`);
});

exports.cleanupPodsOnOrderDelete = functions.firestore.document('orders/{orderId}').onDelete(async (snap, context) => {
  const orderId = context.params.orderId;
  const podsSnapshot = await db.collection('pods').where('orderId', '==', orderId).get();
  const batch = db.batch();
  podsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  console.log(`Cleaned up pods for deleted order ${orderId}`);
});

exports.podGuard = functions.firestore.document('rides/{rideId}').onWrite(async (change, context) => {
  const data = change.after.data();
  if (!data) return;
  const rideId = context.params.rideId;
  const activeStatuses = ['accepted', 'started', 'rider_assigned'];
  if (activeStatuses.includes(data.status)) {
    const podRef = db.collection('pods').doc(rideId);
    const podSnap = await podRef.get();
    if (!podSnap.exists) {
      await podRef.set({
        rideId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active'
      });
    }
  }
});

exports.sendEtimesInvoice = functions.firestore.document('orders/{orderId}').onUpdate(async (change, context) => {
  const before = change.before.data();
  const after = change.after.data();
  if (before.paymentStatus === 'paid' || after.paymentStatus !== 'paid') return;
  const orderId = context.params.orderId;
  const userId = after.userId;
  const userDoc = await db.collection('users').doc(userId).get();
  const userEmail = userDoc.data()?.email;
  if (!userEmail) return;
  const subject = `Invoice for Order #${orderId.substring(0, 8)}`;
  const html = `<p>Thank you for your order. Total paid: KES ${after.total}</p>`;
  console.log(`Sending email to ${userEmail}: ${subject}`);
});

exports.sendNewJobNotification = functions.firestore.document('orders_shared/{orderId}').onCreate(async (snap, context) => {
  const order = snap.data();
  if (order.paymentStatus !== 'paid') return;
  if (!['readyForPickup', 'ready_for_pickup'].includes(order.status)) return;
  if (order.riderId) return;
  const ridersSnapshot = await db.collection('riders').where('isOnline', '==', true).get();
  const tokens = [];
  for (const doc of ridersSnapshot.docs) {
    const tokenDoc = await db.collection('fcm_tokens').doc(doc.id).get();
    if (tokenDoc.exists && tokenDoc.data().token) {
      tokens.push(tokenDoc.data().token);
    }
  }
  if (tokens.length === 0) return;
  const title = '🆕 New Delivery Order';
  const body = `Pickup from ${order.vendorName || 'Vendor'} • KES ${order.deliveryFee || 0}`;
  const payload = { type: 'delivery', orderId: context.params.orderId, jobType: 'delivery' };
  await sendPushToTokens(tokens, title, body, payload);
  console.log(`Legacy notification sent to ${tokens.length} riders for order ${context.params.orderId}`);
});