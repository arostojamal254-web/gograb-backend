const redis = require("./src/shared/redis");
async function main(){
  const after = await redis.call("GEORADIUS","drivers:geo","36.8219","-1.2921","5","km");
  console.log("AFTER cleanup GEORADIUS:", after);
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
