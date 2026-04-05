const fs = require("fs");
const path = require("path");
const redis = require("../shared/redis");

const GEO_KEY = process.env.GEO_KEY || "drivers:geo";
const LASTSEEN_KEY = process.env.LASTSEEN_KEY || "drivers:lastSeen";
const STATUS_KEY = process.env.STATUS_KEY || "drivers:status";

const TTL_SEC = Number(process.env.TTL_SEC || 10);
const BATCH = Number(process.env.BATCH || 2000);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 2000);

const LUA = fs.readFileSync(path.join(__dirname, "..", "lua", "driver_cleanup.lua"), "utf8");

async function runOnce() {
  const nowSec = Math.floor(Date.now() / 1000);

  const resp = await redis.call(
    "EVAL",
    LUA,
    "3",
    GEO_KEY,
    LASTSEEN_KEY,
    STATUS_KEY,
    String(nowSec),
    String(TTL_SEC),
    String(BATCH)
  );

  const removed = Number(resp?.[0] || 0);
  if (removed > 0) {
    const ids = resp.slice(1);
    console.log(`[cleanup.fast] removed=${removed} ids=${ids.join(",")}`);
  }
}

async function main() {
  console.log(`[cleanup.fast] start GEO_KEY=${GEO_KEY} LASTSEEN_KEY=${LASTSEEN_KEY} TTL_SEC=${TTL_SEC} INTERVAL_MS=${INTERVAL_MS} BATCH=${BATCH}`);
  while (true) {
    try { await runOnce(); } catch (e) { console.error("[cleanup.fast] error:", e?.message || e); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
