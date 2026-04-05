const redis = require("../src/shared/redis");
async function main(){
  const lng = Number(process.argv[2] ?? 36.8219);
  const lat = Number(process.argv[3] ?? -1.2921);
  const near = await redis.call("GEORADIUS","drivers:geo",String(lng),String(lat),"5","km");
  console.log("GEORADIUS drivers:geo 5km =>", near);
  if (near?.length){
    const st = await redis.call("HMGET","drivers:status",...near);
    console.log("HMGET drivers:status =>", st);
  }
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
