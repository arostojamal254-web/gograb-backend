const admin = require('firebase-admin');
const cron = require('node-cron');
const db = admin.firestore();

// ========== REDIS SETUP (Graceful fallback) ==========
let redisClient = null;
let redisAvailable = false;

(async () => {
  try {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      console.warn('[redis] REDIS_URL not set – running without Redis');
      return;
    }
    const redis = require('redis');
    redisClient = redis.createClient({ url: redisUrl });
    redisClient.on('error', (err) => console.error('[redis] error:', err.message));
    await redisClient.connect();
    redisAvailable = true;
    console.log('[redis] connected');
  } catch (err) {
    console.warn('[redis] connection failed – running without Redis', err.message);
    redisAvailable = false;
  }
})();

async function redisGet(key) {
  if (!redisAvailable) return null;
  try { return await redisClient.get(key); } catch { return null; }
}

async function redisSet(key, value, ttlSeconds = 0) {
  if (!redisAvailable) return;
  try {
    if (ttlSeconds > 0) await redisClient.setEx(key, ttlSeconds, value);
    else await redisClient.set(key, value);
  } catch { }
}

async function redisHSet(key, field, value) {
  if (!redisAvailable) return;
  try { await redisClient.hSet(key, field, value); } catch { }
}

// ========== ASSIGNMENT LOGIC ==========
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getConfig() {
  // Try Redis first
  const cached = await redisGet('assignment:config');
  if (cached) return JSON.parse(cached);

  // Fallback to Firestore
  const doc = await db.collection('settings').doc('assignment').get();
  const config = doc.exists ? doc.data() : {
    maxDistanceKm: 10,
    distanceWeight: 0.5,
    ratingWeight: 0.3,
    loadWeight: 0.2,
  };
  // Cache for 60 seconds
  await redisSet('assignment:config', JSON.stringify(config), 60);
  return config;
}

async function scoreRider(rider, order, config) {
  const distance = getDistance(order.pickupLat, order.pickupLng, rider.lat, rider.lng);
  if (distance > config.maxDistanceKm) return -1;

  const distanceScore = 1 - (distance / config.maxDistanceKm);
  const ratingScore = rider.rating / 5;
  const loadScore = 1 - (rider.currentJobs / 5);
  return (distanceScore * (config.distanceWeight || 0.5) +
          ratingScore * (config.ratingWeight || 0.3) +
          loadScore * (config.loadWeight || 0.2));
}

async function assignRider(orderId, orderData) {
  const config = await getConfig();
  const county = orderData.county;
  if (!county) {
    console.log(`Order ${orderId}: no county`);
    return false;
  }

  const ridersSnapshot = await db.collection('users')
    .where('role', '==', 'rider')
    .where('status', '==', 'active')
    .where('county', '==', county)
    .get();

  if (ridersSnapshot.empty) return false;

  const riders = [];
  for (const doc of ridersSnapshot.docs) {
    const riderData = doc.data();
    const locDoc = await db.collection('users').doc(doc.id).collection('location').doc('current').get();
    const loc = locDoc.exists ? locDoc.data() : null;
    if (loc?.lat && loc?.lng) {
      const rider = {
        id: doc.id,
        name: riderData.name,
        rating: riderData.rating || 4.0,
        currentJobs: riderData.currentJobs || 0,
        lat: loc.lat,
        lng: loc.lng,
      };
      const score = await scoreRider(rider, orderData, config);
      if (score > 0) riders.push({ ...rider, score });
    }
  }

  if (riders.length === 0) return false;

  riders.sort((a, b) => b.score - a.score);
  const best = riders[0];

  await db.collection('orders').doc(orderId).update({
    riderId: best.id,
    riderName: best.name,
    status: 'riderAssigned',
  });
  await db.collection('users').doc(best.id).update({
    currentJobs: admin.firestore.FieldValue.increment(1),
  });
  console.log(`Order ${orderId} → ${best.name} (score ${best.score.toFixed(2)})`);
  return true;
}

async function processReadyOrders() {
  console.log('Running assignment worker...');
  const ordersSnapshot = await db.collection('orders')
    .where('status', '==', 'readyForPickup')
    .get();

  if (ordersSnapshot.empty) return;

  for (const doc of ordersSnapshot.docs) {
    const orderData = doc.data();
    if (!orderData.pickupLat || !orderData.pickupLng) {
      console.log(`Order ${doc.id}: missing pickup coordinates`);
      continue;
    }
    const success = await assignRider(doc.id, orderData);
    if (!success && redisAvailable) {
      await redisHSet('assignment:failed', doc.id, JSON.stringify({
        orderId: doc.id,
        timestamp: new Date().toISOString(),
        reason: 'No eligible rider',
      }));
    }
  }
}

cron.schedule('*/30 * * * * *', processReadyOrders);
console.log('Auto‑assignment worker started (runs every 30s)');