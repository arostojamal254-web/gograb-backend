const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

// ========== SAFE CREDENTIAL INITIALIZATION ==========
let credential;
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (credentialsJson && credentialsJson !== '{}') {
  const serviceAccount = JSON.parse(credentialsJson);
  credential = admin.credential.cert(serviceAccount);
} else {
  credential = admin.credential.applicationDefault();
}
admin.initializeApp({
  credential,
  databaseURL: 'https://gograb-ke.firebaseio.com',
});

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || 'https://gograb-backend-production.up.railway.app';
const SHORTCODE = '4053477';

// ========== Helper: Send push to multiple tokens ==========
async function sendPushToTokens(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return { successCount: 0, failureCount: 0 };
  const batches = [];
  for (let i = 0; i < tokens.length; i += 500) batches.push(tokens.slice(i, i + 500));
  let successCount = 0, failureCount = 0;
  for (const batch of batches) {
    const message = { notification: { title, body }, data, tokens: batch };
    const response = await admin.messaging().sendEachForMulticast(message);
    successCount += response.successCount;
    failureCount += response.failureCount;
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) console.error(`Failed token ${batch[idx]}: ${resp.error?.message}`);
      });
    }
  }
  return { successCount, failureCount };
}

// ========== STK PUSH ==========
app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { amount, phone, accountRef, desc, TransactionType, orderId, userId, serviceType } = req.body;

    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const password = Buffer.from(`${SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    const tokenResponse = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', { headers: { Authorization: `Basic ${auth}` } });
    const accessToken = tokenResponse.data.access_token;

    const payload = {
      BusinessShortCode: SHORTCODE, Password: password, Timestamp: timestamp,
      TransactionType: TransactionType || 'CustomerPayBillOnline', Amount: amount,
      PartyA: phone, PartyB: SHORTCODE, PhoneNumber: phone,
      CallBackURL: `${BASE_URL}/mpesa/callback`, AccountReference: accountRef, TransactionDesc: desc,
    };
    console.log('STK Push payload:', JSON.stringify(payload, null, 2));
    const stkResponse = await axios.post('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest', payload, { headers: { Authorization: `Bearer ${accessToken}` } });
    console.log('STK Push response:', JSON.stringify(stkResponse.data, null, 2));
    const checkoutRequestID = stkResponse.data.CheckoutRequestID;
    await admin.firestore().collection('pending_mpesa').doc(checkoutRequestID).set({
      amount: Number(amount), orderId: orderId || null, userId: userId || null,
      serviceType: serviceType || 'order', accountRef: accountRef, status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true, checkoutRequestID });
  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data?.errorMessage || error.message });
  }
});

// ========== STK CALLBACK ==========
app.post('/mpesa/callback', async (req, res) => {
  try {
    console.log('📩 Callback received:', JSON.stringify(req.body, null, 2));
    const callback = req.body.Body.stkCallback;
    if (!callback) return res.json({ ResultCode: 1, ResultDesc: 'Invalid body' });
    if (callback.ResultCode === 0) {
      console.log('✅ Payment successful');
      let amount = null, mpesaReceipt = null, phoneNumber = null;
      const items = callback.CallbackMetadata?.Item;
      if (items) {
        for (const item of items) {
          if (item.Name === 'Amount') amount = Number(item.Value);
          if (item.Name === 'MpesaReceiptNumber') mpesaReceipt = item.Value;
          if (item.Name === 'PhoneNumber') phoneNumber = String(item.Value);
        }
      }
      const checkoutRequestID = callback.CheckoutRequestID;
      if (!checkoutRequestID) return res.json({ ResultCode: 0, ResultDesc: 'Success' });
      const pendingRef = admin.firestore().collection('pending_mpesa').doc(checkoutRequestID);
      const pendingDoc = await pendingRef.get();
      if (!pendingDoc.exists) return res.json({ ResultCode: 0, ResultDesc: 'No pending record' });
      const pendingData = pendingDoc.data();
      const orderId = pendingData.orderId, userId = pendingData.userId, serviceType = pendingData.serviceType;
      if (!amount) amount = pendingData.amount;
      if (serviceType === 'topup') {
        if (userId && amount) {
          await admin.firestore().collection('wallets').doc(userId).set({ balance: admin.firestore.FieldValue.increment(amount), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          console.log(`✅ Top‑up: wallet of ${userId} credited with ${amount}`);
        }
        await pendingRef.delete();
        return res.json({ ResultCode: 0, ResultDesc: 'Top‑up processed' });
      }

      // ✅ Correct collection mapping (accommodation → bookings)
      const collectionMap = {
        'order': 'orders',
        'delivery': 'orders_shared',
        'ride': 'rides',
        'parcel': 'parcels',
        'accommodation': 'bookings',     // <-- fixed
        'booking': 'bookings',
        'topup': 'none'
      };
      const primaryCollection = collectionMap[serviceType] || 'orders';

      if (orderId && serviceType !== 'topup') {
        try {
          const updateData = { paymentStatus: 'paid', mpesaReceiptNumber: mpesaReceipt, updatedAt: admin.firestore.FieldValue.serverTimestamp() };

          if (serviceType === 'order' || serviceType === 'delivery') {
            const sourceDoc = await admin.firestore().collection('orders').doc(orderId).get();
            if (sourceDoc.exists && sourceDoc.data().items) updateData.items = sourceDoc.data().items;
            await admin.firestore().collection('orders').doc(orderId).set(updateData, { merge: true });
            await admin.firestore().collection('orders_shared').doc(orderId).set(updateData, { merge: true });
            console.log(`✅ Both orders & orders_shared ${orderId} marked paid`);
          } else if (serviceType === 'accommodation') {
            // Update the booking document (in 'bookings' collection)
            await admin.firestore().collection('bookings').doc(orderId).set(updateData, { merge: true });
            console.log(`✅ Booking ${orderId} marked paid`);

            // Also add booked dates to the property
            const bookingDoc = await admin.firestore().collection('bookings').doc(orderId).get();
            if (bookingDoc.exists) {
              const booking = bookingDoc.data();
              const dates = booking.dates;            // array of 'YYYY-MM-DD'
              const accommodationId = booking.accommodationId;
              if (accommodationId && dates && dates.length) {
                await admin.firestore().collection('accommodations').doc(accommodationId).update({
                  bookedDates: admin.firestore.FieldValue.arrayUnion(dates),
                });
                console.log(`✅ Added booked dates to property ${accommodationId}`);
              }
            }
          } else {
            await admin.firestore().collection(primaryCollection).doc(orderId).set(updateData, { merge: true });
            console.log(`✅ ${primaryCollection} ${orderId} marked paid`);
          }
        } catch (err) {
          console.error(`Failed to update document(s) for ${orderId}:`, err);
        }
      }

      // Wallet credit – skip for accommodation (payment is for the booking, not wallet credit)
      if (userId && amount && serviceType !== 'topup' && serviceType !== 'accommodation') {
        await admin.firestore().collection('wallets').doc(userId).set({ balance: admin.firestore.FieldValue.increment(amount), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        console.log(`✅ Wallet of ${userId} credited with ${amount}`);
      }

      await pendingRef.delete();
    } else {
      console.log('❌ Payment failed/cancelled:', callback.ResultDesc);
      if (callback.CheckoutRequestID) await admin.firestore().collection('pending_mpesa').doc(callback.CheckoutRequestID).delete();
    }
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    console.error('Callback error:', error);
    res.json({ ResultCode: 1, ResultDesc: 'Error' });
  }
});

// ========== WITHDRAWAL endpoints (unchanged) ==========
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, userType, accountDetails } = req.body;
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) return res.status(401).json({ success: false, error: 'Missing auth token' });
    await admin.auth().verifyIdToken(idToken);
    const b2cResult = await initiateB2C(userId, amount, userType, accountDetails);
    if (!b2cResult.success) return res.status(400).json({ success: false, error: b2cResult.error || 'B2C payment failed', details: b2cResult.details || null });
    const withdrawalsSnap = await admin.firestore().collection('withdrawals').where('vendorId', '==', userId).where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(1).get();
    if (!withdrawalsSnap.empty) await withdrawalsSnap.docs[0].ref.update({ status: 'completed', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, message: 'Withdrawal processed' });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/request-withdrawal', async (req, res) => {
  try {
    const { vendorId, amount, phoneNumber } = req.body;
    if (!vendorId || !amount || !phoneNumber) return res.status(400).json({ success: false, message: 'Missing fields' });
    if (amount < 50 || amount > 150000) return res.status(400).json({ success: false, message: 'Amount must be between 50 and 150,000' });
    const b2cResult = await initiateB2C(vendorId, amount, 'vendor', phoneNumber);
    if (!b2cResult.success) return res.status(400).json({ success: false, message: b2cResult.error || 'B2C payment failed' });
    const withdrawalsSnap = await admin.firestore().collection('withdrawals').where('vendorId', '==', vendorId).where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(1).get();
    if (!withdrawalsSnap.empty) await withdrawalsSnap.docs[0].ref.update({ status: 'completed', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, message: 'Withdrawal processed' });
  } catch (error) {
    console.error('Vendor Withdrawal error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/rider-request-withdrawal', async (req, res) => {
  try {
    const { riderId, amount, phoneNumber } = req.body;
    if (!riderId || !amount || !phoneNumber) return res.status(400).json({ success: false, message: 'Missing fields' });
    if (amount < 50 || amount > 150000) return res.status(400).json({ success: false, message: 'Amount must be between 50 and 150,000' });
    const b2cResult = await initiateB2C(riderId, amount, 'rider', phoneNumber);
    if (!b2cResult.success) return res.status(400).json({ success: false, message: b2cResult.error || 'B2C payment failed' });
    const withdrawalsSnap = await admin.firestore().collection('withdrawals').where('vendorId', '==', riderId).where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(1).get();
    if (!withdrawalsSnap.empty) await withdrawalsSnap.docs[0].ref.update({ status: 'completed', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, message: 'Withdrawal processed' });
  } catch (error) {
    console.error('Rider Withdrawal error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

async function initiateB2C(userId, amount, userType, accountDetails) {
  try {
    console.log('Initiating B2C payment...');
    let userPhone = accountDetails;
    if (!userPhone || userPhone.startsWith('4')) {
      const userDoc = await admin.firestore().collection('users').doc(userId).get();
      const userData = userDoc.data() || {};
      userPhone = userData.phone || userData.phoneNumber || accountDetails;
    }
    if (!userPhone || userPhone === '0700000005') return { success: false, error: 'No valid phone number found for user' };
    const cleanPhone = userPhone.replace(/^\+/, '').replace(/^0/, '254');
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    const tokenResponse = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', { headers: { Authorization: `Basic ${auth}` } });
    const accessToken = tokenResponse.data.access_token;
    const b2cPayload = {
      InitiatorName: process.env.MPESA_B2C_INITIATOR_NAME,
      SecurityCredential: process.env.MPESA_B2C_SECURITY_CREDENTIAL,
      CommandID: 'BusinessPayment',
      Amount: amount,
      PartyA: SHORTCODE,
      PartyB: cleanPhone,
      Remarks: `Withdrawal for ${userType}`,
      QueueTimeOutURL: `${BASE_URL}/api/b2c/queue-timeout`,
      ResultURL: `${BASE_URL}/api/b2c/result`,
      Occasion: 'Withdrawal',
    };
    const b2cResponse = await axios.post('https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest', b2cPayload, { headers: { Authorization: `Bearer ${accessToken}` } });
    console.log('B2C response:', JSON.stringify(b2cResponse.data, null, 2));
    if (b2cResponse.data.ResponseCode === '0') return { success: true };
    else return { success: false, error: b2cResponse.data.ResponseDescription || b2cResponse.data.errorMessage, details: b2cResponse.data };
  } catch (error) {
    console.error('B2C error:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.errorMessage || error.message, details: error.response?.data || null };
  }
}

// ========== PUSH NOTIFICATIONS & PROXIMITY ==========
app.post('/api/send-push', async (req, res) => {
  try {
    const { tokens, title, body, data } = req.body;
    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) return res.status(400).json({ success: false, error: 'No tokens provided' });
    const result = await sendPushToTokens(tokens, title, body, data);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Push error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/rider-proximity', async (req, res) => {
  try {
    const { orderId, riderId, riderName, riderLat, riderLng, type, orderType } = req.body;
    if (!orderId || !riderId) return res.status(400).json({ success: false, error: 'Missing orderId or riderId' });
    const collectionMap = { 'delivery': 'orders_shared', 'ride': 'rides', 'parcel': 'parcels' };
    const collection = collectionMap[orderType] || 'orders_shared';
    const orderDoc = await admin.firestore().collection(collection).doc(orderId).get();
    if (!orderDoc.exists) return res.status(404).json({ success: false, error: 'Order not found' });
    const orderData = orderDoc.data();
    const customerId = orderData.userId || orderData.customerId;
    if (!customerId) return res.status(404).json({ success: false, error: 'Customer not found' });
    const fcmDoc = await admin.firestore().collection('fcm_tokens').doc(customerId).get();
    if (!fcmDoc.exists || !fcmDoc.data().token) return res.status(404).json({ success: false, error: 'Customer FCM token not found' });
    const token = fcmDoc.data().token;
    let title = '', body = '';
    const riderFirstName = (riderName || 'Rider').split(' ')[0];
    switch (type) {
      case 'approaching_pickup': title = '🛵 Rider is nearby!'; body = `${riderFirstName} is approaching the pickup location. Be ready!`; break;
      case 'arrived_pickup': title = '📍 Rider has arrived!'; body = `${riderFirstName} has arrived at the pickup point.`; break;
      case 'approaching_dropoff': title = '📦 Almost there!'; body = `${riderFirstName} is about ${orderType === 'ride' ? 'to reach your destination' : 'to deliver your order'}.`; break;
      case 'arrived_dropoff': title = orderType === 'ride' ? '🏁 You have arrived!' : '📬 Delivery arrived!'; body = orderType === 'ride' ? 'Thank you for riding with GoGrab!' : `${riderFirstName} has arrived with your ${orderType === 'parcel' ? 'parcel' : 'order'}!`; break;
      case 'rider_accepted': title = '✅ Rider accepted!'; body = `${riderFirstName} has accepted your ${orderType === 'ride' ? 'ride' : orderType === 'parcel' ? 'parcel' : 'delivery'} and is on the way.`; break;
      case 'rider_en_route': title = '🛵 Rider on the way'; body = `${riderFirstName} is heading to pick up your ${orderType === 'ride' ? 'ride' : orderType === 'parcel' ? 'parcel' : 'order'}.`; break;
      default: title = '📢 Update'; body = `${riderFirstName} has an update for your ${orderType}.`;
    }
    const message = { notification: { title, body }, data: { type: 'proximity', orderId, orderType: orderType || 'delivery', proximityType: type || 'update', riderName: riderName || '', riderId, click_action: 'FLUTTER_NOTIFICATION_CLICK' }, token };
    const response = await admin.messaging().send(message);
    console.log(`Proximity push sent to ${customerId}: ${title} - ${response}`);
    await admin.firestore().collection('proximity_notifications').add({ orderId, customerId, riderId, riderName: riderName || '', type: type || 'update', orderType: orderType || 'delivery', title, body, sentAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true, messageId: response });
  } catch (error) {
    console.error('Proximity push error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/send-push-to-user', async (req, res) => {
  try {
    const { userId, title, body, data } = req.body;
    if (!userId || !title || !body) return res.status(400).json({ success: false, error: 'Missing userId, title, or body' });
    const fcmDoc = await admin.firestore().collection('fcm_tokens').doc(userId).get();
    if (!fcmDoc.exists || !fcmDoc.data().token) return res.status(404).json({ success: false, error: 'User FCM token not found' });
    const message = { notification: { title, body }, data: data || {}, token: fcmDoc.data().token };
    const response = await admin.messaging().send(message);
    console.log(`Push sent to ${userId}: ${title}`);
    res.json({ success: true, messageId: response });
  } catch (error) {
    console.error('Direct push error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== ORDER STATUS LISTENER (unchanged) ==========
function startFCMListener() {
  console.log('Starting FCM order status listener...');
  admin.firestore().collection('orders_shared').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'modified') {
        const order = change.doc.data();
        const previous = change.doc._previousData;
        const newStatus = order.status;
        const oldStatus = previous?.status;
        if (newStatus !== oldStatus && newStatus) {
          console.log(`Order ${change.doc.id}: ${oldStatus} → ${newStatus}`);
          const customerId = order.userId;
          const vendorId = order.vendorId;
          if (customerId) {
            const fcmDoc = await admin.firestore().collection('fcm_tokens').doc(customerId).get();
            if (fcmDoc.exists && fcmDoc.data().token) {
              const riderName = order.riderName || 'Rider';
              let title = '', body = '';
              switch (newStatus) {
                case 'accepted': title = '✅ Order Accepted'; body = `Your order #${change.doc.id.substring(0, 6)} has been accepted.`; break;
                case 'preparing': title = '🍳 Preparing'; body = 'The vendor is preparing your order.'; break;
                case 'readyForPickup': case 'ready_for_pickup': title = '📦 Ready for Pickup'; body = 'Your order is ready and waiting for a rider.'; break;
                case 'riderAssigned': case 'rider_assigned': title = '🛵 Rider Assigned'; body = `${riderName} has been assigned to deliver your order.`; break;
                case 'pickedUp': case 'picked_up': title = '📦 Picked Up'; body = `${riderName} has picked up your order and is on the way.`; break;
                case 'delivering': title = '🚚 On the Way'; body = `${riderName} is delivering your order now.`; break;
                case 'delivered': title = '📬 Delivered!'; body = 'Your order has been delivered. Enjoy!'; break;
                default: return;
              }
              const message = { notification: { title, body }, data: { type: 'delivery', orderId: change.doc.id, status: newStatus, click_action: 'FLUTTER_NOTIFICATION_CLICK' }, token: fcmDoc.data().token };
              try { await admin.messaging().send(message); console.log(`Customer push sent to ${customerId}: ${newStatus}`); } catch (e) { console.error(`Customer push fail: ${e.message}`); }
            }
          }
          if (vendorId && ['accepted', 'preparing', 'readyForPickup', 'ready_for_pickup', 'picked_up', 'delivering', 'delivered'].includes(newStatus)) {
            const vendorFcm = await admin.firestore().collection('fcm_tokens').doc(vendorId).get();
            if (vendorFcm.exists && vendorFcm.data().token) {
              let vendorTitle = '', vendorBody = '';
              const riderName = order.riderName || 'Rider';
              switch (newStatus) {
                case 'accepted': vendorTitle = '🛎️ Order Accepted'; vendorBody = `Order #${change.doc.id.substring(0, 6)} has been accepted.`; break;
                case 'preparing': vendorTitle = '🍳 Preparing'; vendorBody = 'You are now preparing the order.'; break;
                case 'readyForPickup': case 'ready_for_pickup': vendorTitle = '📦 Ready for Pickup'; vendorBody = 'Order is ready and waiting for a rider.'; break;
                case 'picked_up': vendorTitle = '🛵 Picked Up'; vendorBody = `Rider ${riderName} has picked up the order.`; break;
                case 'delivering': vendorTitle = '🚚 On the Way'; vendorBody = `Rider ${riderName} is delivering the order.`; break;
                case 'delivered': vendorTitle = '🏁 Order Delivered'; vendorBody = `Order #${change.doc.id.substring(0, 6)} has been delivered.`; break;
                default: return;
              }
              const vendorMsg = { notification: { title: vendorTitle, body: vendorBody }, data: { type: 'delivery', orderId: change.doc.id, status: newStatus, click_action: 'FLUTTER_NOTIFICATION_CLICK' }, token: vendorFcm.data().token };
              try { await admin.messaging().send(vendorMsg); console.log(`Vendor push sent to ${vendorId}: ${newStatus}`); } catch (e) { console.error(`Vendor push fail: ${e.message}`); }
            }
          }
          const newRiderId = order.riderId;
          const oldRiderId = previous?.riderId;
          if (newRiderId && newRiderId !== oldRiderId) {
            const riderFcm = await admin.firestore().collection('fcm_tokens').doc(newRiderId).get();
            if (riderFcm.exists && riderFcm.data().token) {
              let title = '', body = '';
              if (newStatus === 'rider_assigned' || newStatus === 'accepted') { title = '🛵 New Delivery Assignment'; body = `You have been assigned to deliver order #${change.doc.id.substring(0, 6)}.`; }
              else if (newStatus === 'picked_up') { title = '📦 Pickup Confirmed'; body = 'You have picked up the order. Proceed to delivery.'; }
              else if (newStatus === 'delivering') { title = '🚚 On the Way'; body = 'Start your delivery now.'; }
              else if (newStatus === 'delivered') { title = '🏁 Delivery Completed'; body = 'Order delivered successfully.'; }
              if (title) {
                const message = { notification: { title, body }, data: { type: 'delivery', orderId: change.doc.id, status: newStatus, click_action: 'FLUTTER_NOTIFICATION_CLICK' }, token: riderFcm.data().token };
                try { await admin.messaging().send(message); console.log(`Rider push sent to ${newRiderId}: ${title}`); } catch (e) { console.error(`Rider push fail: ${e.message}`); }
              }
            }
          }
        }
      }
    });
  });
  admin.firestore().collection('rides').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'modified') {
        const ride = change.doc.data();
        const previous = change.doc._previousData;
        const newStatus = ride.status;
        const oldStatus = previous?.status;
        if (newStatus !== oldStatus && newStatus) {
          const customerId = ride.userId;
          if (customerId) {
            const fcmDoc = await admin.firestore().collection('fcm_tokens').doc(customerId).get();
            if (fcmDoc.exists && fcmDoc.data().token) {
              const driverName = ride.driverName || ride.riderName || 'Driver';
              let title = '', body = '';
              switch (newStatus) {
                case 'accepted': case 'driver_assigned': title = '🚗 Driver Found!'; body = `${driverName} has accepted your ride.`; break;
                case 'arrived': title = '📍 Driver Arrived'; body = `${driverName} has arrived at your pickup location.`; break;
                case 'started': title = '🚘 Ride Started'; body = `Your ride with ${driverName} has started.`; break;
                case 'completed': title = '🏁 Ride Complete'; body = 'Thank you for riding with GoGrab!'; break;
                default: return;
              }
              const message = { notification: { title, body }, data: { type: 'ride', orderId: change.doc.id, status: newStatus, click_action: 'FLUTTER_NOTIFICATION_CLICK' }, token: fcmDoc.data().token };
              try { await admin.messaging().send(message); console.log(`Ride push sent to ${customerId}: ${newStatus}`); } catch (e) { console.error(`Ride push fail: ${e.message}`); }
            }
          }
          const driverId = ride.driverId || ride.riderId;
          if (driverId && (newStatus === 'accepted' || newStatus === 'driver_assigned')) {
            const driverFcm = await admin.firestore().collection('fcm_tokens').doc(driverId).get();
            if (driverFcm.exists && driverFcm.data().token) {
              const title = '🚗 Ride Assigned';
              const body = `You have been assigned to a ride from ${ride.pickupAddress || 'pickup location'}.`;
              const message = { notification: { title, body }, data: { type: 'ride', orderId: change.doc.id, status: newStatus, click_action: 'FLUTTER_NOTIFICATION_CLICK' }, token: driverFcm.data().token };
              try { await admin.messaging().send(message); console.log(`Driver assignment push sent to ${driverId}`); } catch (e) { console.error(`Driver push fail: ${e.message}`); }
            }
          }
        }
      }
    });
  });
  admin.firestore().collection('parcels').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'modified') {
        const parcel = change.doc.data();
        const previous = change.doc._previousData;
        const newStatus = parcel.status;
        const oldStatus = previous?.status;
        if (newStatus !== oldStatus && newStatus) {
          const customerId = parcel.userId;
          if (customerId) {
            const fcmDoc = await admin.firestore().collection('fcm_tokens').doc(customerId).get();
            if (fcmDoc.exists && fcmDoc.data().token) {
              const riderName = parcel.riderName || 'Rider';
              let title = '', body = '';
              switch (newStatus) {
                case 'accepted': case 'rider_assigned': title = '📦 Rider Assigned'; body = `${riderName} will handle your parcel delivery.`; break;
                case 'picked_up': title = '📬 Picked Up'; body = `${riderName} has picked up your parcel.`; break;
                case 'delivering': case 'in_transit': title = '📦 In Transit'; body = `Your parcel is on the way with ${riderName}.`; break;
                case 'delivered': title = '🎉 Parcel Delivered'; body = 'Your parcel has been delivered successfully!'; break;
                default: return;
              }
              const message = { notification: { title, body }, data: { type: 'parcel', orderId: change.doc.id, status: newStatus, click_action: 'FLUTTER_NOTIFICATION_CLICK' }, token: fcmDoc.data().token };
              try { await admin.messaging().send(message); console.log(`Parcel push sent to ${customerId}: ${newStatus}`); } catch (e) { console.error(`Parcel push fail: ${e.message}`); }
            }
          }
          const riderId = parcel.riderId;
          if (riderId && (newStatus === 'accepted' || newStatus === 'rider_assigned')) {
            const riderFcm = await admin.firestore().collection('fcm_tokens').doc(riderId).get();
            if (riderFcm.exists && riderFcm.data().token) {
              const title = '📦 Parcel Assignment';
              const body = `You have been assigned a parcel from ${parcel.pickupAddress || 'pickup location'}.`;
              const message = { notification: { title, body }, data: { type: 'parcel', orderId: change.doc.id, status: newStatus, click_action: 'FLUTTER_NOTIFICATION_CLICK' }, token: riderFcm.data().token };
              try { await admin.messaging().send(message); console.log(`Parcel rider assignment push sent to ${riderId}`); } catch (e) { console.error(`Parcel rider push fail: ${e.message}`); }
            }
          }
        }
      }
    });
  });
}

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  startFCMListener();
});