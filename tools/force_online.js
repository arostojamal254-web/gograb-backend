const redis = require("../src/shared/redis");
async function main(){
  await redis.call("HSET","drivers:status","DRIVER_123","ONLINE");
  await redis.call("HSET","drivers:status","driver1","ONLINE");
  console.log("OK drivers:status =>", await redis.call("HGETALL","drivers:status"));
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
