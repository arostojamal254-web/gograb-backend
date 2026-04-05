// AUTOMATIC DISPATCHER WORKER (NO COMPOSITE INDEX REQUIRED)
// - claims queued jobs atomically
// - marks order as dispatched
// - safe for multiple workers (uses transaction claim)

const admin = require("firebase-admin");
require("dotenv").config();

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();

const WORKER_ID =
  process.env.DISPATCH_WORKER_ID ||
  `worker_${process.pid}_${Math.random().toString(16).slice(2)}`;

const POLL_MS = Number(process.env.DISPATCH_POLL_MS || 2000);
const CLAIM_TIMEOUT_MS = Number(process.env.DISPATCH_CLAIM_TIMEOUT_MS || 120000); // 2 min
const BATCH_LIMIT = Number(process.env.DISPATCH_BATCH_LIMIT || 5);

function nowMs() {
  return Date.now();
}

async function claimOneJob() {
  // IMPORTANT: no orderBy() -> avoids composite index requirement
  const q = await db
    .collection("dispatch_queue")
    .where("status", "==", "queued")
    .limit(1)
    .get();

  if (q.empty) return null;

  const doc = q.docs[0];
  const ref = doc.ref;

  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;

    const d = snap.data() || {};
    if (d.status !== "queued") return null;

    tx.set(
      ref,
      {
        status: "processing",
        claimedBy: WORKER_ID,
        claimedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { id: snap.id, data: d };
  });

  return claimed;
}

async function requeueStuckJobs() {
  const cutoff = nowMs() - CLAIM_TIMEOUT_MS;

  const stuck = await db
    .collection("dispatch_queue")
    .where("status", "==", "processing")
    .get();

  const batch = db.batch();
  let n = 0;

  for (const d of stuck.docs) {
    const data = d.data() || {};
    const claimedAt = data.claimedAt?.toDate?.() ? data.claimedAt.toDate().getTime() : null;
    if (claimedAt && claimedAt < cutoff) {
      batch.set(
        d.ref,
        {
          status: "queued",
          requeuedAt: admin.firestore.FieldValue.serverTimestamp(),
          requeuedReason: "claim_timeout",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      n++;
    }
  }

  if (n > 0) await batch.commit();
  return n;
}

async function dispatchJob(jobId, jobData) {
  const orderId = jobData.orderId || jobId;

  // ---- PLACEHOLDER: YOUR REAL DISPATCH LOGIC GOES HERE ----
  // For now we mark "dispatched" immediately.
  // --------------------------------------------------------

  const queueRef = db.collection("dispatch_queue").doc(jobId);
  const orderRef = db.collection("orders_shared").doc(orderId);

  await db.runTransaction(async (tx) => {
    const qSnap = await tx.get(queueRef);
    if (!qSnap.exists) return;

    const qd = qSnap.data() || {};
    if (qd.status !== "processing") return;
    if (qd.claimedBy !== WORKER_ID) return;

    tx.set(
      queueRef,
      {
        status: "dispatched",
        dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      orderRef,
      {
        dispatchStatus: "dispatched",
        dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
        dispatchWorkerId: WORKER_ID,
        dispatchUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

let running = false;

async function tick() {
  if (running) return;
  running = true;

  try {
    await requeueStuckJobs();

    for (let i = 0; i < BATCH_LIMIT; i++) {
      const job = await claimOneJob();
      if (!job) break;

      console.log(`[${WORKER_ID}] claimed job: ${job.id}`);
      await dispatchJob(job.id, job.data);
      console.log(`[${WORKER_ID}] dispatched job: ${job.id}`);
    }
  } catch (e) {
    console.error(`[${WORKER_ID}] tick error:`, e?.stack || e);
  } finally {
    running = false;
  }
}

console.log(`DISPATCH WORKER STARTED: ${WORKER_ID}`);
setInterval(tick, POLL_MS);
tick();
