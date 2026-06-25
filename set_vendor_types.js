const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // adjust path if needed

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function setVendorTypes() {
  const usersRef = db.collection('users');
  const snapshot = await usersRef.where('role', '==', 'vendor').get();

  if (snapshot.empty) {
    console.log('No vendors found.');
    return;
  }

  const batch = db.batch();
  let count = 0;
  snapshot.forEach(doc => {
    const data = doc.data();
    // Only set if vendorType doesn't already exist
    if (!data.vendorType) {
      batch.update(doc.ref, { vendorType: 'both' }); // default to both
      count++;
    }
  });

  await batch.commit();
  console.log(`Updated ${count} vendors with vendorType = 'both'.`);
}

setVendorTypes().then(() => process.exit());