const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://gograb-ke.firebaseio.com',
});

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || 'https://gograb-backend-production.up.railway.app';

// ────────── STK PUSH – stores full order data temporarily ──────────
app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const {
      amount, phone, accountRef, desc,
      serviceData   // full order data sent by the app
    } = req.body;

    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const password = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const tokenResponse = await axios.get(
      'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { headers: { Authorization: `Basic ${auth}` } }
    );

    const accessToken = tokenResponse.data.access_token;

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: process.env.MPESA_TILL || process.env.MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: `${BASE_URL}/mpesa/callback`,
      AccountReference: accountRef,
      TransactionDesc: desc,
    };

    console.log('STK Push payload:', JSON.stringify(payload, null, 2));

    // Store the complete order data temporarily so the callback can create the order
    if (serviceData) {
      await admin.firestore().collection('stk_requests').doc(accountRef).set({
        ...serviceData,
        amount,
        phone,
        accountRef,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`Stored order data for ref ${accountRef}`);
    }

    const stkResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    console.log('STK Push response:', JSON.stringify(stkResponse.data, null, 2));

    res.json({
      success: true,
      checkoutRequestID: stkResponse.data.CheckoutRequestID,
    });
  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.errorMessage || error.message,
    });
  }
});

// ────────── STK CALLBACK – creates order after successful payment ──────────
app.post('/mpesa/callback', async (req, res) => {
  try {
    console.log('📩 Callback received:', JSON.stringify(req.body, null, 2));

    const callback = req.body.Body.stkCallback;
    if (callback && callback.ResultCode === 0) {
      console.log('✅ Payment successful');

      let amount = null;
      let accountRef = null;
      const items = callback.CallbackMetadata?.Item;
      if (items) {
        for (const item of items) {
          if (item.Name === 'Amount') amount = item.Value;
          if (item.Name === 'AccountReference') accountRef = item.Value;
        }
      }

      if (!amount || !accountRef) {
        console.log('⚠️ Missing Amount or AccountReference');
        return res.json({ ResultCode: 0, ResultDesc: 'Success' });
      }

      // Retrieve the stored order data
      const stkRequestDoc = await admin.firestore().collection('stk_requests').doc(accountRef).get();
      if (!stkRequestDoc.exists) {
        console.log(`❌ No pending STK request found for ref ${accountRef}`);
        return res.json({ ResultCode: 0, ResultDesc: 'Success' });
      }

      const orderData = stkRequestDoc.data();
      const type = orderData.type || 'order';   // 'order', 'ride', 'parcel'

      // Build the document depending on the type
      const commonData = {
        ...orderData,
        mpesaReceipt: accountRef,
        paymentStatus: 'paid',
        status: type === 'order' ? 'pending' : (type === 'ride' ? 'pending' : 'pending'),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      delete commonData.accountRef;  // not needed in final document

      let docRef;
      if (type === 'order') {
        docRef = admin.firestore().collection('orders').doc();
        const orderId = docRef.id;
        commonData.id = orderId;
        await docRef.set(commonData);
        // Also create in orders_shared
        const sharedData = {
          id: orderId,
          userId: commonData.userId,
          vendorId: commonData.vendorId,
          vendorName: commonData.vendorName,
          total: commonData.total,
          deliveryFee: commonData.deliveryFee,
          status: 'pending',
          customerName: commonData.customerName,
          customerPhone: commonData.customerPhone,
          deliveryAddress: commonData.deliveryAddress,
          items: commonData.items || [],
          pickupStops: commonData.pickupStops || [],
          deliveryLat: commonData.deliveryLat,
          deliveryLng: commonData.deliveryLng,
          paymentMethod: 'M-Pesa',
          paymentStatus: 'paid',
          mpesaReceipt: accountRef,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await admin.firestore().collection('orders_shared').doc(orderId).set(sharedData);
        console.log(`✅ Order ${orderId} created in orders and orders_shared`);
      } else if (type === 'ride') {
        docRef = admin.firestore().collection('rides').doc();
        commonData.id = docRef.id;
        await docRef.set(commonData);
        console.log(`✅ Ride ${docRef.id} created`);
      } else if (type === 'parcel') {
        docRef = admin.firestore().collection('parcels').doc();
        commonData.id = docRef.id;
        await docRef.set(commonData);
        console.log(`✅ Parcel ${docRef.id} created`);
      }

      // Update wallet balance for the customer
      const userId = commonData.userId;
      if (userId) {
        const walletRef = admin.firestore().collection('wallets').doc(userId);
        await walletRef.set({
          balance: admin.firestore.FieldValue.increment(Number(amount)),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        console.log(`✅ Wallet updated for user ${userId}`);
      }

      // Delete the temporary STK request
      await stkRequestDoc.ref.delete();
    } else {
      console.log('❌ Payment failed/cancelled:', callback?.ResultDesc);
    }

    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    console.error('Callback error:', error);
    res.json({ ResultCode: 1, ResultDesc: 'Error' });
  }
});

// ────────── WITHDRAWAL PROCESSING (unchanged) ──────────
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, userType, withdrawalId } = req.body;

    const b2cResult = await initiateB2C(userId, amount, userType, withdrawalId);
    if (!b2cResult.success) {
      return res.status(400).json({
        success: false,
        error: b2cResult.error || 'B2C payment failed',
        details: b2cResult.details || null,
      });
    }

    if (withdrawalId) {
      await admin.firestore().collection('withdrawals').doc(withdrawalId).update({
        status: 'processed',
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json({ success: true, message: 'Withdrawal processed' });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ────────── B2C Helper (unchanged) ──────────
async function initiateB2C(userId, amount, userType, withdrawalId) {
  try {
    console.log('Initiating B2C payment...');
    console.log(`UserId: ${userId}, Amount: ${amount}, UserType: ${userType}, WithdrawalId: ${withdrawalId}`);

    let userPhone = null;
    if (withdrawalId) {
      const withdrawalDoc = await admin.firestore().collection('withdrawals').doc(withdrawalId).get();
      if (withdrawalDoc.exists) {
        userPhone = withdrawalDoc.data().accountDetails;
      }
    }

    if (!userPhone || userPhone === '0700000005') {
      const userDoc = await admin.firestore().collection('users').doc(userId).get();
      const userData = userDoc.data() || {};
      userPhone = userData.phone || userData.phoneNumber;
    }

    if (!userPhone || userPhone === '0700000005') {
      return { success: false, error: 'No valid phone number found for user' };
    }

    const cleanPhone = userPhone.replace(/^\+/, '').replace(/^0/, '254');

    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const tokenResponse = await axios.get(
      'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { headers: { Authorization: `Basic ${auth}` } }
    );

    const accessToken = tokenResponse.data.access_token;

    const b2cPayload = {
      InitiatorName: process.env.MPESA_B2C_INITIATOR_NAME || 'Arosto',
      SecurityCredential: process.env.MPESA_B2C_SECURITY_CREDENTIAL,
      CommandID: 'BusinessPayment',
      Amount: amount,
      PartyA: process.env.MPESA_B2C_SHORTCODE || process.env.MPESA_SHORTCODE,
      PartyB: cleanPhone,
      Remarks: `Withdrawal for ${userType}`,
      QueueTimeOutURL: `${BASE_URL}/api/b2c/queue-timeout`,
      ResultURL: `${BASE_URL}/api/b2c/result`,
      Occasion: 'Withdrawal',
    };

    const b2cResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
      b2cPayload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    console.log('B2C response:', JSON.stringify(b2cResponse.data, null, 2));

    if (b2cResponse.data.ResponseCode === '0') {
      return { success: true };
    } else {
      return {
        success: false,
        error: b2cResponse.data.ResponseDescription || b2cResponse.data.errorMessage,
        details: b2cResponse.data,
      };
    }
  } catch (error) {
    console.error('B2C error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.errorMessage || error.message,
      details: error.response?.data || null,
    };
  }
}

// ────────── START SERVER ──────────
function startFCMListener() {
  console.log('Starting FCM order status listener...');
  admin.firestore().collection('orders_shared').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'modified') {
        const order = change.doc.data();
        const previous = change.doc._previousData;
        const newStatus = order.status;
        const oldStatus = previous?.status;
        if (newStatus !== oldStatus) {
          console.log(`Order ${change.doc.id} changed from ${oldStatus} to ${newStatus}`);
        }
      }
    });
  });
}

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  startFCMListener();
});