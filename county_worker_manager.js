const { exec } = require('child_process');
const redis = require('./src/shared/redis');
const fs = require('fs');
const path = require('path');

// All 47 counties
const COUNTIES = [
  'nairobi', 'mombasa', 'kisumu', 'nakuru', 'kiambu', 'meru', 'muranga',
  'nyeri', 'kirinyaga', 'embu', 'makueni', 'machakos', 'kajiado', 'narok',
  'kitui', 'tana river', 'lamu', 'kilifi', 'kwale', 'taita taveta', 'garissa',
  'wajir', 'mandera', 'marsabit', 'isiolo', 'samburu', 'turkana', 'west pokot',
  'baringo', 'laikipia', 'nyandarua', 'kericho', 'bomet', 'kakamega',
  'vihiga', 'bungoma', 'busia', 'siaya', 'kisii', 'nyamira', 'migori',
  'homa bay', 'tharaka nithi', 'elgeyo marakwet', 'nandi', 'trans nzoia',
  'uasin gishu', 'pokot'
];

const ACTIVE_COUNTIES_KEY = 'system:active_counties';
const LOG_DIR = path.join(__dirname, 'logs');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

class CountyWorkerManager {
  constructor() {
    this.workers = new Map(); // county -> { dispatch, wave }
    this.init();
  }

  async init() {
    const active = await redis.smembers(ACTIVE_COUNTIES_KEY);
    if (active.length === 0) {
      await this.activate('nairobi');
      await this.activate('mombasa');
      await this.activate('kisumu');
    } else {
      active.forEach(county => this.start(county));
    }
  }

  start(county) {
    if (this.workers.has(county)) return;
    const logFile = path.join(LOG_DIR, `${county}.log`);
    const dispatch = exec(
      `node src/workers/dispatch.worker.js ${county} >> "${logFile}" 2>&1`,
      { cwd: __dirname }
    );
    const wave = exec(
      `node src/workers/dispatch.wave.worker.js ${county} >> "${logFile}" 2>&1`,
      { cwd: __dirname }
    );
    this.workers.set(county, { dispatch, wave });
    console.log(`[manager] Started workers for ${county}`);
  }

  stop(county) {
    const procs = this.workers.get(county);
    if (!procs) return;
    procs.dispatch.kill();
    procs.wave.kill();
    this.workers.delete(county);
    console.log(`[manager] Stopped workers for ${county}`);
  }

  async activate(county) {
    const c = county.trim().toLowerCase();
    if (!COUNTIES.includes(c)) throw new Error(`Invalid county: ${c}`);
    await redis.sadd(ACTIVE_COUNTIES_KEY, c);
    this.start(c);
    return { ok: true, county: c };
  }

  async deactivate(county) {
    const c = county.trim().toLowerCase();
    await redis.srem(ACTIVE_COUNTIES_KEY, c);
    this.stop(c);
    return { ok: true, county: c };
  }

  getStatus() {
    const status = {};
    COUNTIES.forEach(c => {
      status[c] = { active: this.workers.has(c) };
    });
    return status;
  }

  getActive() {
    return Array.from(this.workers.keys());
  }
}

module.exports = new CountyWorkerManager();
