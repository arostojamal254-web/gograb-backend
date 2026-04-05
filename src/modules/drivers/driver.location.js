const express = require("express");
const { admin, db } = require("../../shared/firestore");
const router = express.Router();

const COL_DRIVERS = "drivers";
const COL_ROUTES  = "routes";

function now(){ return admin.firestore.FieldValue.serverTimestamp(); }

function distanceMeters(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLon = (lon2-lon1) * Math.PI/180;

  const a =
    Math.sin(dLat/2)*Math.sin(dLat/2) +
    Math.cos(lat1*Math.PI/180)*
    Math.cos(lat2*Math.PI/180)*
    Math.sin(dLon/2)*Math.sin(dLon/2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}

// POST /api/drivers/:driverId/location
router.post("/:driverId/location", async (req,res)=>{
  try{

    const driverId = req.params.driverId;
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);

    if(!driverId) return res.status(400).json({ok:false,error:"driverId required"});

    const dRef = db.collection(COL_DRIVERS).doc(driverId);
    const dSnap = await dRef.get();

    if(!dSnap.exists) return res.status(404).json({ok:false,error:"driver not found"});

    const driver = dSnap.data();
    const routeId = driver.currentRouteId;

    await dRef.set({
      location:{lat,lng},
      updatedAt: now()
    },{merge:true});

    if(!routeId){
      return res.json({ok:true,driverId,tracking:true});
    }

    const rRef = db.collection(COL_ROUTES).doc(routeId);
    const stopsSnap = await rRef.collection("stops").orderBy("index").get();

    const stops = stopsSnap.docs.map(x=>x.data());
    const nextStop = stops.find(s=>String(s.status||"")!=="DONE");

    if(!nextStop){
      return res.json({ok:true,driverId,routeCompleted:true});
    }

    const stopLat = nextStop.location?.lat;
    const stopLng = nextStop.location?.lng;

    if(stopLat && stopLng){

      const dist = distanceMeters(lat,lng,stopLat,stopLng);

      if(dist < 40 && nextStop.status !== "ARRIVED"){

        await rRef.collection("stops").doc(nextStop.stopId).set({
          status:"ARRIVED",
          autoArrived:true,
          updatedAt:now()
        },{merge:true});

        return res.json({
          ok:true,
          autoArrived:true,
          stopId:nextStop.stopId,
          distance:Math.round(dist)
        });
      }
    }

    return res.json({ok:true,tracking:true});

  }catch(e){
    res.status(400).json({ok:false,error:String(e?.message||e)});
  }
});

module.exports = router;

