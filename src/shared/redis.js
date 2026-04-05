const Redis = require("ioredis");

const { admin, db } = require('./firestore');
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on("error", (e) => console.error("[redis] error:", e?.message || e));
redis.on("connect", () => console.log("[redis] connected"));

module.exports = redis;


