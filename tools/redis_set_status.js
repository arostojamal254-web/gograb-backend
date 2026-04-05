const redis = require("../src/shared/redis");

async function main() {
  const key = "drivers:status";
  const pairs = [
    ["DRIVER_123", "ONLINE"],
    ["driver1", "ONLINE"]
  ];

  for (const [id, st] of pairs) {
    await redis.call("HSET", key, String(id), String(st));
  }

  const all = await redis.call("HGETALL", key);
  console.log("HGETALL drivers:status =>", all);

  process.exit(0);
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
