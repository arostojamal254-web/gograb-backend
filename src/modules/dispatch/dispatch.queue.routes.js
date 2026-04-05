const express = require("express");
const router = express.Router();

const redis = require("../../shared/redis");
const { offersStreamKey } = require("../../shared/redis.keys");

/**
 * Enqueue a dispatch job (fast HTTP).
 * POST /api/dispatch/enqueue
 * { orderId, zoneId, radiusKm, count, ttlSec }
 */
router.post("/enqueue", async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "").trim();
    const zoneId = String(req.body?.zoneId || "nairobi").trim().toLowerCase();

    if (!orderId) return res.status(400).json({ ok: false, status: 400, error: "orderId required" });

    const payload = {
      orderId,
      radiusKm: String(req.body?.radiusKm ?? 5),
      count: String(req.body?.count ?? 15),
      ttlSec: String(req.body?.ttlSec ?? 12),
    };

    // XADD stream * field value ...
    const id = await redis.call(
      "XADD",
      offersStreamKey(zoneId),
      "*",
      "orderId",
      payload.orderId,
      "radiusKm",
      payload.radiusKm,
      "count",
      payload.count,
      "ttlSec",
      payload.ttlSec
    );

    return res.status(200).json({ ok: true, status: 200, jobId: id, zoneId, ...payload });
  } catch (e) {
    return res.status(500).json({ ok: false, status: 500, error: e?.message || "Server error" });
  }
});

module.exports = router;
