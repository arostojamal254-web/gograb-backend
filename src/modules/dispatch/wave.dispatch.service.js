const redis = require("../../shared/redis");
const { admin, db } = require("../../shared/firestore");
const { driverInboxKey } = require("../../shared/redis.keys");
const { findCandidateDrivers, filterFreeDrivers } = require("./matching.redis.service");

const COL_ORDERS = "orders_shared";

// Redis keys
const orderStateKey = (orderId) => `offer:order:${orderId}:state`;     // HASH
const orderOfferedSetKey = (orderId) => `offer:order:${orderId}:sent`; // SET of driverIds offered

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Firestore guard: stop if order already accepted/assigned/cancelled.
 */
async function orderStillNeedsDriver(orderId) {
  const snap = await db.collection(COL_ORDERS).doc(String(orderId)).get();
  if (!snap.exists) return { ok: false, stop: true, reason: "order_not_found" };

  const o = snap.data() || {};
  const ds = String(o.dispatchStatus || "").toLowerCase();

  if (o.driverId) return { ok: true, stop: true, reason: "already_has_driver" };
  if (ds === "accepted" || ds === "assigned") return { ok: true, stop: true, reason: "already_assigned" };
  if (ds === "cancelled") return { ok: true, stop: true, reason: "cancelled" };

  return { ok: true, stop: false };
}

/**
 * Mark an order as being in dispatch (optional but useful).
 */
async function markSearching(orderId) {
  await db.collection(COL_ORDERS).doc(String(orderId)).set(
    {
      dispatchStatus: "searching",
      dispatchUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * Normalize Redis SMISMEMBER results across clients/versions.
 * Could be: 0/1, "0"/"1", false/true, null/undefined.
 */
function isMember(val) {
  return val === 1 || val === "1" || val === true;
}

/**
 * Offer to a set of drivers:
 * - avoids re-offering using Redis SET offer:order:<id>:sent
 * - pushes to driver inbox list offer:driver:<id>:inbox
 * - sets order state hash (active wave metadata)
 */
async function sendWaveOffers({ orderId, driverIds, ttlSec, waveNo }) {
  if (!driverIds?.length) return { offered: 0, offeredIds: [] };

  // Remove drivers already offered
  const already = await redis.call("SMISMEMBER", orderOfferedSetKey(orderId), ...driverIds);

  const fresh = [];
  for (let i = 0; i < driverIds.length; i++) {
    const offeredAlready = isMember(already?.[i]);
    if (!offeredAlready) fresh.push(driverIds[i]);
  }

  if (!fresh.length) return { offered: 0, offeredIds: [] };

  // Record offered drivers
  await redis.call("SADD", orderOfferedSetKey(orderId), ...fresh);

  // Push offers to drivers (WS gateway will deliver instantly)
  for (const dId of fresh) {
    await redis.call("LPUSH", driverInboxKey(dId), String(orderId));
  }

  // Store state
  await redis.call(
    "HSET",
    orderStateKey(orderId),
    "status",
    "offered",
    "waveNo",
    String(waveNo),
    "ttlSec",
    String(ttlSec),
    "lastOfferAt",
    String(nowSec())
  );

  // TTL state cleanup
  await redis.call("EXPIRE", orderStateKey(orderId), String(Math.max(60, ttlSec * 10)));
  await redis.call("EXPIRE", orderOfferedSetKey(orderId), String(Math.max(60, ttlSec * 10)));

  return { offered: fresh.length, offeredIds: fresh };
}

/**
 * Wave plan: small → bigger → bigger
 */
function defaultWavePlan() {
  return [
    { radiusKm: 2, count: 6, offerN: 2, ttlSec: 10 },
    { radiusKm: 4, count: 12, offerN: 4, ttlSec: 10 },
    { radiusKm: 7, count: 25, offerN: 6, ttlSec: 12 },
    { radiusKm: 12, count: 40, offerN: 10, ttlSec: 15 },
  ];
}

/**
 * Main wave dispatch loop.
 * Stops when:
 * - order assigned/accepted
 * - waves exhausted
 */
async function runWaveDispatch({
  orderId,
  zoneId = "nairobi",
  pickupLat,
  pickupLng,
  waves = defaultWavePlan(),
}) {
  if (pickupLat == null || pickupLng == null) {
    return { ok: false, error: "pickupLat/pickupLng required" };
  }

  const zid = String(zoneId || "nairobi").trim().toLowerCase();

  await markSearching(orderId);

  for (let waveNo = 1; waveNo <= waves.length; waveNo++) {
    const g = await orderStillNeedsDriver(orderId);
    if (!g.ok) return { ok: false, error: g.reason || "order_guard_failed" };
    if (g.stop) return { ok: true, stop: true, reason: g.reason };

    const w = waves[waveNo - 1];

    // 1) candidates from Redis GEO (zone key) + online filter (heartbeat OR drivers:status)
    const candidates = await findCandidateDrivers({
      zoneId: zid,
      lat: pickupLat,
      lng: pickupLng,
      radiusKm: w.radiusKm,
      count: w.count,
      requireOnline: true,
    });

    // 2) free filter (no currentOrderId, permissive if status not stored)
    const free = await filterFreeDrivers(candidates);

    // 3) offer top N
    const offerIds = free.slice(0, w.offerN);

    // 4) send offers
    const res = await sendWaveOffers({
      orderId,
      driverIds: offerIds,
      ttlSec: w.ttlSec,
      waveNo,
    });

    if (res.offered === 0) continue;

    // 5) wait TTL for accept
    await new Promise((r) => setTimeout(r, w.ttlSec * 1000));
  }

  return { ok: true, stop: true, reason: "waves_exhausted" };
}

module.exports = { runWaveDispatch, defaultWavePlan };