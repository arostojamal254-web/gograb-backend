const fs = require("fs");
const redis = require("../src/shared/redis");

async function main(){
  const lua = fs.readFileSync("./src/lua/driver_cleanup.lua", "utf8");

  const now = Math.floor(Date.now()/1000);

  // force one stale driver so script removes something
  await redis.call("GEOADD","drivers:geo","36.8219","-1.2921","DRIVER_123");
  await redis.call("ZADD","drivers:lastSeen",String(now-9999),"DRIVER_123");
  await redis.call("HSET","drivers:status","DRIVER_123","ONLINE");

  try{
    const resp = await redis.call(
      "EVAL", lua, "3",
      "drivers:geo","drivers:lastSeen","drivers:status",
      String(now),"10","2000"
    );
    console.log("EVAL OK =>", resp);
  } catch(e){
    console.log("EVAL ERROR =>", e?.message || e);
  }

  const near = await redis.call("GEORADIUS","drivers:geo","36.8219","-1.2921","5","km");
  console.log("GEORADIUS after =>", near);

  process.exit(0);
}
main().catch(e=>{console.error("RUN ERROR:", e?.message||e); process.exit(1);});
