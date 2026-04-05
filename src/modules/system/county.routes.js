const express = require('express');
const router = express.Router();
const manager = require('../../../county_worker_manager');

router.get('/status', (req, res) => {
  res.json(manager.getStatus());
});

router.get('/active', (req, res) => {
  res.json({ active: manager.getActive() });
});

router.post('/activate', async (req, res) => {
  try {
    const { county } = req.body;
    const result = await manager.activate(county);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/deactivate', async (req, res) => {
  try {
    const { county } = req.body;
    const result = await manager.deactivate(county);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
