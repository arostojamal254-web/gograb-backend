const redis = require("./src/shared/redis");
async function main(){
  const driverId = process.argv[2] || "DRIVER_123";
  await redis.call("DEL", "driver:hb:" + driverId);
  console.log("Deleted heartbeat for", driverId);
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
