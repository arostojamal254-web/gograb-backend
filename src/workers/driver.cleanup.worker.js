/**
 * Driver Cleanup Worker
 * - Removes drivers from Redis GEO when they stop sending heartbeats (driver:hb:{driverId} missing)
 *
 * Run:
 *   node .\src\workers\driver.cleanup.worker.js
 *
 * Optional env:
 *   CLEANUP_INTERVAL_MS=5000   (default 5000)
 *   GEO_KEY=drivers:geo        (default drivers:geo)
 *   HB_PREFIX=driver:hb:       (default driver:hb:)
 *   STATUS_KEY=drivers:status  (default drivers:status)
 *   MARK_OFFLINE=1             (default 1) -> writes OFFLINE into drivers:status
 */

const redis = require("../shared/redis");

const GEO_KEY = process.env.GEO_KEY || "drivers:geo";
const HB_PREFIX = process.env.HB_PREFIX || "driver:hb:";
const STATUS_KEY = process.env.STATUS_KEY || "drivers:status";

const INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 5000);
const MARK_OFFLINE = String(process.env.MARK_OFFLINE ?? "1") === "1";

async function scanOnce() {
  let cursor = "0";
  let checked = 0;
  let removed = 0;

  do {
    // ZSCAN drivers:geo cursor COUNT 200
    const resp = await redis.call("ZSCAN", GEO_KEY, cursor, "COUNT", "200");
    cursor = String(resp?.[0] ?? "0");

    const arr = resp?.[1] || [];
    if (!Array.isArray(arr) || arr.length === 0) continue;

    // ZSCAN returns [member1, score1, member2, score2, ...]
    const ids = [];
    for (let i = 0; i < arr.length; i += 2) {
      const member = arr[i];
      if (member) ids.push(String(member));
    }

    if (!ids.length) continue;

    checked += ids.length;

    // Build heartbeat keys and MGET
    const hbKeys = ids.map((id) => HB_PREFIX + id);
    const hbVals = await redis.call("MGET", ...hbKeys);

    const offline = [];
    for (let i = 0; i < ids.length; i++) {
      // If heartbeat key missing => offline
      if (hbVals?.[i] == null) offline.push(ids[i]);
    }

    if (offline.length) {
      // Remove offline drivers from GEO
      await redis.call("ZREM", GEO_KEY, ...offline);
      removed += offline.length;

      // Optionally mark OFFLINE in status hash
      if (MARK_OFFLINE) {
        // HSET drivers:status driverId OFFLINE ...
        const args = [];
        for (const id of offline) {
          args.push(id, "OFFLINE");
        }
        await redis.call("HSET", STATUS_KEY, ...args);
      }
    }
  } while (cursor !== "0");

  return { checked, removed };
}

async function main() {
  console.log(`[driver.cleanup] starting | GEO_KEY=${GEO_KEY} HB_PREFIX=${HB_PREFIX} STATUS_KEY=${STATUS_KEY} interval=${INTERVAL_MS}ms`);

  // loop forever
  while (true) {
    try {
      const r = await scanOnce();
      if (r.removed > 0) {
        console.log(`[driver.cleanup] checked=${r.checked} removed=${r.removed}`);
      }
    } catch (e) {
      console.error("[driver.cleanup] error:", e?.message || e);
    }
    await new Promise((res) => setTimeout(res, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
