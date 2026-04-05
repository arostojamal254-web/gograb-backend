const redis = require("../../shared/redis");

const { admin, db } = require("../../shared/firestore");
const GEO_KEY = "drivers:geo";
const STATUS_KEY = "drivers:status";

/**
 * Find nearest drivers using Redis GEOSEARCH (fast).
 * Returns array of driverIds (nearest first).
 */
async function findNearestDrivers({ lat, lng, radiusKm = 5, count = 20 }) {
  const latitude = Number(lat);
  const longitude = Number(lng);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) return [];

  // GEOSEARCH key FROMLONLAT lng lat BYRADIUS radius km ASC COUNT n
  const ids = await redis.call(
    "GEOSEARCH",
    GEO_KEY,
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

  return Array.isArray(ids) ? ids : [];
}

/**
 * Returns first driverId that is "ONLINE" or "available" (case-insensitive),
 * else null.
 */
async function pickOnlineDriver(driverIds) {
  if (!driverIds?.length) return null;

  // HMGET statuses in one roundtrip
  const statuses = await redis.hmget(STATUS_KEY, ...driverIds);

  for (let i = 0; i < driverIds.length; i++) {
    const st = String(statuses?.[i] ?? "").toUpperCase();
    if (st === "ONLINE" || st === "AVAILABLE") return driverIds[i];
  }
  return null;
}

module.exports = { findNearestDrivers, pickOnlineDriver };



