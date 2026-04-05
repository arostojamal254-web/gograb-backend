const redis = require("./src/shared/redis");
async function main(){
  const id = process.argv[2] || "DRIVER_123";
  const now = Math.floor(Date.now()/1000);

  // Put driver in GEO + lastSeen fresh
  await redis.call("GEOADD","drivers:geo","36.8219","-1.2921",id);
  await redis.call("ZADD","drivers:lastSeen",String(now),id);
  await redis.call("SET","driver:hb:"+id,String(now),"EX","10");
  await redis.call("HSET","drivers:status",id,"ONLINE");
  console.log("Added driver fresh:", id);

  // Make driver OFFLINE by setting lastSeen very old and deleting heartbeat
  await redis.call("ZADD","drivers:lastSeen",String(now-9999),id);
  await redis.call("DEL","driver:hb:"+id);
  console.log("Made driver stale/offline:", id);

  // show geo radius now (should still include driver until cleanup runs)
  const before = await redis.call("GEORADIUS","drivers:geo","36.8219","-1.2921","5","km");
  console.log("BEFORE cleanup GEORADIUS:", before);

  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
