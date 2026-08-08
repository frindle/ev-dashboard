// One-shot live watcher for Rivian's Parallax charging RVMs -- a genuinely
// separate GraphQL-over-websocket service from the vehicleState query
// lib/rivian.ts uses, subscription-only (no plain-query equivalent exists).
// Built 2026-08-08 investigating why chargerDerateStatus reads "NONE"
// during a visibly slower real charging session (Rivian's own app showed
// a lower kW than the Wall Connector's reported current implied) -- this
// pulls power/session data from wherever Rivian's own app actually gets
// it, bypassing chargerDerateStatus entirely.
//
// Field-number decoding ported directly from
// github.com/bretterer/rivian-python-client's src/rivian/parallax.py
// (verified there against a real account, not guessed here).
//
// Run from inside the container (uses `ws`, already a dependency -- no
// install needed):
//   docker exec ev-dashboard-ev-dashboard-1 node scripts/parallax-watch.mjs
//
// Read-only: subscribes and prints, never sends a command. Ctrl-C-safe.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const WS_URL = 'wss://api.rivian.com/gql-consumer-subscriptions/graphql';
const APOLLO_CLIENT_NAME = 'com.rivian.ios.consumer-apollo-ios';

// Full recommended charging subscribe list per RivDocs
// (kaedenbrinkman/rivian-api, app/parallax/domains/charging.md) -- their
// own decompiled-APK-sourced reference, more complete than what
// bretterer/rivian-python-client's schema file happened to implement.
// Confirmed 2026-08-08: only 4 of these 12 had a real field-number mapping
// anywhere we could find (charging.session.status/time_estimation,
// energy_edge_compute.graphs.charging_graph_global/charge_session_breakdown)
// -- the rest fall through to the generic byte-dump decoder below.
const RVMS = [
  'charging.session.status',
  'charging.session.time_estimation',
  'energy_edge_compute.graphs.charging_graph_global',
  'energy_edge_compute.graphs.charge_session_breakdown',
  // charging.session.notification is the most promising undecoded one --
  // the name suggests it could carry an actual human-readable reason/
  // event, which would beat inferring a throttle from a power-drop
  // threshold.
  'charging.session.notification',
  'charging.session.remote_command',
  'charging.session.trip_target',
  'charging.schedule.time_window',
  'energy_edge_compute.graphs.cold_weather_soc',
  'energy.high_voltage.battery_state',
  'energy.high_voltage.battery_characteristics',
  'charging.session.soc_slider',
];

const SUBSCRIBE_QUERY = `subscription ParallaxMessages($vehicleId: String!, $rvms: [String!]) {
  parallaxMessages(vehicleId: $vehicleId, rvms: $rvms) { payload timestamp rvm }
}`;

// ── Decoders, ported field-for-field from parallax.py ──────────────────────

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
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      let value; [value, i] = decodeVarint(data, i);
      fields.push([fieldNum, wireType, value]);
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
    if (num === 1 && wt === 5) result.totalChargedEnergy_kWh = Math.round(val * 10000) / 10000;
    else if (num === 9 && wt === 5) result.power_kW = Math.round(val * 100) / 100;
    else if (num === 10 && wt === 0 && result.power_kW === undefined) result.power_kW = val;
    else if (num === 13 && wt === 0) result.chargingStateEnum = val;
  }
  return result;
}

function decodeChargingGraphGlobal(payload) {
  const segments = [];
  for (const [num, wt, val] of decodeFields(Buffer.from(payload, 'base64'))) {
    if (num === 1 && wt === 2) {
      const seg = {};
      for (const [inNum, inWt, inVal] of decodeFields(val)) {
        if (inNum === 1 && inWt === 0) seg.soc = inVal;
        else if (inNum === 2 && inWt === 5) seg.power_kW = Math.round(inVal * 100) / 100;
        else if (inNum === 3 && inWt === 0) seg.start_ms = inVal;
        else if (inNum === 4 && inWt === 0) seg.end_ms = inVal;
        else if (inNum === 6 && inWt === 0) seg.state = inVal;
      }
      segments.push(seg);
    }
  }
  return { segments };
}

function decodeTimeEstimation(payload) {
  const result = {};
  for (const [num, wt, val] of decodeFields(Buffer.from(payload, 'base64'))) {
    if (num === 1 && wt === 0) result.timeToEndOfCharge_sec = val;
  }
  return result;
}

// Generic fallback for RVMs with no known field mapping -- shows every
// top-level field's number/wire-type/value, and for length-delimited
// (wire type 2) fields, BOTH a hex dump and a UTF-8 decode attempt, since
// that field kind covers everything from nested messages to plain text
// (a real notification string would land here).
function decodeGeneric(payload) {
  const buf = Buffer.from(payload, 'base64');
  return decodeFields(buf).map(([num, wt, val]) => {
    if (wt === 2) {
      const asUtf8 = val.toString('utf-8');
      const looksLikeText = /^[\x20-\x7e\s]*$/.test(asUtf8) && asUtf8.length > 0;
      return {
        field: num, wireType: 'length-delimited', byteLength: val.length,
        hex: val.toString('hex'),
        utf8: looksLikeText ? asUtf8 : '(not printable ASCII -- likely a nested submessage, see hex)',
      };
    }
    return { field: num, wireType: wt, value: val };
  });
}

const DECODERS = {
  'charging.session.status': decodeChargingSessionStatus,
  'charging.session.time_estimation': decodeTimeEstimation,
  'energy_edge_compute.graphs.charging_graph_global': decodeChargingGraphGlobal,
  'energy_edge_compute.graphs.charge_session_breakdown': decodeChargeSessionBreakdown,
};

// ── Connect, subscribe, decode ──────────────────────────────────────────────

const tokensPath = process.argv[2]
  ?? join(process.env.KEYS_DIR ?? join(process.cwd(), 'keys'), 'rivian-tokens.json');
const tokens = JSON.parse(readFileSync(tokensPath, 'utf-8'));

console.log(`Connecting to ${WS_URL} ...`);
const ws = new WebSocket(WS_URL, 'graphql-transport-ws');

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'connection_init',
    payload: {
      'client-name': APOLLO_CLIENT_NAME,
      'client-version': '1.13.0-1494',
      'dc-cid': `m-ios-${randomUUID()}`,
      'u-sess': tokens.userSessionToken,
    },
  }));
});

let subscribed = false;

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'connection_ack' && !subscribed) {
    subscribed = true;
    console.log('Connected and authenticated. Subscribing...');
    ws.send(JSON.stringify({
      id: randomUUID(),
      type: 'subscribe',
      payload: {
        operationName: 'ParallaxMessages',
        query: SUBSCRIBE_QUERY,
        variables: { vehicleId: tokens.vehicleId, rvms: RVMS },
      },
    }));
    console.log(`Subscribed to ${RVMS.length} RVMs. Watching for live messages (Ctrl-C to stop)...\n`);
    return;
  }

  if (msg.type !== 'next') {
    console.log('[control]', msg);
    return;
  }

  const data = msg.payload?.data?.parallaxMessages;
  if (!data) return;
  const decoder = DECODERS[data.rvm];
  let decoded;
  try {
    decoded = decoder ? decoder(data.payload) : decodeGeneric(data.payload);
  } catch (e) {
    decoded = { _decode_error: String(e) };
  }
  console.log(`[${data.timestamp}] ${data.rvm}:`, decoded);
});

ws.on('error', (e) => console.error('WebSocket error:', e.message));
ws.on('close', (code, reason) => console.log(`Connection closed (${code}) ${reason}`));

process.on('SIGINT', () => { ws.close(); process.exit(0); });
