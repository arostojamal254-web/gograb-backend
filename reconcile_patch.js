// ==============================
// REPLACE ENTIRE /mpesa/reconcile
// ==============================
app.post("/mpesa/reconcile", async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) return res.status(400).json({ ok: false, error: "Missing orderId" });

    const orderRef = db.collection("orders_shared").doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Order not found" });

    const order = snap.data() || {};
    const checkoutRequestId = order?.payment?.checkoutRequestId;

    if (!checkoutRequestId) {
      return res.json({ ok: true, orderId, status: "pending", reason: "No checkoutRequestId" });
    }

    const cbSnap = await db.collection("mpesa_callbacks").doc(String(checkoutRequestId)).get();
    if (!cbSnap.exists) {
      return res.json({ ok: true, orderId, status: "pending", reason: "No callback yet" });
    }

    const cb = cbSnap.data() || {};
    const status = Number(cb?.resultCode) === 0 ? "success" : "failed";

    // IMPORTANT: Flutter reads paymentStatus (top-level)
    await orderRef.set(
      {
        paymentStatus: status,                 // ✅ what Flutter should read
        paymentProvider: "mpesa",
        paymentAmount: cb?.amount ?? 1,
        paymentPhone: cb?.phoneNumber ?? null,
        paymentReceipt: cb?.mpesaReceiptNumber ?? null,
        paymentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),

        // Keep nested payment object too (optional but recommended)
        payment: {
          ...(order.payment || {}),
          status,                              // mirrors paymentStatus
          amount: cb?.amount ?? 1,
          phoneNumber: cb?.phoneNumber ?? null,
          mpesaReceiptNumber: cb?.mpesaReceiptNumber ?? null,
          resultCode: cb?.resultCode ?? null,
          resultDesc: cb?.resultDesc ?? null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );

    return res.json({
      ok: true,
      orderId,
      status,
      checkoutRequestId: String(checkoutRequestId),
      receipt: cb?.mpesaReceiptNumber ?? null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});