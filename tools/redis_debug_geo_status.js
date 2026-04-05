const redis = require("../src/shared/redis");

async function main() {
  const lng = Number(process.argv[2] ?? 36.8219);
  const lat = Number(process.argv[3] ?? -1.2921);

  const keys = await redis.call("KEYS", "drivers:geo*");
  console.log("KEYS drivers:geo* =>", keys);

  const pos = await redis.call("GEOPOS", "drivers:geo", "DRIVER_123");
  console.log("GEOPOS drivers:geo DRIVER_123 =>", pos);

  const near = await redis.call("GEORADIUS", "drivers:geo", String(lng), String(lat), "5", "km");
  console.log("GEORADIUS drivers:geo (5km) =>", near);

  if (near?.length) {
    const statuses = await redis.call("HMGET", "drivers:status", ...near);
    console.log("HMGET drivers:status =>", statuses);
  } else {
    console.log("No drivers returned from GEO search");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
