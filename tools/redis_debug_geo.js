const redis = require("../src/shared/redis");

async function main(){
  const driverId = process.argv[2] || "DRIVER_123";
  const zoneId = process.argv[3] || "nairobi";
  const lng = Number(process.argv[4]);
  const lat = Number(process.argv[5]);

  console.log("Checking Redis GEO...");

  const pos = await redis.call("GEOPOS","drivers:geo",driverId);
  console.log("GEOPOS drivers:geo",driverId,"=>",pos);

  const near = await redis.call("GEORADIUS","drivers:geo",String(lng),String(lat),"5","km");
  console.log("GEORADIUS drivers:geo (5km) =>",near);

  process.exit(0);
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});
