// Telemetry stream liveness watchdog.
//
// Trusts the telemetry stream, but detects a GENUINELY dead one without polling.
// Telemetry is change-driven, so a parked/asleep car legitimately goes silent —
// that is NOT a failure. Only when the stream has been silent for a long window
// do we make ONE cheap Tesla API call (fleet_telemetry_config GET) to distinguish
// "asleep + healthy" from "stream actually dead."

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const KEYS_DIR = process.env.KEYS_DIR || path.join(process.cwd(), 'keys');
const STATE_FILE   = path.join(KEYS_DIR, 'tesla-state.json');   // { state, fetchedAt, source }
const CONFIG_FILE  = path.join(KEYS_DIR, 'config.json');        // cfg.vehicles.tesla.vin
const TOKENS_FILE  = path.join(KEYS_DIR, 'tokens.json');        // .access_token
const HEALTH_FILE  = path.join(KEYS_DIR, 'telemetry-health.json');
const PROXY_PORT   = process.env.PROXY_PORT || '4443';
const HOME_SILENCE_MS = 24 * 60 * 60 * 1000;   // 86400000
const AWAY_SILENCE_MS = 8  * 60 * 60 * 1000;   // 28800000
const CHECK_INTERVAL_MS = 30 * 60 * 1000;      // wake every 30 min to evaluate
const REREGISTER_COOLDOWN_MS = 6 * 60 * 60 * 1000; // don't re-register more than once per 6h

let lastReregisterAt = 0;

function log(...args) {
  console.log(`[telemetry-watchdog]`, ...args);
}

log(`started; home silence ${HOME_SILENCE_MS/3600000}h, away ${AWAY_SILENCE_MS/3600000}h`);

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) { /* fall through */ }
  return { state: {}, fetchedAt: 0 };
}

function pushover(title, message) {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return; // no-op when unset

  try {
    const postData = JSON.stringify({ token, user, title, message });
    const req = https.request({
      hostname: 'api.pushover.net',
      port: 443,
      path: '/1/messages.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    }, () => { /* best-effort, no response handling needed */ });
    
    req.on('error', () => { /* ignore errors */ });
    req.write(postData);
    req.end();
  } catch (e) {
    // Best-effort - failure should not break the watchdog
    console.warn('[telemetry-watchdog] pushover failed:', e.message);
  }
}

function checkSynced(vin, token) {
  return new Promise((resolve) => {
    const url = `https://localhost:${PROXY_PORT}/api/1/vehicles/${vin}/fleet_telemetry_config`;
    
    const req = https.request({
      hostname: 'localhost',
      port: PROXY_PORT,
      path: `/api/1/vehicles/${vin}/fleet_telemetry_config`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      rejectUnauthorized: false, // self-signed cert
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          const synced = body.response?.synced === true;
          const limitReached = body.response?.limit_reached === true;
          resolve({ synced, limitReached });
        } catch (e) {
          console.warn('[telemetry-watchdog] sync check parse failed:', e.message);
          resolve({ synced: false, limitReached: false });
        }
      });
    });

    req.on('error', () => { 
      // Best-effort - failure should not break the watchdog
      resolve({ synced: false, limitReached: false }); 
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ synced: false, limitReached: false });
    });

    req.end();
  });
}

async function evaluate() {
  const state = readState();
  
  if (!state || !state.fetchedAt) {
    log('no telemetry data yet');
    return;
  }

  const silenceMs = Date.now() - state.fetchedAt;
  const atHome = state.state.locatedAtHome === true;
  const threshold = atHome ? HOME_SILENCE_MS : AWAY_SILENCE_MS;

  if (silenceMs < threshold) {
    // Telemetry is proven alive by recent frames
    const health = {
      syncedOk: true,
      limitReached: false,
      checkedAt: Date.now(),
      reason: 'frames-fresh',
      silenceMs
    };
    
    try {
      fs.writeFileSync(HEALTH_FILE, JSON.stringify(health));
    } catch (e) {
      console.warn('[telemetry-watchdog] write health failed:', e.message);
    }
    return;
  }

  // Silent past the window - check synced status via API call
  let vin = '';
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    vin = (config?.vehicles?.tesla?.vin || '').trim().toUpperCase();
  } catch (e) {
    log('failed to read VIN:', e.message);
    return;
  }

  if (!vin) {
    log('no VIN configured');
    return;
  }

  let token = '';
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    token = tokens?.access_token || '';
  } catch (e) {
    log('failed to read access token:', e.message);
    return;
  }

  if (!token) {
    log('no access token');
    return;
  }

  const { synced, limitReached } = await checkSynced(vin, token);

  const health = {
    syncedOk: synced,
    limitReached,
    checkedAt: Date.now(),
    reason: 'synced-check',
    silenceMs
  };

  try {
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(health));
  } catch (e) {
    console.warn('[telemetry-watchdog] write health failed:', e.message);
  }

  if (!synced || limitReached) {
    // This is a REAL failure - alert and re-register
    const hoursSilent = Math.round(silenceMs/3600000);
    pushover('Tesla telemetry DOWN', `synced=${synced} limit_reached=${limitReached}, silent ${hoursSilent}h`);
    
    // Best-effort re-register if cooldown has passed
    if (Date.now() - lastReregisterAt >= REREGISTER_COOLDOWN_MS) {
      try {
        const registerScript = path.join(__dirname, '..', 'scripts', 'register-telemetry.sh');
        const proc = spawn('sh', [registerScript], {
          env: { 
            ...process.env,
            TESLA_VIN: vin,
            TELEMETRY_HOST: process.env.TELEMETRY_HOST || ''
          },
          cwd: path.join(__dirname, '..')
        });
        
        proc.on('exit', (code) => {
          if (code === 0) {
            log(`re-register successful`);
            lastReregisterAt = Date.now();
          } else {
            log(`re-register failed with code ${code}`);
          }
        });
      } catch (e) {
        console.warn('[telemetry-watchdog] re-register spawn failed:', e.message);
      }
    }
  } else if (synced && !limitReached) {
    // Healthy, just been quiet
    const hoursSilent = Math.round(silenceMs/3600000);
    log(`healthy but silent for ${hoursSilent}h`);
  }
}

// Run evaluate once at startup, then on interval
evaluate().catch(e => console.warn('[telemetry-watchdog] initial evaluation failed:', e.message));
setInterval(evaluate, CHECK_INTERVAL_MS);
