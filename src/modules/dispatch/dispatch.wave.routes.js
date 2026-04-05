const express = require("express");
const redis = require("../../shared/redis");
const { offersStreamKey } = require("../../shared/redis.keys");

const router = express.Router();

router.post("/enqueue_wave", async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "").trim();
    const zoneIdRaw = req.body?.zoneId ?? "nairobi";
    const zoneId = String(zoneIdRaw).trim().toLowerCase();

    const pickupLat = Number(req.body?.pickupLat);
    const pickupLng = Number(req.body?.pickupLng);

    if (!orderId) return res.status(400).json({ ok: false, error: "orderId required" });

    if (Number.isNaN(pickupLat) || Number.isNaN(pickupLng)) {
      return res.status(400).json({ ok: false, error: "pickupLat/pickupLng required" });
    }

    // single source of truth for stream key
    const stream = offersStreamKey(zoneId); // stream:dispatch:<zone>

    const jobId = await redis.call(
      "XADD",
      stream,
      "*",
      "orderId",
      orderId,
      "zoneId",
      zoneId,
      "pickupLat",
      String(pickupLat),
      "pickupLng",
      String(pickupLng)
    );

    return res.json({ ok: true, jobId, stream });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;