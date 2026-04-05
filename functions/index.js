const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// ========== Mirror orders from partitioned collections ==========
exports.mirrorOrderToGlobal = functions.firestore
  .document('orders_{suffix}/{orderId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const orderId = context.params.orderId;
    await admin.firestore().collection('orders').doc(orderId).set(data);
    console.log(`Mirrored order ${orderId} to global collection`);
  });

exports.updateGlobalOrder = functions.firestore
  .document('orders_{suffix}/{orderId}')
  .onUpdate(async (change, context) => {
    const afterData = change.after.data();
    const orderId = context.params.orderId;
    await admin.firestore().collection('orders').doc(orderId).update(afterData);
    console.log(`Updated global order ${orderId}`);
  });

// ========== Update vendor stats (total and daily) ==========
exports.updateVendorStats = functions.firestore
  .document('orders/{orderId}')
  .onWrite(async (change, context) => {
    const beforeData = change.before.data();
    const afterData = change.after.data();

    let vendorId = null;
    if (afterData) vendorId = afterData.vendorId;
    if (beforeData && !afterData) vendorId = beforeData.vendorId;
    if (!vendorId) return;

    // Recalculate total stats (full scan – safe and simple)
    const snapshot = await admin.firestore()
      .collection('orders')
      .where('vendorId', '==', vendorId)
      .get();
    let totalOrders = 0;
    let totalRevenue = 0;
    let pendingOrders = 0;
    let completedOrders = 0;
    snapshot.forEach(doc => {
      const data = doc.data();
      totalOrders++;
      totalRevenue += data.total || 0;
      const status = data.status;
      if (status === 'pending' || status === 'preparing') pendingOrders++;
      if (status === 'delivered' || status === 'completed') completedOrders++;
    });

    const statsRef = admin.firestore().collection('vendorStats').doc(vendorId);
    await statsRef.set({
      vendorId,
      totalOrders,
      totalRevenue,
      pendingOrders,
      completedOrders,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Update daily stats for the day of the order
    let orderDate = null;
    if (afterData && afterData.createdAt) {
      orderDate = afterData.createdAt.toDate();
    } else if (beforeData && beforeData.createdAt) {
      orderDate = beforeData.createdAt.toDate();
    }
    if (!orderDate) return;

    const startOfDay = new Date(orderDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(orderDate);
    endOfDay.setHours(23, 59, 59, 999);

    const dailyOrdersSnapshot = await admin.firestore()
      .collection('orders')
      .where('vendorId', '==', vendorId)
      .where('createdAt', '>=', startOfDay)
      .where('createdAt', '<=', endOfDay)
      .get();

    let dailyOrders = 0;
    let dailyRevenue = 0;
    dailyOrdersSnapshot.forEach(doc => {
      const data = doc.data();
      dailyOrders++;
      dailyRevenue += data.total || 0;
    });

    const dateKey = `${orderDate.getFullYear()}-${(orderDate.getMonth() + 1).toString().padStart(2, '0')}-${orderDate.getDate().toString().padStart(2, '0')}`;
    const dailyStatsRef = admin.firestore().collection('vendorDailyStats').doc(`${vendorId}_${dateKey}`);
    await dailyStatsRef.set({
      vendorId,
      date: orderDate,
      orders: dailyOrders,
      revenue: dailyRevenue,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });

// ========== Unified Push Notifications ==========
// Send notification when a new order is created (customer to vendor)
exports.onOrderCreated = functions.firestore
  .document('orders/{orderId}')
  .onCreate(async (snap, context) => {
    const order = snap.data();
    const vendorId = order.vendorId;
    if (!vendorId) return;

    const vendorDoc = await admin.firestore().collection('users').doc(vendorId).get();
    const vendorToken = vendorDoc.data()?.fcmToken;
    if (!vendorToken) return;

    const payload = {
      notification: {
        title: 'New Order!',
        body: `Order #${order.id.substring(0,6)} from ${order.customerName}`,
      },
      data: {
        type: 'new_order',
        orderId: order.id,
      },
      token: vendorToken,
    };
    await admin.messaging().send(payload);
  });

// Send notification when order status changes
exports.onOrderStatusUpdate = functions.firestore
  .document('orders/{orderId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    if (before.status === after.status) return;

    const userId = after.userId; // customer
    const riderId = after.riderId;
    const vendorId = after.vendorId;

    // Notify customer of status change
    if (userId) {
      const userDoc = await admin.firestore().collection('users').doc(userId).get();
      const userToken = userDoc.data()?.fcmToken;
      if (userToken) {
        const payload = {
          notification: {
            title: 'Order Update',
            body: `Your order #${after.id.substring(0,6)} is now ${after.status}`,
          },
          data: { type: 'order_status', orderId: after.id, status: after.status },
          token: userToken,
        };
        await admin.messaging().send(payload);
      }
    }

    // Notify rider if assigned and order is ready for pickup
    if (riderId && after.status === 'readyForPickup') {
      const riderDoc = await admin.firestore().collection('users').doc(riderId).get();
      const riderToken = riderDoc.data()?.fcmToken;
      if (riderToken) {
        const payload = {
          notification: {
            title: 'New Job!',
            body: `Order #${after.id.substring(0,6)} ready for pickup.`,
          },
          data: { type: 'new_job', orderId: after.id },
          token: riderToken,
        };
        await admin.messaging().send(payload);
      }
    }
  });

// Send notification for new ride request
exports.onRideCreated = functions.firestore
  .document('rides/{rideId}')
  .onCreate(async (snap, context) => {
    const ride = snap.data();
    // Notify all online riders
    const ridersSnapshot = await admin.firestore()
      .collection('users')
      .where('role', '==', 'rider')
      .where('isOnline', '==', true)
      .get();
    const tokens = ridersSnapshot.docs.map(doc => doc.data().fcmToken).filter(t => t);
    if (tokens.length === 0) return;

    const payload = {
      notification: {
        title: 'New Ride Request',
        body: `Pickup: ${ride.pickupAddress}`,
      },
      data: { type: 'new_ride', rideId: ride.id },
      tokens,
    };
    await admin.messaging().sendEachForMulticast(payload);
  });

// Send notification for new parcel request
exports.onParcelCreated = functions.firestore
  .document('parcels/{parcelId}')
  .onCreate(async (snap, context) => {
    const parcel = snap.data();
    const ridersSnapshot = await admin.firestore()
      .collection('users')
      .where('role', '==', 'rider')
      .where('isOnline', '==', true)
      .get();
    const tokens = ridersSnapshot.docs.map(doc => doc.data().fcmToken).filter(t => t);
    if (tokens.length === 0) return;

    const payload = {
      notification: {
        title: 'New Parcel Request',
        body: `Parcel: ${parcel.description}`,
      },
      data: { type: 'new_parcel', parcelId: parcel.id },
      tokens,
    };
    await admin.messaging().sendEachForMulticast(payload);
  });