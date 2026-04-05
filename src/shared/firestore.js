// src/shared/firestore.js
const admin = require("firebase-admin");

// Initialize once (safe across hot reloads)
if (!admin.apps.length) {
  // Uses GOOGLE_APPLICATION_CREDENTIALS if set, or default credentials if available
  admin.initializeApp();
}

const db = admin.firestore();

module.exports = { admin, db };
