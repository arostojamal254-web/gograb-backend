const admin = require('firebase-admin');
const fs = require('fs');
const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL: 'https://gograb-ke.firebaseio.com' });

const firestore = admin.firestore();

async function fixOrders() {
  const ordersSnap = await firestore.collection('orders').get();
  for (const doc of ordersSnap.docs) {
    const data = doc.data();
    if (!data.items || data.items.length === 0) {
      // Try to copy items from orders_shared
      const sharedDoc = await firestore.collection('orders_shared').doc(doc.id).get();
      if (sharedDoc.exists && sharedDoc.data().items) {
        await doc.ref.update({ items: sharedDoc.data().items });
        console.log(`✅ Fixed order ${doc.id}`);
      } else {
        console.log(`⚠️ Cannot fix ${doc.id} – no items in shared either`);
      }
    }
  }
  console.log('Done');
}

fixOrders().catch(console.error).finally(() => process.exit());