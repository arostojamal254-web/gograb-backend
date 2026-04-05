/**
 * Redis Streams dispatch worker:
 * - reads jobs from stream:dispatch:{zone}
 * - finds candidates via Redis GEO
 * - creates wave offers
 *
 * Run:
 *   node .\src\workers\dispatch.worker.js nairobi
 */

const redis = require("../shared/redis");
const { offersStreamKey } = require("../shared/redis.keys");
const { findCandidateDrivers } = require("../modules/dispatch/matching.redis.service");
const { createOffers } = require("../modules/dispatch/offer.service");
const { db } = require("../shared/firestore");

const COL_ORDERS = "orders_shared";

const zoneId = String(process.argv[2] || "nairobi").toLowerCase();
const streamKey = offersStreamKey(zoneId);
const group = "dispatch-workers";
const consumer = `c-${Math.random().toString(16).slice(2)}`;

async function ensureGroup() {
  try {
    // XGROUP CREATE key group $ MKSTREAM
    await redis.call("XGROUP", "CREATE", streamKey, group, "$", "MKSTREAM");
  } catch (e) {
    // group exists -> ignore
  }
}

async function readLoop() {
  await ensureGroup();
  console.log(`[dispatch.worker] zone=${zoneId} stream=${streamKey} group=${group} consumer=${consumer}`);

  while (true) {
    // XREADGROUP GROUP group consumer COUNT 5 BLOCK 5000 STREAMS key >
    const resp = await redis.call(
      "XREADGROUP",
      "GROUP",
      group,
      consumer,
      "COUNT",
      "5",
      "BLOCK",
      "5000",
      "STREAMS",
      streamKey,
      ">"
    );

    if (!resp) continue;

    // resp format: [[streamKey, [[id, [k,v,k,v...]], ...]]]
    const stream = resp?.[0];
    const entries = stream?.[1] || [];

    for (const entry of entries) {
      const id = entry?.[0];
      const kv = entry?.[1] || [];
      const msg = {};
      for (let i = 0; i < kv.length; i += 2) msg[kv[i]] = kv[i + 1];

      const orderId = String(msg.orderId || "");
      if (!orderId) {
        await redis.call("XACK", streamKey, group, id);
        continue;
      }

      try {
        // Load order once
        const orderSnap = await db.collection(COL_ORDERS).doc(orderId).get();
        if (!orderSnap.exists) {
          await redis.call("XACK", streamKey, group, id);
          continue;
        }

        const order = orderSnap.data() || {};
        const ds = String(order.dispatchStatus || "").toLowerCase();
        if (order.driverId || ds === "accepted" || ds === "assigned") {
          await redis.call("XACK", streamKey, group, id);
          continue;
        }

        const pickupLat = Number(order.pickupLat ?? order?.pickup?.lat);
        const pickupLng = Number(order.pickupLng ?? order?.pickup?.lng);

        if (Number.isNaN(pickupLat) || Number.isNaN(pickupLng)) {
          await redis.call("XACK", streamKey, group, id);
          continue;
        }

        // Wave strategy (simple)
        const candidates = await findCandidateDrivers({
          zoneId,
          lat: pickupLat,
          lng: pickupLng,
          radiusKm: Number(msg.radiusKm || 5),
          count: Number(msg.count || 15),
        });

        // Wave 1: top 3
        const wave = candidates.slice(0, 3);

        if (!wave.length) {
          // no drivers - keep searching by requeueing later (optional)
          await redis.call("XACK", streamKey, group, id);
          continue;
        }

        await createOffers({ orderId, driverIds: wave, ttlSec: Number(msg.ttlSec || 12) });

        // ack job
        await redis.call("XACK", streamKey, group, id);
      } catch (e) {
        console.error("[dispatch.worker] job error:", e?.message || e);

        // ack anyway to avoid poison loop; production would use DLQ
        await redis.call("XACK", streamKey, group, id);
      }
    }
  }
}

readLoop().catch((e) => {
  console.error(e);
  process.exit(1);
});
