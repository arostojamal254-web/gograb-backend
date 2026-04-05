const express = require('express');
const router = express.Router();
const redisClient = require('../redis'); // Adjust path if needed

// Default config
const defaultConfig = {
  baseCommissionRate: 0.1,
  distanceWeight: 0.5,
  ratingWeight: 0.3,
  loadWeight: 0.2,
  maxDistanceKm: 10,
  useKraTax: false,
  kraTaxRate: 0.0
};

// GET /api/assignments/config
router.get('/config', async (req, res) => {
  try {
    const configStr = await redisClient.get('assignment:config');
    if (configStr) {
      res.json(JSON.parse(configStr));
    } else {
      res.json(defaultConfig);
    }
  } catch (err) {
    console.error('Redis get config error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/assignments/config
router.post('/config', async (req, res) => {
  try {
    const config = req.body;
    await redisClient.set('assignment:config', JSON.stringify(config));
    res.json({ success: true });
  } catch (err) {
    console.error('Redis set config error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/assignments/pending
router.get('/pending', async (req, res) => {
  try {
    const jobs = await redisClient.lrange('assignment:pending', 0, -1);
    const parsed = jobs.map(j => JSON.parse(j));
    res.json(parsed);
  } catch (err) {
    console.error('Redis get pending error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/assignments/retry/:jobId
router.post('/retry/:jobId', async (req, res) => {
  const { jobId } = req.params;
  try {
    const jobStr = await redisClient.hget('assignment:failed', jobId);
    if (!jobStr) {
      return res.status(404).json({ error: 'Job not found' });
    }
    await redisClient.hdel('assignment:failed', jobId);
    await redisClient.lpush('assignment:pending', jobStr);
    res.json({ success: true });
  } catch (err) {
    console.error('Redis retry error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;