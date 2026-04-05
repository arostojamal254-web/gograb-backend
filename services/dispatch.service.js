const admin = require('firebase-admin')
const geofire = require('geofire-common')

// ✅ ensure Firebase Admin is initialized even when this module is required directly
if (!admin.apps.length) {
  admin.initializeApp()
}

const db = admin.firestore()
const SEARCH_RADIUS = 5000 // meters

async function geoQuery(lat, lng) {
  const center = [lat, lng]
  const bounds = geofire.geohashQueryBounds(center, SEARCH_RADIUS)

  const snaps = await Promise.all(
    bounds.map(b =>
      db.collection('drivers').orderBy('geohash').startAt(b[0]).endAt(b[1]).get()
    )
  )

  const drivers = []
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const d = doc.data()
      if (!d) continue
      if (d.status !== 'available') continue
      if (d.lat === undefined || d.lng === undefined) continue

      const distanceMeters = geofire.distanceBetween([lat, lng], [d.lat, d.lng]) * 1000
      if (distanceMeters <= SEARCH_RADIUS) {
        drivers.push({ id: doc.id, lat: d.lat, lng: d.lng, distance: distanceMeters })
      }
    }
  }

  return drivers
}

function nearestDrivers(drivers) {
  return drivers.sort((a, b) => a.distance - b.distance)
}

async function assignDriver(orderId, driverId) {
  const orderRef = db.collection('orders_shared').doc(orderId)
  const driverRef = db.collection('drivers').doc(driverId)

  await db.runTransaction(async (tx) => {
    const [orderDoc, driverDoc] = await Promise.all([tx.get(orderRef), tx.get(driverRef)])
    if (!orderDoc.exists) throw new Error('Order not found')
    if (!driverDoc.exists) throw new Error('Driver not found')

    const driver = driverDoc.data()
    if (!driver || driver.status !== 'available') throw new Error('Driver busy')

    tx.update(orderRef, { driverId, dispatchStatus: 'assigned' })
    tx.update(driverRef, { status: 'busy' })
  })
}

async function dispatchOrder(orderId, pickupLat, pickupLng) {
  const drivers = await geoQuery(pickupLat, pickupLng)
  if (!drivers.length) throw new Error('No drivers nearby')
  const best = nearestDrivers(drivers)[0]
  await assignDriver(orderId, best.id)
  return best.id
}

module.exports = { dispatchOrder }
