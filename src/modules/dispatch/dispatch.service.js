const { admin, db } = require("../../shared/firestore");
const COL_ORDERS = "orders_shared";
const COL_DRIVERS = "drivers";

/**
 * Haversine distance (meters)
 */
function distanceMeters(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const R = 6371000;

  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);

  const s1 = Math.sin(dLat / 2) ** 2;
  const s2 = Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(s1 + s2), Math.sqrt(1 - (s1 + s2)));

  return R * c;
}

function isPaidStatus(order) {
  const top = String(order?.paymentStatus || "").toLowerCase();
  const nested = String(order?.payment?.status || "").toLowerCase();
  return top === "success" || nested === "success";
}

function normalizeZone(order) {
  return (
    String(
      order?.zoneId ||
        order?.pickup?.zoneId ||
        order?.dropoff?.zoneId ||
        "nairobi"
    ) || "nairobi"
  );
}

function normalizePickup(order) {
  const pickupLat = order?.pickupLat ?? order?.pickup?.lat ?? null;
  const pickupLng = order?.pickupLng ?? order?.pickup?.lng ?? null;

  return {
    pickupLat: pickupLat == null ? null : Number(pickupLat),
    pickupLng: pickupLng == null ? null : Number(pickupLng),
  };
}

/**
 * Find best available driver (ONLINE, zone match, no currentOrderId).
 * Preference: nearest to pickup if driver has (lat/lng or location.lat/location.lng)
 */
async function findBestDriver({ zoneId, pickupLat, pickupLng, limit = 50 }) {
  const snap = await db
    .collection(COL_DRIVERS)
    .where("status", "==", "ONLINE")
    .where("zoneId", "==", zoneId)
    .limit(limit)
    .get();

  let best = null;

  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (d.currentOrderId) continue;

    const dLat = d.lat ?? d.location?.lat ?? null;
    const dLng = d.lng ?? d.location?.lng ?? null;

    // If pickup known and driver location known: rank by distance; otherwise rank last
    let score = Number.MAX_SAFE_INTEGER;

    if (
      pickupLat != null &&
      pickupLng != null &&
      dLat != null &&
      dLng != null
    ) {
      score = distanceMeters(pickupLat, pickupLng, Number(dLat), Number(dLng));
    }

    if (!best || score < best.score) {
      best = { driverId: doc.id, driver: d, score };
    }
  }

  return best; // { driverId, driver, score } | null
}

/**
 * Assign driver to order atomically.
 * Guards:
 * - order must exist
 * - order must be PAID (paymentStatus success)
 * - order must not already be assigned/accepted
 * - driver must be ONLINE + free (no currentOrderId)
 */
async function assignDriverToOrder({ orderId, driverId, assignedBy = "system" }) {
  const orderRef = db.collection(COL_ORDERS).doc(String(orderId));
  const driverRef = db.collection(COL_DRIVERS).doc(String(driverId));

  return db.runTransaction(async (tx) => {
    const [oSnap, dSnap] = await Promise.all([
      tx.get(orderRef),
      tx.get(driverRef),
    ]);

    if (!oSnap.exists) {
      return { ok: false, status: 404, error: "Order not found" };
    }
    if (!dSnap.exists) {
      return { ok: false, status: 404, error: "Driver not found" };
    }

    const order = oSnap.data() || {};
    const driver = dSnap.data() || {};

    // must be paid
    if (!isPaidStatus(order)) {
      return { ok: false, status: 409, error: "Order not paid" };
    }

    // already assigned/accepted
    const ds = String(order.dispatchStatus || "").toLowerCase();
    if (order.driverId || ds === "accepted" || ds === "assigned") {
      return { ok: false, status: 409, error: "Order already assigned" };
    }

    // driver must be available
    if (String(driver.status || "").toUpperCase() !== "ONLINE") {
      return { ok: false, status: 409, error: "Driver not ONLINE" };
    }
    if (driver.currentOrderId) {
      return { ok: false, status: 409, error: "Driver already has an order" };
    }

    // lock driver + set order
    tx.set(
      driverRef,
      {
        currentOrderId: String(orderId),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      orderRef,
      {
        driverId: String(driverId),
        dispatchStatus: "assigned",
        dispatchAssignedBy: String(assignedBy),
        dispatchUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true, status: 200, orderId: String(orderId), driverId: String(driverId) };
  });
}

/**
 * Auto-assign: choose best driver then assign.
 */
async function autoAssign({ orderId, assignedBy = "system" }) {
  const orderRef = db.collection(COL_ORDERS).doc(String(orderId));
  const snap = await orderRef.get();

  if (!snap.exists) {
    return { ok: false, status: 404, error: "Order not found" };
  }

  const order = snap.data() || {};

  if (!isPaidStatus(order)) {
    return { ok: false, status: 409, error: "Order not paid" };
  }

  const ds = String(order.dispatchStatus || "").toLowerCase();
  if (order.driverId || ds === "accepted" || ds === "assigned") {
    return { ok: false, status: 409, error: "Order already assigned" };
  }

  const zoneId = normalizeZone(order);
  const { pickupLat, pickupLng } = normalizePickup(order);

  const best = await findBestDriver({ zoneId, pickupLat, pickupLng });

  if (!best) {
    return { ok: false, status: 404, error: "No available driver" };
  }

  return assignDriverToOrder({
    orderId: String(orderId),
    driverId: String(best.driverId),
    assignedBy: String(assignedBy),
  });
}

/**
 * Driver accept: driver must match assigned driver. Transition assigned -> accepted.
 */
async function driverAccept({ orderId, driverId }) {
  const orderRef = db.collection(COL_ORDERS).doc(String(orderId));
  const driverRef = db.collection(COL_DRIVERS).doc(String(driverId));

  return db.runTransaction(async (tx) => {
    const [oSnap, dSnap] = await Promise.all([
      tx.get(orderRef),
      tx.get(driverRef),
    ]);

    if (!oSnap.exists) {
      return { ok: false, status: 404, error: "Order not found" };
    }
    if (!dSnap.exists) {
      return { ok: false, status: 404, error: "Driver not found" };
    }

    const order = oSnap.data() || {};
    const driver = dSnap.data() || {};

    if (String(order.driverId || "") !== String(driverId)) {
      return { ok: false, status: 409, error: "Driver not assigned to this order" };
    }

    const ds = String(order.dispatchStatus || "").toLowerCase();
    if (ds !== "assigned") {
      return { ok: false, status: 409, error: "Order not in assigned state" };
    }

    if (String(driver.currentOrderId || "") !== String(orderId)) {
      return { ok: false, status: 409, error: "Driver lock mismatch" };
    }

    tx.set(
      orderRef,
      {
        dispatchStatus: "accepted",
        dispatchUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true, status: 200, orderId: String(orderId), driverId: String(driverId) };
  });
}

/**
 * Cancel dispatch:
 * - clears driver lock if locked to this order
 * - sets order dispatchStatus = cancelled
 */
async function cancelDispatch({ orderId, reason = "cancelled" }) {
  const orderRef = db.collection(COL_ORDERS).doc(String(orderId));

  return db.runTransaction(async (tx) => {
    const oSnap = await tx.get(orderRef);

    if (!oSnap.exists) {
      return { ok: false, status: 404, error: "Order not found" };
    }

    const order = oSnap.data() || {};
    const driverId = order.driverId ? String(order.driverId) : null;

    if (driverId) {
      const driverRef = db.collection(COL_DRIVERS).doc(driverId);
      const dSnap = await tx.get(driverRef);

      if (dSnap.exists) {
        const driver = dSnap.data() || {};
        if (String(driver.currentOrderId || "") === String(orderId)) {
          tx.set(
            driverRef,
            {
              currentOrderId: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      }
    }

    tx.set(
      orderRef,
      {
        dispatchStatus: "cancelled",
        cancelReason: String(reason),
        dispatchUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true, status: 200, orderId: String(orderId) };
  });
}

module.exports = {
  autoAssign,
  assignDriverToOrder,
  driverAccept,
  cancelDispatch,
};


