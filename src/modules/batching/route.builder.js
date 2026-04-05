const { v4: uuidv4 } = require("uuid");
const { admin, db } = require("../../shared/firestore");
/**
 * MVP batching rule:
 * - Build 1 route from up to maxOrders orders
 * - Stops: all PICKUPS first, then all DROPS
 * Each order must include:
 *  { orderId, pickup:{lat,lng,...}, drop:{lat,lng,...}, vendorId, customerId }
 */
function buildStopsFromOrders(orders) {
  const pickups = orders.map(o => ({
    type: "PICKUP",
    orderId: o.orderId,
    vendorId: o.vendorId || null,
    customerId: o.customerId || null,
    lat: o.pickup.lat,
    lng: o.pickup.lng,
    address: o.pickup.address || null,
  }));

  const drops = orders.map(o => ({
    type: "DROP",
    orderId: o.orderId,
    vendorId: o.vendorId || null,
    customerId: o.customerId || null,
    lat: o.drop.lat,
    lng: o.drop.lng,
    address: o.drop.address || null,
  }));

  return [...pickups, ...drops].map((s, i) => ({ ...s, index: i, status: "PENDING" }));
}

async function createRoute({ driverId, orders }) {
  const routeId = uuidv4();
  const now = new Date().toISOString();
  const stops = buildStopsFromOrders(orders);

  const routeRef = db().collection("routes").doc(routeId);
  const batch = db().batch();

  batch.set(routeRef, {
    routeId,
    driverId,
    status: "ASSIGNED",
    orderIds: orders.map(o => o.orderId),
    createdAt: now,
    updatedAt: now,
  });

  stops.forEach(s => {
    const stopId = uuidv4();
    const stopRef = routeRef.collection("stops").doc(stopId);
    batch.set(stopRef, {
      stopId,
      ...s,
      createdAt: now,
      updatedAt: now,
    });
  });

  await batch.commit();
  return { routeId };
}

module.exports = { createRoute };

