const redis = require("./src/shared/redis");
async function main(){
  const driverId = process.argv[2] || "DRIVER_123";
  const orderId  = process.argv[3] || "order1";
  const key = `offer:driver:${driverId}:inbox`;
  await redis.call("LPUSH", key, orderId);
  console.log("Pushed offer:", { key, orderId });
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
