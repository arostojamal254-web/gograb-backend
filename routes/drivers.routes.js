const express = require('express')
const router = express.Router()
const admin = require('firebase-admin')
const geofire = require('geofire-common')

if (!admin.apps.length) admin.initializeApp()
const db = admin.firestore()

// POST /api/drivers/location
router.post('/location', async (req,res)=>{
  try{
    const { driverId, lat, lng } = req.body
    const hash = geofire.geohashForLocation([lat,lng])

    await db.collection('drivers').doc(driverId).set({
      driverId,
      lat,
      lng,
      geohash: hash,
      status:'available',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },{merge:true})

    res.json({ok:true})
  }catch(e){
    res.status(500).json({ok:false,error:e.toString()})
  }
})

// POST /api/drivers/status
router.post('/status', async (req,res)=>{
  try{
    const { driverId, status } = req.body
    await db.collection('drivers').doc(driverId).set({status},{merge:true})
    res.json({ok:true})
  }catch(e){
    res.status(500).json({ok:false,error:e.toString()})
  }
})

module.exports = router
