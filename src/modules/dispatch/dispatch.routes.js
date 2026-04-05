const express = require("express");
const router = express.Router();

const { admin, db } = require("../../shared/firestore");
const { findNearestDrivers, pickOnlineDriver } = require("./redis.geo");

const {
  autoAssign,
  assignDriverToOrder,
  driverAccept,
  cancelDispatch,
} = require("./dispatch.service");

// ===============================
// AUTO ASSIGN DRIVER (your existing)
// POST /api/dispatch/assign
// Body: { orderId, assignedBy? }
// ===============================
router.post("/assign", async (req, res) => {
  try {
    const { orderId, assignedBy } = req.body || {};

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        error: "orderId required",
      });
    }

    const result = await autoAssign({
      orderId: String(orderId),
      assignedBy: assignedBy != null ? String(assignedBy) : "system",
    });

    return res.status(result.status || 200).json(result);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

// ===============================
// AUTO ASSIGN (REDIS GEOSEARCH)
// POST /api/dispatch/assign/redis
// Body: { orderId, assignedBy?, radiusKm?, count? }
// ===============================
router.post("/assign/redis", async (req, res) => {
  try {
    const { orderId, assignedBy, radiusKm, count } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ ok: false, error: "orderId required" });
    }

    const oId = String(orderId);
    const snap = await db.collection("orders").doc(oId).get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "order not found" });
    }

    const data = snap.data() || {};
    const pickupLat = Number(data.pickupLat);
    const pickupLng = Number(data.pickupLng);

    if (Number.isNaN(pickupLat) || Number.isNaN(pickupLng)) {
      return res
        .status(400)
        .json({ ok: false, error: "order missing pickupLat/pickupLng" });
    }

    const ids = await findNearestDrivers({
      lat: pickupLat,
      lng: pickupLng,
      radiusKm: radiusKm != null ? Number(radiusKm) : 5,
      count: count != null ? Number(count) : 20,
    });

    const driverId = await pickOnlineDriver(ids);
    if (!driverId) {
      return res.status(404).json({ ok: false, error: "No available driver" });
    }

    const result = await assignDriverToOrder({
      orderId: oId,
      driverId: String(driverId),
      assignedBy: assignedBy != null ? String(assignedBy) : "redis",
    });

    return res.status(result.status || 200).json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===============================
// MANUAL ASSIGN
// POST /api/dispatch/assign/manual
// Body: { orderId, driverId }
// ===============================
router.post("/assign/manual", async (req, res) => {
  try {
    const { orderId, driverId } = req.body || {};

    if (!orderId || !driverId) {
      return res.status(400).json({
        ok: false,
        error: "orderId and driverId required",
      });
    }

    const result = await assignDriverToOrder({
      orderId: String(orderId),
      driverId: String(driverId),
      assignedBy: "manual",
    });

    return res.status(result.status || 200).json(result);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

// ===============================
// DRIVER ACCEPT
// POST /api/dispatch/accept
// Body: { orderId, driverId }
// ===============================
router.post("/accept", async (req, res) => {
  try {
    const { orderId, driverId } = req.body || {};

    if (!orderId || !driverId) {
      return res.status(400).json({
        ok: false,
        error: "orderId and driverId required",
      });
    }

    const result = await driverAccept({
      orderId: String(orderId),
      driverId: String(driverId),
    });

    return res.status(result.status || 200).json(result);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

// ===============================
// CANCEL DISPATCH
// POST /api/dispatch/cancel
// Body: { orderId, reason? }
// ===============================
router.post("/cancel", async (req, res) => {
  try {
    const { orderId, reason } = req.body || {};

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        error: "orderId required",
      });
    }

    const result = await cancelDispatch({
      orderId: String(orderId),
      reason: reason != null ? String(reason) : "cancelled",
    });

    return res.status(result.status || 200).json(result);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

module.exports = router;
