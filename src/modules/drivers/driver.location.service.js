const redis = require("../../shared/redis");
const { admin, db } = require("../../shared/firestore");
const { geoKey, hbKey, driverStateKey } = require("../../shared/redis.keys");

const COL_DRIVERS = "drivers";
const STATUS_KEY = "drivers:status";
const GEO_KEY_COMPAT = "drivers:geo";

async function upsertDriverLocation(payload) {
  try {
    const driverId = String(payload?.driverId || "").trim();
    const zoneId = String(payload?.zoneId || "nairobi").trim().toLowerCase();

    const lat = Number(payload?.lat);
    const lng = Number(payload?.lng);

    if (!driverId) return { ok: false, status: 400, error: "driverId required" };
    if (Number.isNaN(lat) || Number.isNaN(lng)) return { ok: false, status: 400, error: "lat/lng required" };

    const nowSec = Math.floor(Date.now() / 1000);

    // 1) GEOADD zone key drivers:geo:<zone>
    await redis.call("GEOADD", geoKey(zoneId), String(lng), String(lat), driverId);
    console.log(`[redis] GEOADD success for ${driverId}`);

    // 1b) Compatibility: also write to drivers:geo
    await redis.call("GEOADD", GEO_KEY_COMPAT, String(lng), String(lat), driverId);

    // 2) heartbeat TTL - THIS WAS FAILING
    try {
      await redis.call("SET", hbKey(driverId), String(nowSec), "EX", "30");
      console.log(`[redis] Heartbeat set for ${driverId}`);
    } catch (hbError) {
      console.error(`[redis] Heartbeat failed:`, hbError.message);
      // Try alternative method
      await redis.set(hbKey(driverId), String(nowSec), 'EX', 30);
    }

    // 3) status hash
    await redis.call("HSET", STATUS_KEY, driverId, "ONLINE");

    // 4) cache driver state
    await redis.call(
      "HSET",
      driverStateKey(driverId),
      "status",
      "ONLINE",
      "zoneId",
      zoneId,
      "lat",
      String(lat),
      "lng",
      String(lng),
      "lastPing",
      String(nowSec)
    );

    // Firestore
    await db.collection(COL_DRIVERS).doc(driverId).set(
      {
        status: "ONLINE",
        zoneId,
        location: { lat, lng },
        lat,
        lng,
        lastPing: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true, status: 200, driverId, zoneId, lat, lng, ts: nowSec };
  } catch (e) {
    console.error("[upsertDriverLocation] CRITICAL ERROR:", e);
    return { ok: false, status: 500, error: e?.message || String(e) };
  }
}

module.exports = { upsertDriverLocation };
