const admin=require("firebase-admin");
admin.initializeApp({credential: admin.credential.applicationDefault()});
const db=admin.firestore();

const orderId=process.argv[2];
if(!orderId){
  console.log("USAGE: node watch_order.js ORDER_...");
  process.exit(1);
}

console.log("Watching orders_shared/" + orderId);

db.collection("orders_shared").doc(orderId).onSnapshot(s=>{
  if(!s.exists){ console.log(new Date().toISOString(), "DOC MISSING"); return; }
  const d=s.data();
  console.log(
    new Date().toISOString(),
    "paymentStatus=", d.paymentStatus,
    "| payment.status=", d.payment?.status,
    "| payment.checkoutRequestId=", d.payment?.checkoutRequestId
  );
}, err=>console.error("WATCH ERROR:", err));

setInterval(()=>{}, 1<<30);
