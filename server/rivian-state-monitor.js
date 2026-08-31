// Real-time Rivian vehicleState via WebSocket push.
//
// Replaces the *latency* of lib/rivian.ts's polling path (15-240 min opaque
// throttle backoff on top of a 20s-5min poll tier) with a persistent
// subscription that gets pushed the moment anything changes. The REST poll
// stays in place as the fallback whenever this socket isn't delivering --
// see readRivianPushState()/getRivianVehicleState() in lib/rivian.ts.
//
// Endpoint + protocol confirmed live 2026-08-24 by capturing the Rivian
// Android app (see Claude/API-Docs/Rivian.md in the vault, "WebSocket push
// subscriptions"): graphql-ws over
// wss://api.rivian.com/gql-consumer-subscriptions/graphql, handshake
// connection_init -> connection_ack -> subscribe -> next... -> complete,
// authenticated with the same session tokens as the GraphQL gateway.
// Unlike the service-mode operations, `vehicleState` IS readable by the
// dashboard's SHARED (invited-user) account -- that was verified against the
// dashboard's own login, not just the owner's.
//
// !! FIELD-COVERAGE CAVEAT -- READ BEFORE RETIRING THE POLL PATH !!
// The only live capture of this subscription was taken while the vehicle was
// IN SERVICE, and Rivian reports nearly every vehicleState field as null in
// that condition. So what is confirmed is the *transport* (handshake, auth,
// subscribe, a stream of `next` frames) -- NOT that every field in
// VEHICLE_STATE_FIELDS is actually populated on the push path the way it is
// on the polled query. Take an out-of-service capture and diff a pushed
// payload against a polled GetVehicleState response field by field before
// anyone deletes fetchRivianVehicleState() or stops falling back to it.
//
// Follows this project's sidecar convention (server/telemetry-server.js for
// Tesla, server/parallax-monitor.js for Rivian charging power): the daemon
// owns the socket and persists to a file in the keys volume; the Next.js
// request path only ever does a plain file read, so no websocket client ever
// lands on a request handler.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocket } = require('ws');
const { VEHICLE_STATE_FIELDS } = require('./rivian-vehicle-state-fields.js');

const KEYS_DIR = process.env.KEYS_DIR || '/app/keys';
const TOKENS_PATH = path.join(KEYS_DIR, 'rivian-tokens.json');
const STATE_PATH = path.join(KEYS_DIR, 'rivian-push-state.json');
const PUSH_LOG_DIR = path.join(KEYS_DIR, 'push-log');

const WS_URL = 'wss://api.rivian.com/gql-consumer-subscriptions/graphql';
const APOLLO_CLIENT_NAME = 'com.rivian.ios.consumer-apollo-ios';

// Field selection is shared verbatim with the polled GetVehicleState query so
// one mapping function in lib/rivian.ts can consume either path.
const SUBSCRIBE_QUERY = `subscription vehicleState($vehicleID: String!) {
  vehicleState(id: $vehicleID) {
    __typename${VEHICLE_STATE_FIELDS}
  }
}`;

// A silently half-dead socket (TCP still open, no frames arriving) is the
// exact failure this migration is supposed to eliminate, so don't trust
// 'close' to be the only signal a reconnect is needed. If nothing at all --
// not even a keepalive ping -- arrives within this window, tear it down and
// reconnect. Rivian pushes vehicleState changes irregularly (a parked car can
// be quiet for a long time), hence a generous window; server pings normally
// keep it well fed.
const IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const NO_TOKENS_RETRY_MS = 60_000;

let attempt = 0;

// Last known good merged vehicleState. Pushed frames are treated as PATCHES,
// not snapshots: a `next` frame may carry only the fields that changed, with
// everything else null or absent, and overwriting wholesale would blank the
// dashboard on every partial update. So merge non-null over previous, and let
// lib/rivian.ts apply the same null-tolerant defaults it already applies to
// polled responses. Seeded from disk so a monitor restart doesn't throw away
// the accumulated picture.
let merged = null;

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function loadPersisted() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    if (raw && typeof raw.vehicleState === 'object' && raw.vehicleState !== null) {
      merged = raw.vehicleState;
    }
  } catch { /* first run */ }
}

// null-vs-absent tolerance, in one place: a key that is absent and a key
// explicitly null both mean "no news", never "cleared". Only a present,
// non-null value replaces what we already had.
function mergePatch(patch) {
  const base = merged || {};
  const next = { ...base };
  let changed = 0;
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__typename') continue;
    if (v === null || v === undefined) continue;
    next[k] = v;
    changed++;
  }
  merged = next;
  return changed;
}

function writeState(source) {
  const payload = {
    updatedAt: Date.now(),
    source,
    vehicleState: merged,
  };
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(payload));
  } catch (e) {
    console.error('[rivian-ws] write failed:', e.message);
  }
}

function logPushFrame(frameData) {
  // Create daily-rotated file
  const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const logFile = path.join(PUSH_LOG_DIR, `${dateStr}.jsonl`);
  
  try {
    // Ensure directory exists
    fs.mkdirSync(PUSH_LOG_DIR, { recursive: true });
    
    // Append frame data to file
    fs.appendFileSync(logFile, JSON.stringify(frameData) + '\n');
    
    // Best-effort delete files older than 14 days
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 14);
    
    fs.readdir(PUSH_LOG_DIR, (err, files) => {
      if (err) return;
      
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        
        const filePath = path.join(PUSH_LOG_DIR, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtime < cutoffDate) {
            fs.unlinkSync(filePath);
          }
        } catch { /* ignore */ }
      }
    });
  } catch (e) {
    // Best-effort logging - failure should not break state write
    console.warn('[rivian-ws] frame log failed:', e.message);
  }
}

function connect() {
  const tokens = readTokens();
  if (!tokens) {
    console.log(`[rivian-ws] no rivian-tokens.json yet, retrying in ${NO_TOKENS_RETRY_MS / 1000}s`);
    setTimeout(connect, NO_TOKENS_RETRY_MS);
    return;
  }
  if (!tokens.vehicleId) {
    console.warn('[rivian-ws] tokens have no vehicleId — reconnect Rivian in /admin; retrying');
    setTimeout(connect, NO_TOKENS_RETRY_MS);
    return;
  }

  console.log('[rivian-ws] connecting...');
  const ws = new WebSocket(WS_URL, 'graphql-transport-ws', {
    headers: {
      'User-Agent': 'RivianApp/707 CFNetwork/1237 Darwin/20.4.0',
      'Apollographql-Client-Name': APOLLO_CLIENT_NAME,
    },
  });

  const subId = crypto.randomUUID();
  let acked = false;
  let settled = false;
  let idleTimer = null;
  let frames = 0;

  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      console.warn(`[rivian-ws] no frames for ${IDLE_TIMEOUT_MS / 60000}m, forcing reconnect`);
      try { ws.terminate(); } catch { /* already gone */ }
    }, IDLE_TIMEOUT_MS);
  };

  // Every teardown path funnels through here so a socket that errors AND
  // closes only schedules one reconnect.
  const reconnect = () => {
    if (settled) return;
    settled = true;
    clearIdle();
    attempt++;
    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    console.log(`[rivian-ws] reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
    setTimeout(connect, delay);
  };

  ws.on('open', () => {
    armIdle();
    // Payload shape mirrors the proven parallax handshake
    // (server/parallax-monitor.js), which authenticates with u-sess alone.
    // csrf-token / a-sess are included as well because that is the trio the
    // gateway wants and the vault notes describe this endpoint as taking the
    // same session auth; graphql-ws forwards connection_init payloads
    // verbatim to the server's connect hook, so the extra keys are inert if
    // Rivian ignores them.
    ws.send(JSON.stringify({
      type: 'connection_init',
      payload: {
        'client-name': APOLLO_CLIENT_NAME,
        'client-version': '1.13.0-1494',
        'dc-cid': `m-ios-${crypto.randomUUID()}`,
        'csrf-token': tokens.csrfToken,
        'a-sess': tokens.appSessionToken,
        'u-sess': tokens.userSessionToken,
      },
    }));
  });

  ws.on('ping', armIdle);
  ws.on('pong', armIdle);

  ws.on('message', (raw) => {
    armIdle();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'connection_ack') {
      if (acked) return;
      acked = true;
      attempt = 0; // only a real ack counts as a successful connection
      ws.send(JSON.stringify({
        id: subId,
        type: 'subscribe',
        payload: {
          operationName: 'vehicleState',
          query: SUBSCRIBE_QUERY,
          variables: { vehicleID: tokens.vehicleId },
        },
      }));
      console.log('[rivian-ws] connected, subscribed to vehicleState');
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'next') {
      const payload = msg.payload || {};
      // GraphQL can report per-field errors alongside partial data; keep the
      // data we did get rather than discarding the frame.
      if (Array.isArray(payload.errors) && payload.errors.length) {
        console.warn('[rivian-ws] next frame carried errors:', JSON.stringify(payload.errors[0]).slice(0, 240));
      }
      const vs = payload.data && payload.data.vehicleState;
      if (!vs || typeof vs !== 'object') return;
      frames++;
      const changed = mergePatch(vs);
      // Always restamp updatedAt, even for a no-change frame: freshness is
      // what lib/rivian.ts uses to decide the push path is alive, and a
      // parked car legitimately pushes repeats.
      writeState('push');
      
      // Log the frame with only changed fields (as requested)
      if (changed > 0) {
        const changedFields = {};
        for (const [k, v] of Object.entries(vs)) {
          if (k === '__typename') continue;
          if (v === null || v === undefined) continue;
          changedFields[k] = v;
        }
        logPushFrame({
          receivedAt: new Date().toISOString(),
          source: 'rivian',
          changed: changedFields
        });
      }
      
      if (frames <= 3 || changed > 0) {
        console.log(`[rivian-ws] push #${frames}: ${changed} field(s) updated`);
      }
      return;
    }

    if (msg.type === 'error') {
      // Subscription-level error (bad variables, expired session, ...).
      // Not recoverable on this socket -- log it and let the reconnect
      // ladder retry; an expired session is separately surfaced by the poll
      // fallback's 401 handling, which sets the reauth flag.
      console.error('[rivian-ws] subscription error:', JSON.stringify(msg.payload).slice(0, 400));
      try { ws.close(); } catch { /* already gone */ }
      return;
    }

    if (msg.type === 'complete' && msg.id === subId) {
      console.warn('[rivian-ws] server completed the subscription, reconnecting');
      try { ws.close(); } catch { /* already gone */ }
    }
  });

  ws.on('error', (e) => {
    console.error('[rivian-ws] websocket error:', e.message);
  });

  ws.on('close', (code) => {
    console.log(`[rivian-ws] closed (${code}) after ${frames} push frame(s), acked=${acked}`);
    reconnect();
  });
}

loadPersisted();
connect();
