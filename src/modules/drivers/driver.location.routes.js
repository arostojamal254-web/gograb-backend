const express = require("express");
const router = express.Router();
const { upsertDriverLocation } = require("./driver.location.service");

/**
 * Driver sends GPS every 1-2 seconds.
 * POST /api/drivers/location
 */
router.post("/location", async (req, res) => {
  try {
    // Add zoneId if not provided
    const body = req.body || {};
    if (!body.zoneId) body.zoneId = "nairobi";
    
    const result = await upsertDriverLocation(body);
    return res.status(result.status || 200).json(result);
  } catch (e) {
    console.error("[driver.location] Error:", e);
    return res.status(500).json({ 
      ok: false, 
      error: e?.message || "Server error" 
    });
  }
});

module.exports = router;