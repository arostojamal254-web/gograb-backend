const admin = require('firebase-admin');
const axios = require('axios');
require('dotenv').config();

// Initialize Firebase Admin if not already
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

const apiKey = process.env.GOOGLE_MAPS_API_KEY;

async function geocodeAddress(address) {
  if (!address) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  try {
    const response = await axios.get(url);
    if (response.data.status === 'OK') {
      const location = response.data.results[0].geometry.location;
      return { lat: location.lat, lng: location.lng };
    }
  } catch (e) {
    console.error(`Geocoding error for "${address}":`, e.message);
  }
  return null;
}

async function updateVendors() {
  const snapshot = await db.collection('vendors').get();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    // Skip if already has coordinates
    if (data.lat != null && data.lng != null) {
      console.log(`Vendor ${doc.id} already has coordinates`);
      continue;
    }
    const address = data.address;
    if (!address) {
      console.log(`Vendor ${doc.id} has no address`);
      continue;
    }
    console.log(`Geocoding vendor ${doc.id}: "${address}"`);
    const coords = await geocodeAddress(address);
    if (coords) {
      await doc.ref.update(coords);
      console.log(`Updated vendor ${doc.id} with lat ${coords.lat}, lng ${coords.lng}`);
    } else {
      console.log(`Could not geocode vendor ${doc.id}`);
    }
  }
  console.log('Done');
}

updateVendors().catch(console.error);