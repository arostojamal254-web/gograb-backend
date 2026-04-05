const redis = require("../shared/redis");
const { runWaveDispatch } = require("../modules/dispatch/wave.dispatch.service");

const ZONE = process.argv[2] || "nairobi";
const STREAM = `stream:dispatch:${ZONE}`;
const GROUP = "dispatch-wave-workers";
const CONSUMER = `consumer-${Math.random().toString(16).slice(2)}`;

async function ensureGroup() {
  try {
    await redis.call("XGROUP", "CREATE", STREAM, GROUP, "$", "MKSTREAM");
  } catch (e) {
    const msg = String(e?.message || e);
    if (!msg.includes("BUSYGROUP")) throw e;
  }
}

function parseFields(arr) {
  const obj = {};
  for (let i = 0; i < arr.length; i += 2) {
    obj[String(arr[i])] = arr[i + 1];
  }
  return obj;
}

async function main() {
  await ensureGroup();
  console.log(`[wave.worker] zone=${ZONE} stream=${STREAM} group=${GROUP} consumer=${CONSUMER}`);

  while (true) {
    try {
      const resp = await redis.call(
        "XREADGROUP",
        "GROUP",
        GROUP,
        CONSUMER,
        "COUNT",
        "1",
        "BLOCK",
        "5000",
        "STREAMS",
        STREAM,
        ">"
      );

      if (!resp) continue;

      for (const s of resp) {
        const msgs = s[1] || [];
        for (const m of msgs) {
          const id = m[0];
          const fields = parseFields(m[1] || []);

          const orderId = String(fields.orderId || "");
          const zoneId = String(fields.zoneId || ZONE);
          const pickupLat = fields.pickupLat == null ? null : Number(fields.pickupLat);
          const pickupLng = fields.pickupLng == null ? null : Number(fields.pickupLng);

          if (!orderId || pickupLat == null || pickupLng == null) {
            console.log("[wave.worker] bad job", { id, fields });
            await redis.call("XACK", STREAM, GROUP, id);
            continue;
          }

          console.log("[wave.worker] job", { id, orderId, zoneId, pickupLat, pickupLng });

          const r = await runWaveDispatch({ orderId, zoneId, pickupLat, pickupLng });
          console.log("[wave.worker] done", { orderId, result: r });

          await redis.call("XACK", STREAM, GROUP, id);
        }
      }
    } catch (e) {
      console.log("[wave.worker] error:", e?.message || e);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
