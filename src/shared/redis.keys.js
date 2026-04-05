function geoKey(zoneId) {
  return `drivers:geo:${String(zoneId || "nairobi").trim().toLowerCase()}`;
}

function hbKey(driverId) {
  return `driver:hb:${String(driverId)}`;
}

function driverStateKey(driverId) {
  return `driver:state:${String(driverId)}`;
}

function tripLockKey(tripId) {
  return `trip:lock:${String(tripId)}`;
}

function driverLockKey(driverId) {
  return `driver:lock:${String(driverId)}`;
}

function tripOfferDriversKey(tripId) {
  return `offer:trip:${String(tripId)}:drivers`;
}

function tripOfferTtlKey(tripId) {
  return `offer:trip:${String(tripId)}:ttl`;
}

function driverInboxKey(driverId) {
  return `offer:driver:${String(driverId)}:inbox`;
}

function offersStreamKey(zoneId) {
  return `stream:dispatch:${String(zoneId || "nairobi").trim().toLowerCase()}`;
}

module.exports = {
  geoKey,
  hbKey,
  driverStateKey,
  tripLockKey,
  driverLockKey,
  tripOfferDriversKey,
  tripOfferTtlKey,
  driverInboxKey,
  offersStreamKey,
};