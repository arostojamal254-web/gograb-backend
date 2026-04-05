const express = require("express");

const router = express.Router();

const {
  autoAssign,
  assignDriverToOrder,
  driverAccept,
  cancelDispatch,
} = require("./dispatch.service");

const { admin, db } = require("../../shared/firestore");
// ===============================
// AUTO ASSIGN DRIVER
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

