const redis = require('redis');
const client = redis.createClient();
client.connect().then(() => console.log('Redis connected'));
module.exports = client;