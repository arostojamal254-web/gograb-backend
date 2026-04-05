const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const router = express.Router();

// POST /api/geocode/vendor/:vendorId
router.post('/vendor/:vendorId', async (req, res) => {
  const { vendorId } = req.params;
  const db = admin.firestore();

  try {
    const vendorDoc = await db.collection('vendors').doc(vendorId).get();
    if (!vendorDoc.exists) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    const vendor = vendorDoc.data();
    if (!vendor.address) {
      return res.status(400).json({ error: 'Vendor has no address' });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Google Maps API key not configured' });
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(vendor.address)}&key=${apiKey}`;
    const response = await axios.get(url);

    if (response.data.status !== 'OK') {
      return res.status(400).json({ error: 'Geocoding failed', details: response.data.status });
    }

    // Extract county (administrative_area_level_1)
    let county = null;
    for (const result of response.data.results) {
      for (const component of result.address_components) {
        if (component.types.includes('administrative_area_level_1')) {
          county = component.long_name;
          break;
        }
      }
      if (county) break;
    }

    if (!county) {
      return res.status(400).json({ error: 'County not found in address' });
    }

    // Normalize to match dropdown list (lowercase, remove " County" suffix)
    const normalized = county.replace(/\s+County$/i, '').toLowerCase();

    await db.collection('vendors').doc(vendorId).update({ county: normalized });

    res.json({ success: true, county: normalized });
  } catch (err) {
    console.error('Geocoding error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;