const express = require('express')
const router = express.Router()

const dispatchService = require('../services/dispatch.service')

// POST /api/dispatch/:orderId  { pickupLat, pickupLng }
router.post('/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params
    const pickupLat = req.body?.pickupLat ?? req.body?.lat ?? req.body?.pickup_location?.lat
    const pickupLng = req.body?.pickupLng ?? req.body?.lng ?? req.body?.pickup_location?.lng

    if (pickupLat === undefined || pickupLng === undefined) {
      return res.status(400).json({ ok: false, error: 'pickupLat/pickupLng required in JSON body' })
    }

    if (typeof dispatchService.dispatchOrder !== 'function') {
      return res.status(500).json({ ok: false, error: 'dispatchOrder export missing from services/dispatch.service.js' })
    }

    const driverId = await dispatchService.dispatchOrder(orderId, Number(pickupLat), Number(pickupLng))
    return res.json({ ok: true, driverId })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.toString() })
  }
})

module.exports = router
