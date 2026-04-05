const fs = require("fs");
const path = require("path");
const redis = require("../src/shared/redis");

async function main(){
  const driverId = process.argv[2] || "DRIVER_123";
  const now = Math.floor(Date.now()/1000);

  // Ensure driver exists in GEO + lastSeen
  await redis.call("GEOADD","drivers:geo","36.8219","-1.2921",driverId);
  await redis.call("ZADD","drivers:lastSeen",String(now),driverId);
  await redis.call("SET","driver:hb:"+driverId,String(now),"EX","10");
  await redis.call("HSET","drivers:status",driverId,"ONLINE");

  console.log("SETUP OK: added driver to GEO + lastSeen + hb");

  // Simulate offline: delete heartbeat + set lastSeen old (now-9999)
  await redis.call("DEL","driver:hb:"+driverId);
  await redis.call("ZADD","drivers:lastSeen",String(now-9999),driverId);

  console.log("SIMULATE OFFLINE OK: hb deleted, lastSeen set old");

  const lua = fs.readFileSync(path.join(__dirname,"..","src","lua","driver_cleanup.lua"),"utf8");

  // Run cleanup ONCE with ttl=10s batch=2000
  const resp = await redis.call("EVAL", lua, "3", "drivers:geo","drivers:lastSeen","drivers:status", String(now), "10", "2000");

  console.log("CLEANUP RESULT (resp):", resp);

  // Verify driver removed from GEO
  const near = await redis.call("GEORADIUS","drivers:geo","36.8219","-1.2921","5","km");
  console.log("AFTER GEORADIUS 5km:", near);

  process.exit(0);
}
main().catch(e=>{ console.error("ERROR:", e?.message||e); process.exit(1); });
