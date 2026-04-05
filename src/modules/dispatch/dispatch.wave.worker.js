const redis = require("../../shared/redis");
const { runWaveDispatch } = require("./wave.dispatch.service");

const ZONE = process.argv[2] || "nairobi";
const STREAM = `stream:dispatch:${ZONE}`;
const GROUP = "dispatch-wave-workers";
const CONSUMER = `consumer-${Math.random().toString(16).slice(2)}`;

async function ensureGroup() {
  try {
    await redis.call("XGROUP","CREATE",STREAM,GROUP,"$","MKSTREAM");
  } catch (e) {
    if (!String(e?.message || "").includes("BUSYGROUP")) throw e;
  }
}

function parseFields(arr){
  const obj = {};
  for(let i=0;i<arr.length;i+=2){
    obj[arr[i]] = arr[i+1];
  }
  return obj;
}

async function main(){

  await ensureGroup();

  console.log("[wave.worker] zone="+ZONE+" stream="+STREAM);

  while(true){

    const resp = await redis.call(
      "XREADGROUP",
      "GROUP",GROUP,CONSUMER,
      "COUNT","1",
      "BLOCK","5000",
      "STREAMS",STREAM,">"
    );

    if(!resp) continue;

    for(const s of resp){

      const msgs = s[1] || [];

      for(const m of msgs){

        const id = m[0];
        const fields = parseFields(m[1] || []);

        const orderId = String(fields.orderId || "");
        const zoneId = String(fields.zoneId || ZONE);
        const pickupLat = Number(fields.pickupLat);
        const pickupLng = Number(fields.pickupLng);

        if(!orderId || Number.isNaN(pickupLat) || Number.isNaN(pickupLng)){
          await redis.call("XACK",STREAM,GROUP,id);
          continue;
        }

        console.log("[wave.worker] job",orderId);

        const r = await runWaveDispatch({
          orderId,
          zoneId,
          pickupLat,
          pickupLng
        });

        console.log("[wave.worker] done",r);

        await redis.call("XACK",STREAM,GROUP,id);
      }
    }
  }
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});
