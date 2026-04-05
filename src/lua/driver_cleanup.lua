local geoKey = KEYS[1]
local lastKey = KEYS[2]
local statusKey = KEYS[3]

local nowSec = tonumber(ARGV[1])
local ttlSec = tonumber(ARGV[2])
local batchSize = tonumber(ARGV[3])

local cutoff = nowSec - ttlSec

local ids = redis.call("ZRANGEBYSCORE", lastKey, "-inf", cutoff, "LIMIT", 0, batchSize)
if (not ids) or (#ids == 0) then
  return {0}
end

redis.call("ZREM", geoKey, unpack(ids))
redis.call("ZREM", lastKey, unpack(ids))

local args = {}
for i=1,#ids do
  table.insert(args, ids[i])
  table.insert(args, "OFFLINE")
end
redis.call("HSET", statusKey, unpack(args))

local out = {#ids}
for i=1,#ids do
  table.insert(out, ids[i])
end
return out