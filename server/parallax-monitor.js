// Persistent connection to Rivian's Parallax GraphQL-over-websocket service
// -- a genuinely separate pipeline from the vehicleState query lib/rivian.ts
// uses, and the only place live charging power/current lives at all
// (vehicleState has no such field, confirmed 2026-08-08).
//
// Confirmed live the same day: this catches real charge-rate throttling
// (alternating ~11.3kW/~5.5kW segments, thermal-cycling shaped, not a
// smooth taper) that chargerDerateStatus on the classic API reported
// "NONE" for the entire time. Built to feed the dashboard the number
// Rivian's own app actually shows, not the number the old API can't see.
//
// Decoder logic proven against scripts/parallax-watch.mjs (one-shot
// diagnostic version) -- this is the same decode, wrapped in a
// reconnect-forever daemon instead of a one-shot CLI watcher, following
// this project's file-cache convention (writes keys/rivian-parallax.json,
// same shape as telemetry-server.js writing keys/tesla-state.json) so
// app/api/dashboard/route.ts can read it with a plain file read, no
// websocket client needed on the request path.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocket } = require('ws');

const KEYS_DIR = process.env.KEYS_DIR || '/app/keys';
const TOKENS_PATH = path.join(KEYS_DIR, 'rivian-tokens.json');
const STATE_PATH = path.join(KEYS_DIR, 'rivian-parallax.json');
const PARALLAX_LOG_DIR = path.join(KEYS_DIR, 'parallax-log');

const WS_URL = 'wss://api.rivian.com/gql-consumer-subscriptions/graphql';
const APOLLO_CLIENT_NAME = 'com.rivian.ios.consumer-apollo-ios';

const RVMS = [
  'charging.session.status',
  'charging.session.time_estimation',
  'energy_edge_compute.graphs.charging_graph_global',
  'energy_edge_compute.graphs.charge_session_breakdown',
];

const SUBSCRIBE_QUERY = `subscription ParallaxMessages($vehicleId: String!, $rvms: [String!]) {
  parallaxMessages(vehicleId: $vehicleId, rvms: $rvms) { payload timestamp rvm }
}`;

// ── Decoders -- see scripts/parallax-watch.mjs for the verified source ─────

function decodeVarint(data, offset) {
  let result = 0n, shift = 0n, i = offset;
  while (i < data.length) {
    const byte = data[i];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    i++;
    if (!(byte & 0x80)) break;
  }
  return [Number(result), i];
}

function decodeFields(data) {
  const fields = [];
  let i = 0;
  while (i < data.length) {
    let tag;
    [tag, i] = decodeVarint(data, i);
    const fieldNum = tag >> 3, wireType = tag & 0x07;
    if (wireType === 0) {
      let v; [v, i] = decodeVarint(data, i);
      fields.push([fieldNum, wireType, v]);
    } else if (wireType === 1) {
      if (i + 8 > data.length) break;
      fields.push([fieldNum, wireType, data.readDoubleLE(i)]);
      i += 8;
    } else if (wireType === 2) {
      let length; [length, i] = decodeVarint(data, i);
      if (i + length > data.length) break;
      fields.push([fieldNum, wireType, data.subarray(i, i + length)]);
      i += length;
    } else if (wireType === 5) {
      if (i + 4 > data.length) break;
      fields.push([fieldNum, wireType, data.readFloatLE(i)]);
      i += 4;
    } else {
      break;
    }
  }
  return fields;
}

function decodeChargingSessionStatus(payload) {
  const result = {};
  for (const [num, wt, val] of decodeFields(Buffer.from(payload, 'base64'))) {
    if (num === 1 && wt === 0) result.plugConnectionStatus = val;
    else if (num === 2 && wt === 0) result.displayStatus = val;
    else if (num === 3 && wt === 0) result.evseType = val;
  }
  return result;
}

function decodeChargeSessionBreakdown(payload) {
  const result = {};
  for (const [num, wt, val] of decodeFields(Buffer.from(payload, 'base64'))) {
    if (num === 1 && wt === 5) result.totalChargedEnergyKwh = Math.round(val * 10000) / 10000;
    else if (num === 9 && wt === 5) result.powerKw = Math.round(val * 100) / 100;
    else if (num === 10 && wt === 0 && result.powerKw === undefined) result.powerKw = val;
    else if (num === 13 && wt === 0) result.chargingStateEnum = val;
  }
  return result;
}

function decodeTimeEstimation(payload) {
  const result = {};
  for (const [num, wt, val] of decodeFields(Buffer.from(payload, 'base64'))) {
    if (num === 1 && wt === 0) result.timeToEndOfChargeSec = val;
  }
  return result;
}

// charging_graph_global's history is genuinely useful for spotting a
// throttle pattern (see module comment) but isn't a single scalar the
// dashboard can show directly -- store only the LATEST segment's power,
// which is a duplicate of charge_session_breakdown's powerKw and mostly
// exists as a freshness cross-check. Full segment history not persisted
// (would grow unbounded); if a "was throttled during this session" UI
// gets built later, derive it from the state field crossing 3<->something
// else rather than the raw segment list.
function decodeChargingGraphGlobal(payload) {
  const segments = [];
  for (const [num, wt, val] of decodeFields(Buffer.from(payload, 'base64'))) {
    if (num === 1 && wt === 2) {
      const seg = {};
      for (const [inNum, inWt, inVal] of decodeFields(val)) {
        if (inNum === 2 && inWt === 5) seg.powerKw = Math.round(inVal * 100) / 100;
        else if (inNum === 4 && inWt === 0) seg.endMs = inVal;
        else if (inNum === 6 && inWt === 0) seg.state = inVal;
      }
      segments.push(seg);
    }
  }
  if (!segments.length) return {};
  const withEnd = segments.filter(s => s.endMs !== undefined);
  const latest = withEnd.length ? withEnd.reduce((a, b) => (b.endMs > a.endMs ? b : a)) : segments[segments.length - 1];
  return latest.powerKw !== undefined ? { powerKw: latest.powerKw } : {};
}

const DECODERS = {
  'charging.session.status': decodeChargingSessionStatus,
  'charging.session.time_estimation': decodeTimeEstimation,
  'energy_edge_compute.graphs.charging_graph_global': decodeChargingGraphGlobal,
  'energy_edge_compute.graphs.charge_session_breakdown': decodeChargeSessionBreakdown,
};

// ── Persisted state ──────────────────────────────────────────────────────

function writeState(patch) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { /* first write */ }
  const merged = { ...state, ...patch, updatedAt: Date.now() };
  if ('powerKw' in patch) {
    merged.powerKwAt = Date.now();
  }
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(merged));
  } catch (e) {
    console.error('[parallax] write failed:', e.message);
  }
  
  // Log charge session data when there's actual charging telemetry
  if ('powerKw' in patch || 'totalChargedEnergyKwh' in patch || 'chargingStateEnum' in patch) {
    logParallaxFrame(merged);
  }
}

function logParallaxFrame(state) {
  try {
    fs.mkdirSync(PARALLAX_LOG_DIR, { recursive: true });
    
    const dateStr = new Date().toISOString().split('T')[0];
    const logFilePath = path.join(PARALLAX_LOG_DIR, `${dateStr}.jsonl`);
    
    const logEntry = JSON.stringify({
      receivedAt: new Date().toISOString(),
      powerKw: state.powerKw ?? null,
      totalChargedEnergyKwh: state.totalChargedEnergyKwh ?? null,
      chargingStateEnum: state.chargingStateEnum ?? null,
      timeToEndOfChargeSec: state.timeToEndOfChargeSec ?? null,
      plugConnectionStatus: state.plugConnectionStatus ?? null,
      displayStatus: state.displayStatus ?? null
    }) + '\n';
    
    fs.appendFileSync(logFilePath, logEntry);
    
    // Best-effort 14-day-old-file cleanup (like rivian-state-monitor.js)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 14);
    const cutoffTimestamp = cutoffDate.getTime();
    
    try {
      const files = fs.readdirSync(PARALLAX_LOG_DIR);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          const filePath = path.join(PARALLAX_LOG_DIR, file);
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs < cutoffTimestamp) {
            fs.unlinkSync(filePath);
          }
        }
      }
    } catch (cleanupError) {
      // Silently ignore cleanup errors
    }
  } catch (e) {
    console.warn('[parallax] frame log failed:', e.message);
  }
}

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

// ── Connection with reconnect-forever + exponential backoff ────────────────
// No Rivian tokens is a normal, expected state before first login (not an
// error to loop hard on) -- checked once at each attempt so a later login
// (no restart required, tokens file just starts existing) picks up
// automatically on the next backoff tick.

let attempt = 0;
const MAX_BACKOFF_MS = 5 * 60_000;

function connect() {
  const tokens = readTokens();
  if (!tokens) {
    console.log('[parallax] no rivian-tokens.json yet, retrying in 60s');
    setTimeout(connect, 60_000);
    return;
  }

  console.log('[parallax] connecting...');
  const ws = new WebSocket(WS_URL, 'graphql-transport-ws');
  let acked = false;
  let gotAnyMessage = false;
  let stableTimer = null;

  const reconnect = () => {
    attempt++;
    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    console.log(`[parallax] reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
    setTimeout(connect, delay);
  };

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'connection_init',
      payload: {
        'client-name': APOLLO_CLIENT_NAME,
        'client-version': '1.13.0-1494',
        'dc-cid': `m-ios-${crypto.randomUUID()}`,
        'u-sess': tokens.userSessionToken,
      },
    }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'connection_ack' && !acked) {
      acked = true;
      stableTimer = setTimeout(() => { attempt = 0; }, 30_000); // reset backoff only if the connection proves sustained
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'subscribe',
        payload: {
          operationName: 'ParallaxMessages',
          query: SUBSCRIBE_QUERY,
          variables: { vehicleId: tokens.vehicleId, rvms: RVMS },
        },
      }));
      console.log(`[parallax] connected, subscribed to ${RVMS.length} RVMs`);
      return;
    }

    // graphql-transport-ws MUST answer a server Ping with a Pong.
    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* socket may be closing */ }
      return;
    }
    // Anything that isn't `next` (error, complete, etc.) carries the server's own
    // explanation for ending the subscription -- the 4420/4430 close codes are
    // undocumented, so log the payload rather than discarding it silently.
    if (msg.type !== 'next') {
      console.warn(`[parallax] server msg type=${msg.type} payload=${JSON.stringify(msg.payload ?? null).slice(0, 600)}`);
      return;
    }
    const data = msg.payload && msg.payload.data && msg.payload.data.parallaxMessages;
    if (!data) return;
    gotAnyMessage = true;

    const decoder = DECODERS[data.rvm];
    if (!decoder) return;
    let decoded;
    try {
      decoded = decoder(data.payload);
    } catch (e) {
      console.warn(`[parallax] decode failed for ${data.rvm}:`, e.message);
      return;
    }
    if (Object.keys(decoded).length) writeState(decoded);
  });

  ws.on('error', (e) => console.error('[parallax] websocket error:', e.message));

  ws.on('close', (code) => {
    console.log(`[parallax] connection closed (${code}), got messages this session: ${gotAnyMessage}`);
    if (stableTimer) clearTimeout(stableTimer);
    reconnect();
  });
}

connect();
