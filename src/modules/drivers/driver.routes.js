const express = require("express");
const router = express.Router();
const geofire = require("geofire-common");
const redis = require("../../shared/redis");

const { admin, db } = require("../../shared/firestore");
const GEO_KEY = "drivers:geo";
const STATUS_KEY = "drivers:status"; // hash: driverId -> status

// POST /api/drivers/location
// Body: { driverId, lat, lng }
router.post("/location", async (req, res) => {
  try {
    const { driverId, lat, lng } = req.body || {};
    if (!driverId || lat == null || lng == null) {
      return res.status(400).json({ ok: false, error: "driverId, lat, lng required" });
    }

    const dId = String(driverId);
    const latitude = Number(lat);
    const longitude = Number(lng);

    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
      return res.status(400).json({ ok: false, error: "lat/lng must be numbers" });
    }

    const geohash = geofire.geohashForLocation([latitude, longitude]);

    // Firestore
    await db.collection("drivers").doc(dId).set(
      {
        lat: latitude,
        lng: longitude,
        geohash,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Redis GEO index
    await redis.geoadd(GEO_KEY, longitude, latitude, dId);

    // Optional debug payload
    await redis.hset(
      "drivers:last",
      dId,
      JSON.stringify({ lat: latitude, lng: longitude, geohash, t: Date.now() })
    );

    return res.json({ ok: true, driverId: dId, geohash });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/drivers/status
// Body: { driverId, status }
router.post("/status", async (req, res) => {
  try {
    const { driverId, status } = req.body || {};
    if (!driverId || !status) {
      return res.status(400).json({ ok: false, error: "driverId and status required" });
    }

    const dId = String(driverId);
    const st = String(status);

    // Firestore
    await db.collection("drivers").doc(dId).set(
      {
        status: st,
        statusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Redis status
    await redis.hset(STATUS_KEY, dId, st);

    return res.json({ ok: true, driverId: dId, status: st });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;

