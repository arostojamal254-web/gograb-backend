const redis = require("../src/shared/redis");

async function main(){
  const now = Math.floor(Date.now()/1000);
  const ttl = 10;
  const batch = 2000;

  // make driver offline (so cleanup has something to remove)
  const driverId = "DRIVER_123";
  await redis.call("GEOADD","drivers:geo","36.8219","-1.2921",driverId);
  await redis.call("ZADD","drivers:lastSeen",String(now-9999),driverId);
  await redis.call("DEL","driver:hb:"+driverId);
  await redis.call("HSET","drivers:status",driverId,"ONLINE");

  // --- A) Try Lua EVAL and PRINT the exact compile error ---
  const lua = `
local ids = redis.call("ZRANGEBYSCORE","drivers:lastSeen","-inf",${now-ttl},"LIMIT",0,${batch})
if (not ids) or (#ids == 0) then return {0} end
redis.call("ZREM","drivers:geo",unpack(ids))
redis.call("ZREM","drivers:lastSeen",unpack(ids))
local args={}
for i=1,#ids do table.insert(args,ids[i]); table.insert(args,"OFFLINE") end
redis.call("HSET","drivers:status",unpack(args))
local out={#ids}
for i=1,#ids do table.insert(out,ids[i]) end
return out
`;

  try{
    const r = await redis.call("EVAL", lua, "0");
    console.log("LUA OK:", r);
  } catch(e){
    console.log("LUA ERROR (exact):", e?.message || e);

    // --- B) FAST NON-LUA fallback (still 0 scans, uses lastSeen index) ---
    const cutoff = now - ttl;
    const ids = await redis.call("ZRANGEBYSCORE","drivers:lastSeen","-inf",String(cutoff),"LIMIT","0",String(batch));
    console.log("FALLBACK ids:", ids);

    if (ids && ids.length){
      await redis.call("ZREM","drivers:geo",...ids);
      await redis.call("ZREM","drivers:lastSeen",...ids);

      const args=[];
      for (const id of ids){ args.push(id,"OFFLINE"); }
      await redis.call("HSET","drivers:status",...args);

      console.log("FALLBACK removed:", ids.length, ids);
    } else {
      console.log("FALLBACK removed: 0");
    }
  }

  const near = await redis.call("GEORADIUS","drivers:geo","36.8219","-1.2921","5","km");
  console.log("AFTER GEORADIUS 5km:", near);

  process.exit(0);
}

main().catch(e=>{ console.error("RUN ERROR:", e?.message||e); process.exit(1); });
