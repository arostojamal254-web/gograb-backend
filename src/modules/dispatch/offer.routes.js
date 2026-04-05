const express = require("express");
const router = express.Router();

const { createOffers, acceptOffer, declineOffer } = require("./offer.service");

/**
 * Admin/system creates offers for an order.
 * POST /api/dispatch/offers/create
 * { orderId, driverIds[], ttlSec }
 */
router.post("/offers/create", async (req, res) => {
  try {
    const r = await createOffers(req.body || {});
    return res.status(r.status || 200).json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, status: 500, error: e?.message || "Server error" });
  }
});

/**
 * Driver accepts an offer
 * POST /api/dispatch/offers/accept
 * { orderId, driverId }
 */
router.post("/offers/accept", async (req, res) => {
  try {
    const r = await acceptOffer(req.body || {});
    return res.status(r.status || 200).json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, status: 500, error: e?.message || "Server error" });
  }
});

/**
 * Driver declines an offer
 * POST /api/dispatch/offers/decline
 * { orderId, driverId }
 */
router.post("/offers/decline", async (req, res) => {
  try {
    const r = await declineOffer(req.body || {});
    return res.status(r.status || 200).json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, status: 500, error: e?.message || "Server error" });
  }
});

module.exports = router;
