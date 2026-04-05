const redis = require("../../shared/redis");
const { geoKey, hbKey, driverStateKey } = require("../../shared/redis.keys");

/**
 * Get nearest driverIds by GEOSEARCH, then filter by heartbeat OR driver state.
 */
async function findCandidateDrivers({
  zoneId = "nairobi",
  lat,
  lng,
  radiusKm = 5,
  count = 30,
  requireOnline = true,
}) {
  const latitude = Number(lat);
  const longitude = Number(lng);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) return [];

  const zid = String(zoneId || "nairobi").trim().toLowerCase();

  // Always use shared key builder
  const key = geoKey(zid);

  const ids = await redis.call(
    "GEOSEARCH",
    key,
    "FROMLONLAT",
    String(longitude),
    String(latitude),
    "BYRADIUS",
    String(radiusKm),
    "km",
    "ASC",
    "COUNT",
    String(count)
  );

  const driverIds = Array.isArray(ids) ? ids : [];
  if (!driverIds.length) return [];

  if (!requireOnline) return driverIds;

  // check heartbeat
  const hbKeys = driverIds.map((id) => hbKey(id));
  const hbVals = hbKeys.length ? await redis.call("MGET", ...hbKeys) : [];

  const onlineIds = [];

  for (let i = 0; i < driverIds.length; i++) {
    const id = driverIds[i];

    const hasHeartbeat = hbVals?.[i] != null;

    // heartbeat alone is enough proof of presence
    if (hasHeartbeat) {
      onlineIds.push(id);
      continue;
    }

    // fallback to driver state
    const st = String(
      (await redis.call("HGET", driverStateKey(id), "status")) ?? ""
    ).toUpperCase();

    if (st === "ONLINE" || st === "AVAILABLE" || st === "WORKING") {
      onlineIds.push(id);
    }
  }

  return onlineIds;
}

/**
 * Remove drivers already busy with another order.
 */
async function filterFreeDrivers(driverIds) {
  if (!driverIds?.length) return [];

  const free = [];

  for (const id of driverIds) {
    const state = await redis.call("HGETALL", driverStateKey(id));

    const obj = {};

    if (Array.isArray(state)) {
      for (let i = 0; i < state.length; i += 2) {
        obj[state[i]] = state[i + 1];
      }
    }

    const st = String(obj.status || "").toUpperCase();
    const currentOrderId = String(obj.currentOrderId || "");

    // Accept ONLINE / AVAILABLE / WORKING
    if (st && !["ONLINE", "AVAILABLE", "WORKING"].includes(st)) continue;

    // Skip if already serving another order
    if (currentOrderId) continue;

    free.push(id);
  }

  return free;
}

module.exports = {
  findCandidateDrivers,
  filterFreeDrivers,
};