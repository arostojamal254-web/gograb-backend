const redis = require("../src/shared/redis");
async function main(){
  const GEO_KEY = process.env.GEO_KEY || "drivers:geo";
  const count = await redis.call("ZCARD", GEO_KEY);
  console.log("ZCARD", GEO_KEY, "=>", count);
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
