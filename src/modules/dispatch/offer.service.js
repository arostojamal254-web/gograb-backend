const redis = require("../../shared/redis");
const { admin, db } = require("../../shared/firestore");

const {
  tripLockKey,
  driverLockKey,
  tripOfferDriversKey,
  tripOfferTtlKey,
  driverInboxKey,
} = require("../../shared/redis.keys");

const COL_ORDERS = "orders_shared";
const COL_DRIVERS = "drivers";

/**
 * Create offers for a trip to multiple drivers with TTL.
 * - writes offer drivers set
 * - pushes tripId to each driver's inbox
 * - sets trip offer ttl key
 */
async function createOffers({ orderId, driverIds, ttlSec = 12 }) {
  const tripId = String(orderId);
  const ids = (driverIds || []).map(String).filter(Boolean);

  if (!tripId) return { ok: false, status: 400, error: "orderId required" };
  if (!ids.length) return { ok: false, status: 400, error: "driverIds required" };

  // store candidates
  await redis.call("DEL", tripOfferDriversKey(tripId));
  await redis.call("SADD", tripOfferDriversKey(tripId), ...ids);

  // each driver gets inbox item
  for (const d of ids) {
    await redis.call("LPUSH", driverInboxKey(d), tripId);
    await redis.call("LTRIM", driverInboxKey(d), "0", "50"); // keep last 50
  }

  // TTL marker
  await redis.call("SET", tripOfferTtlKey(tripId), "1", "EX", String(ttlSec));

  return { ok: true, status: 200, orderId: tripId, offeredTo: ids, ttlSec };
}

/**
 * Driver accept with "first accept wins" via atomic Redis lock.
 * Steps:
 * 1) SETNX trip lock -> winner
 * 2) SETNX driver lock -> prevent driver double win
 * 3) Firestore transaction: set order assigned+accepted, lock driver currentOrderId
 * 4) Cleanup offers + notify others (later via WS)
 */
async function acceptOffer({ orderId, driverId }) {
  const tripId = String(orderId);
  const dId = String(driverId);

  if (!tripId || !dId) return { ok: false, status: 400, error: "orderId and driverId required" };

  // Ensure driver was offered this trip
  const isMember = await redis.call("SISMEMBER", tripOfferDriversKey(tripId), dId);
  if (String(isMember) !== "1") {
    return { ok: false, status: 409, error: "Driver was not offered this trip" };
  }

  // 1) trip lock (first accept wins)
  const tripLocked = await redis.call("SET", tripLockKey(tripId), dId, "NX", "EX", "15");
  if (!tripLocked) {
    const winner = await redis.call("GET", tripLockKey(tripId));
    return { ok: false, status: 409, error: "Trip already accepted", winner: winner || null };
  }

  // 2) driver lock (driver can only win one trip)
  const driverLocked = await redis.call("SET", driverLockKey(dId), tripId, "NX", "EX", "30");
  if (!driverLocked) {
    // release trip lock if driver is already locked elsewhere
    await redis.call("DEL", tripLockKey(tripId));
    const lockedTrip = await redis.call("GET", driverLockKey(dId));
    return { ok: false, status: 409, error: "Driver already locked", lockedTrip: lockedTrip || null };
  }

  // 3) Firestore transaction
  const orderRef = db.collection(COL_ORDERS).doc(tripId);
  const driverRef = db.collection(COL_DRIVERS).doc(dId);

  const txResult = await db.runTransaction(async (tx) => {
    const [oSnap, dSnap] = await Promise.all([tx.get(orderRef), tx.get(driverRef)]);

    if (!oSnap.exists) return { ok: false, status: 404, error: "Order not found" };
    if (!dSnap.exists) return { ok: false, status: 404, error: "Driver not found" };

    const order = oSnap.data() || {};
    const driver = dSnap.data() || {};

    const ds = String(order.dispatchStatus || "").toLowerCase();
    if (order.driverId || ds === "accepted" || ds === "assigned") {
      return { ok: false, status: 409, error: "Order already assigned" };
    }

    if (String(driver.status || "").toUpperCase() !== "ONLINE") {
      return { ok: false, status: 409, error: "Driver not ONLINE" };
    }

    if (driver.currentOrderId) {
      return { ok: false, status: 409, error: "Driver already has an order" };
    }

    tx.set(driverRef, {
      currentOrderId: tripId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.set(orderRef, {
      driverId: dId,
      dispatchStatus: "accepted",
      dispatchAssignedBy: "offer-system",
      dispatchUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { ok: true, status: 200, orderId: tripId, driverId: dId };
  });

  if (!txResult.ok) {
    // rollback locks
    await redis.call("DEL", tripLockKey(tripId));
    await redis.call("DEL", driverLockKey(dId));
    return txResult;
  }

  // 4) cleanup offers (others lose)
  await redis.call("DEL", tripOfferTtlKey(tripId));
  await redis.call("DEL", tripOfferDriversKey(tripId));

  return txResult;
}

/**
 * Decline offer:
 * - removes driver from trip offer set
 */
async function declineOffer({ orderId, driverId }) {
  const tripId = String(orderId);
  const dId = String(driverId);

  if (!tripId || !dId) return { ok: false, status: 400, error: "orderId and driverId required" };

  await redis.call("SREM", tripOfferDriversKey(tripId), dId);

  return { ok: true, status: 200, orderId: tripId, driverId: dId };
}

module.exports = { createOffers, acceptOffer, declineOffer };
