const { admin, db } = require("../src/shared/firestore");

const COL_ORDERS = "orders_shared";
const COL_DRIVERS = "drivers";

async function main() {
  const orderId = String(process.argv[2] || "order1");
  const orderRef = db.collection(COL_ORDERS).doc(orderId);

  await db.runTransaction(async (tx) => {
    const oSnap = await tx.get(orderRef);
    if (!oSnap.exists) throw new Error("Order not found: " + orderId);

    const order = oSnap.data() || {};
    const driverId = order.driverId ? String(order.driverId) : null;

    // If driver is locked to this order, unlock
    if (driverId) {
      const driverRef = db.collection(COL_DRIVERS).doc(driverId);
      const dSnap = await tx.get(driverRef);

      if (dSnap.exists) {
        const driver = dSnap.data() || {};
        if (String(driver.currentOrderId || "") === orderId) {
          tx.set(driverRef, {
            currentOrderId: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      }
    }

    // Reset order dispatch fields
    tx.set(orderRef, {
      driverId: admin.firestore.FieldValue.delete(),
      dispatchStatus: admin.firestore.FieldValue.delete(),
      dispatchAssignedBy: admin.firestore.FieldValue.delete(),
      dispatchUpdatedAt: admin.firestore.FieldValue.delete(),
      cancelReason: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  console.log("OK reset order + unlocked driver (if needed):", orderId);
  process.exit(0);
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
