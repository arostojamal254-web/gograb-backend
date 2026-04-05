const express = require("express");
const { admin, db } = require("../../shared/firestore");
const router = express.Router();

const COL_ORDERS = "orders_shared";
const COL_DRIVERS = "drivers";
const COL_ROUTES = "routes";

function lower(s){ return String(s||"").toLowerCase(); }

function isPaid(order) {
  return lower(order.paymentStatus) === "success" || lower(order?.payment?.status) === "success";
}

function isDispatchable(order) {
  const ds = lower(order.dispatchStatus);
  // not assigned/accepted/completed/cancelled
  if (ds === "assigned" || ds === "accepted" || ds === "completed" || ds === "cancelled") return false;
  // already routed
  if (order.routeId) return false;
  return true;
}

function pickZone(order) {
  return String(order.zoneId || order.pickupZoneId || order.pickup?.zoneId || order.dropoff?.zoneId || "nairobi");
}

function stopFromOrder(order, type) {
  // Try common shapes; adjust later if needed
  const pickup = order.pickup || order.pickupLocation || {};
  const drop = order.dropoff || order.dropoffLocation || order.delivery || {};
  const src = type === "PICKUP" ? pickup : drop;

  return {
    type,
    orderId: order.orderId || order.id || null,
    customerId: order.customerId || order.userId || null,
    vendorId: order.vendorId || order.shopId || null,
    zoneId: pickZone(order),
    lat: Number(src.lat ?? src.latitude ?? order.lat ?? 0),
    lng: Number(src.lng ?? src.longitude ?? order.lng ?? 0),
    address: src.address || order.address || null,
    phone: src.phone || order.phoneNumber || order.paymentPhone || null,
    status: "PENDING",
  };
}

async function findDriverForZone(zoneId) {
  const snap = await db.collection(COL_DRIVERS)
    .where("status", "==", "ONLINE")
    .where("zoneId", "==", zoneId)
    .limit(50)
    .get();

  for (const d of snap.docs) {
    const data = d.data() || {};
    if (!data.currentOrderId && !data.currentRouteId) {
      return { driverId: d.id, driver: data };
    }
  }
  return null;
}

async function buildAndAssignRoute({ maxOrders = 3, zoneId = null }) {
  // Fetch candidates (paid + not already routed)
  const snap = await db.collection(COL_ORDERS)
    .where("paymentStatus", "==", "success")
    .limit(200)
    .get();

  const all = snap.docs.map(d => ({ id: d.id, ...(d.data()||{}), orderId: d.id }));

  const candidates = all
    .filter(o => isPaid(o) && isDispatchable(o))
    .filter(o => zoneId ? pickZone(o) === zoneId : true);

  if (!candidates.length) return { ok: true, message: "No paid dispatchable orders" };

  // Choose a working zone (take from first order)
  const z = zoneId || pickZone(candidates[0]);

  // take up to maxOrders from that zone
  const orders = candidates.filter(o => pickZone(o) === z).slice(0, maxOrders);
  if (!orders.length) return { ok: true, message: "No orders in zone" };

  const driverPick = await findDriverForZone(z);
  if (!driverPick) return { ok: false, error: "NO_AVAILABLE_DRIVER", zoneId: z };

  const routeRef = db.collection(COL_ROUTES).doc();
  const routeId = routeRef.id;
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Stops rule (MVP but works): ALL pickups first, then all drops
  const pickups = orders.map(o => ({ ...stopFromOrder(o, "PICKUP") }));
  const drops   = orders.map(o => ({ ...stopFromOrder(o, "DROP") }));

  const stops = [...pickups, ...drops].map((s, i) => ({ ...s, index: i }));

  // Transaction to lock driver + mark orders + create route
  await db.runTransaction(async (tx) => {
    const driverRef = db.collection(COL_DRIVERS).doc(driverPick.driverId);
    const dSnap = await tx.get(driverRef);
    if (!dSnap.exists) throw new Error("Driver disappeared");

    const d = dSnap.data() || {};
    if (d.currentOrderId || d.currentRouteId) throw new Error("Driver already busy");

    // Create route
    tx.set(routeRef, {
      routeId,
      driverId: driverPick.driverId,
      zoneId: z,
      status: "ASSIGNED",
      orderIds: orders.map(o => o.orderId),
      createdAt: now,
      updatedAt: now,
      currentStopIndex: 0,
    }, { merge: true });

    // Stops subcollection
    stops.forEach((s) => {
      const stopDoc = routeRef.collection("stops").doc();
      tx.set(stopDoc, {
        stopId: stopDoc.id,
        ...s,
        createdAt: now,
        updatedAt: now,
      }, { merge: true });
    });

    // Mark orders batched into this route
    orders.forEach((o) => {
      const oRef = db.collection(COL_ORDERS).doc(o.orderId);
      tx.set(oRef, {
        routeId,
        dispatchStatus: "batched",
        dispatchUpdatedAt: now,
        driverId: driverPick.driverId, // visible to clients
        updatedAt: now,
      }, { merge: true });
    });

    // Lock driver
    tx.set(driverRef, {
      currentRouteId: routeId,
      currentOrderId: `ROUTE::${routeId}`,
      updatedAt: now,
    }, { merge: true });
  });

  return {
    ok: true,
    routeId,
    driverId: driverPick.driverId,
    zoneId: z,
    orderIds: orders.map(o => o.orderId),
    stops: stops.length
  };
}

// POST /api/batching/run  body:{maxOrders?, zoneId?}
router.post("/run", async (req, res) => {
  try {
    const maxOrders = Number(req.body?.maxOrders || 3);
    const zoneId = req.body?.zoneId ? String(req.body.zoneId) : null;
    const out = await buildAndAssignRoute({ maxOrders, zoneId });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;

