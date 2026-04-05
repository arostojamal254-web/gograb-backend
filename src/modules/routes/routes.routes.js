const express = require("express");
const { admin, db } = require("../../shared/firestore");
const router = express.Router();
const COL_ROUTES = "routes";
const COL_DRIVERS = "drivers";

function now(){ return admin.firestore.FieldValue.serverTimestamp(); }

// GET /api/routes/:routeId  (route + stops)
router.get("/:routeId", async (req, res) => {
  try {
    const routeId = String(req.params.routeId);
    const ref = db.collection(COL_ROUTES).doc(routeId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"route not found" });

    const stopsSnap = await ref.collection("stops").orderBy("index").get();
    const stops = stopsSnap.docs.map(d => d.data());
    res.json({ ok:true, route: snap.data(), stops });
  } catch (e) {
    res.status(400).json({ ok:false, error: String(e?.message||e) });
  }
});

// POST /api/routes/:routeId/stops/:stopId/arrived
router.post("/:routeId/stops/:stopId/arrived", async (req, res) => {
  try {
    const { routeId, stopId } = req.params;
    const stopRef = db.collection(COL_ROUTES).doc(routeId).collection("stops").doc(stopId);

    const snap = await stopRef.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"stop not found" });

    await stopRef.set({ status:"ARRIVED", updatedAt: now() }, { merge:true });
    await db.collection(COL_ROUTES).doc(routeId).set({ updatedAt: now() }, { merge:true });

    res.json({ ok:true, routeId, stopId, status:"ARRIVED" });
  } catch (e) {
    res.status(400).json({ ok:false, error: String(e?.message||e) });
  }
});

// POST /api/routes/:routeId/stops/:stopId/done
router.post("/:routeId/stops/:stopId/done", async (req, res) => {
  try {
    const { routeId, stopId } = req.params;

    const routeRef = db.collection(COL_ROUTES).doc(routeId);
    const stopRef  = routeRef.collection("stops").doc(stopId);

    await db.runTransaction(async (tx) => {
      // ? READS FIRST
      const routeSnap = await tx.get(routeRef);
      const stopSnap  = await tx.get(stopRef);
      if (!routeSnap.exists) throw new Error("route not found");
      if (!stopSnap.exists) throw new Error("stop not found");

      const stopsSnap = await tx.get(routeRef.collection("stops").orderBy("index"));
      const stops = stopsSnap.docs.map(d => d.data());

      // Determine if route will finish after marking this stop DONE
      const remaining = stops.filter(s => s.stopId !== stopId).filter(s => String(s.status||"") !== "DONE");
      const route = routeSnap.data() || {};

      // ? WRITES AFTER ALL READS
      tx.set(stopRef, { status:"DONE", updatedAt: now() }, { merge:true });

      if (remaining.length === 0) {
        // route complete => free driver
        tx.set(routeRef, { status:"COMPLETED", updatedAt: now() }, { merge:true });

        if (route.driverId) {
          const dRef = db.collection(COL_DRIVERS).doc(route.driverId);
          tx.set(dRef, { currentRouteId: null, currentOrderId: null, updatedAt: now() }, { merge:true });
        }
      } else {
        tx.set(routeRef, { updatedAt: now() }, { merge:true });
      }
    });

    res.json({ ok:true, routeId, stopId, status:"DONE" });
  } catch (e) {
    res.status(400).json({ ok:false, error: String(e?.message||e) });
  }
});

module.exports = router;

