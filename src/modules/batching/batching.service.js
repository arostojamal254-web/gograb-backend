const { fetchReadyOrders, markOrdersBatched } = require("./order.pool");
const { createRoute } = require("./route.builder");
const { findCandidateDrivers, upsertDriverState } = require("../drivers/driver.service");

const { admin, db } = require("../../shared/firestore");
/**
 * MVP:
 * - fetch ready orders
 * - take up to maxOrders
 * - pick driver nearest to first pickup
 * - create route assigned to driver
 * - mark orders batched
 */
async function runBatchingOnce({ maxOrders = 3 }) {
  const ready = await fetchReadyOrders(50);
  if (ready.length === 0) return { ok: true, message: "No READY orders" };

  const orders = ready.slice(0, maxOrders);

  const firstPickup = orders[0].pickup;
  const drivers = await findCandidateDrivers({ lat: firstPickup.lat, lng: firstPickup.lng, limit: 5 });
  if (!drivers.length) return { ok: false, error: "NO_DRIVERS" };

  const driver = drivers[0];

  // lock driver busy immediately
  await upsertDriverState(driver.driverId, { status: "BUSY" });

  const { routeId } = await createRoute({ driverId: driver.driverId, orders });
  await markOrdersBatched(orders.map(o => o.orderId), routeId);

  return { ok: true, routeId, driverId: driver.driverId, orderIds: orders.map(o => o.orderId) };
}

module.exports = { runBatchingOnce };

