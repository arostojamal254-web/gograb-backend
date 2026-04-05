const admin=require("firebase-admin");
require("dotenv").config();
if(!admin.apps.length){admin.initializeApp({credential:admin.credential.applicationDefault()});}
const db=admin.firestore();
const DEFAULT_ZONE_ID=String(process.env.DEFAULT_ZONE_ID||"transnzoia").trim().toLowerCase();
async function run(){
const snap=await db.collection("dispatch_queue").where("status","==","queued").limit(5).get();
for(const doc of snap.docs){
const orderId=doc.id;
let zoneId=doc.data().zoneId||DEFAULT_ZONE_ID;
await db.collection("dispatch_queue").doc(orderId).set({zoneId},{merge:true});
const drivers=await db.collection("drivers").where("status","==","ONLINE").where("zoneId","==",zoneId).limit(5).get();
for(const d of drivers.docs){
await db.collection("driver_offers").add({orderId,driverId:d.id,status:"offered",createdAt:admin.firestore.FieldValue.serverTimestamp()});
}
await db.collection("dispatch_queue").doc(orderId).set({status:"offered",updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
}
}
setInterval(run,5000);
console.log("Worker running");
