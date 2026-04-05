function registerRiderRoutes(app, db) {
  // POST /rider/accept
  // Body: { "orderId": "..." }
  // Returns:
  //   200 { ok:true, orderId, status }
  //   409 { ok:false, error:"payment not confirmed" }
  //   400 { ok:false, error:"orderId required" }
  app.post("/rider/accept", async (req, res) => {
    try {
      const orderId = (req.body && req.body.orderId) ? String(req.body.orderId).trim() : "";
      if (!orderId) return res.status(400).json({ ok: false, error: "orderId required" });

      const ref = db.collection("orders").doc(orderId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "order not found" });

      const order = snap.data() || {};
      const paid =
        order.paymentStatus === "success" ||
        order.paymentStatus === "paid" ||
        order.status === "paid" ||
        order.status === "success" ||
        order.mpesaStatus === "success" ||
        order.paid === true;

      if (!paid) return res.status(409).json({ ok: false, error: "payment not confirmed" });

      // Mark accepted (non-destructive)
      await ref.set(
        { riderStatus: "accepted", riderAcceptedAt: new Date().toISOString() },
        { merge: true }
      );

      return res.json({ ok: true, orderId, status: "accepted" });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

module.exports = { registerRiderRoutes };
