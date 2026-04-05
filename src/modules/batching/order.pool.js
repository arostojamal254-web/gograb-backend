const { admin, db } = require("../../shared/firestore");
async function fetchReadyOrders(limit = 20) {
  const snap = await db().collection("orders")
    .where("status", "==", "READY_FOR_BATCHING")
    .limit(limit)
    .get();
  return snap.docs.map(d => d.data());
}

async function markOrdersBatched(orderIds, routeId) {
  const batch = db().batch();
  const now = new Date().toISOString();
  orderIds.forEach(id => {
    const ref = db().collection("orders").doc(id);
    batch.set(ref, { status: "BATCHED", routeId, updatedAt: now }, { merge: true });
  });
  await batch.commit();
}

module.exports = { fetchReadyOrders, markOrdersBatched };

