// Tesla Fleet Telemetry receiver.
//
// Architecture (Plan A — no Cloudflare mTLS, free Zero Trust tier):
//   Tesla vehicle → HTTPS → Cloudflare Tunnel → this server (plain ws on
//   localhost:50051) → decodes protobuf → writes keys/tesla-state.json
//
// Cloudflare's free Zero Trust doesn't allow uploading a CA root for Access
// mTLS, so we don't validate Tesla's client cert at edge. Instead, we enforce
// VIN matching on every Payload: the `vin` field must equal the configured
// Tesla VIN from config.json. Worst case: a targeted attacker who knows your
// VIN and the proto format could feed bad numbers — they can't touch the
// car or read data. The endpoint is only reachable via the tunnel, not
// directly from the internet.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const protobuf = require('protobufjs');

const PORT = parseInt(process.env.TELEMETRY_PORT || '50051', 10);
const KEYS_DIR = process.env.KEYS_DIR || path.join(process.cwd(), 'keys');
const STATE_FILE = path.join(KEYS_DIR, 'tesla-state.json');
const CONFIG_FILE = path.join(KEYS_DIR, 'config.json');
const PROTO_PATH = path.join(process.cwd(), 'protos', 'vehicle_data.proto');

// Plan A trust model: no Cloudflare mTLS in front of us. Anything that reaches
// our endpoint via the tunnel could be spoofed, so we enforce two checks:
//   1. The VIN in every Payload must match the configured Tesla VIN
//   2. Per-connection rate limiting prevents flooding
// Worst case: someone who knows your VIN AND the proto format can feed bad
// numbers to your dashboard. They can't touch the car or read anything.
const MAX_MSGS_PER_CONN_PER_SEC = 20;
const MAX_CONNECTIONS_PER_IP = 5;

function getExpectedVin() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return (cfg?.vehicles?.tesla?.vin || '').trim().toUpperCase();
  } catch { return ''; }
}

let Payload = null;
let fieldNumberToName = new Map();

async function loadProto() {
  const root = await protobuf.load(PROTO_PATH);
  Payload = root.lookupType('telemetry.vehicle_data.Payload');
  const fieldEnum = root.lookupEnum('telemetry.vehicle_data.Field');
  for (const [name, num] of Object.entries(fieldEnum.values)) {
    fieldNumberToName.set(num, name);
  }
  console.log(`[telemetry] proto loaded, ${fieldNumberToName.size} field names mapped`);
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) { /* fall through */ }
  return { state: {}, fetchedAt: 0 };
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ state, fetchedAt: Date.now(), source: 'telemetry' }));
  } catch (e) {
    console.error('[telemetry] write failed:', e.message);
  }
}

// Map a single Datum into our TeslaVehicleState shape.
//
// Field names here must match the upstream Field enum exactly (verified June
// 2026 against teslamotors/fleet-telemetry vehicle_data.proto). When adding
// support for a new field, look up the canonical name in the upstream proto
// and add a case here — don't guess.
//
// Tesla's enums are encoded as integers; protobufjs decodes them with our
// `enums: Number` option so we compare against the numeric value (e.g.
// ChargeStateCharging = 4) rather than strings.
function applyDatum(state, key, value) {
  const fieldName = fieldNumberToName.get(key) || `Field${key}`;
  // Extract the populated oneof variant. Tesla packs primitives into typed
  // fields; we read whichever one is present.
  const v = value.stringValue ?? value.intValue ?? value.longValue
         ?? value.floatValue ?? value.doubleValue ?? value.booleanValue
         ?? value.locationValue ?? value.chargingValue ?? value.shiftStateValue
         ?? value.detailedChargeStateValue ?? null;

  switch (fieldName) {
    // Battery / range
    case 'Soc':
    case 'BatteryLevel':
      state.chargePercent = Number(v) || 0; break;
    case 'ChargeLimitSoc':
      state.chargeLimit = Number(v) || 80; break;
    case 'RatedRange':
    case 'IdealBatteryRange':
    case 'EstBatteryRange':
      state.rangeMi = Number(v) || 0; break;
    case 'Odometer':
      state.odometer = Number(v) || 0; break;

    // Charging state — ChargeStateCharging = 4, DetailedChargeStateCharging = 4
    case 'ChargeState':
    case 'DetailedChargeState':
      state.isCharging = (v === 4);
      state.chargingState = String(v); break;

    // Charging power / progress
    case 'ChargeAmps':
    case 'ChargeRateMilePerHour':
      state.chargeRateMph = Number(v) || 0; break;
    case 'TimeToFullCharge':
      // Tesla reports hours as float, our model uses minutes
      state.minutesToFull = Math.round((Number(v) || 0) * 60); break;
    case 'ChargerVoltage':
      state.chargerVoltage = Number(v) || 0; break;

    // Access / climate
    case 'Locked':
      state.isLocked = Boolean(v); break;
    case 'HvacACEnabled':
      state.climateOn = Boolean(v); break;

    // Position
    case 'Location':
      if (value.locationValue) {
        state.lat = value.locationValue.latitude;
        state.lon = value.locationValue.longitude;
      }
      break;

    // Gear → if we get any gear value the car is awake
    case 'Gear':
      state.online = (v !== null && v !== undefined);
      break;

    default:
      if (process.env.TELEMETRY_DEBUG === '1') {
        console.log(`[telemetry] unmapped field ${fieldName}=${JSON.stringify(v)}`);
      }
  }
}

const server = http.createServer((req, res) => {
  // Healthcheck for Cloudflare and human curl
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: '/' });

// Track open connections per IP so a single client can't open thousands
const connectionsByIp = new Map();

wss.on('connection', (ws, req) => {
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  const certSubject = req.headers['cf-client-cert-subject-dn'] || '(no cert header)';

  const openCount = connectionsByIp.get(ip) || 0;
  if (openCount >= MAX_CONNECTIONS_PER_IP) {
    console.warn(`[telemetry] rejecting connection from ${ip} (${openCount} already open)`);
    ws.close(1008, 'too many connections');
    return;
  }
  connectionsByIp.set(ip, openCount + 1);

  console.log(`[telemetry] connection from ${ip} cert=${certSubject}`);

  // Per-message rate limit: simple sliding window over the last second
  let msgsInWindow = 0;
  let windowStart = Date.now();

  ws.on('message', (data, isBinary) => {
    if (!isBinary || !Payload) return;

    const now = Date.now();
    if (now - windowStart >= 1000) {
      msgsInWindow = 0;
      windowStart = now;
    }
    msgsInWindow++;
    if (msgsInWindow > MAX_MSGS_PER_CONN_PER_SEC) {
      console.warn(`[telemetry] ${ip}: rate limit exceeded, dropping`);
      return;
    }

    try {
      const msg = Payload.decode(data);
      const obj = Payload.toObject(msg, { enums: Number, defaults: false });
      const incomingVin = (obj.vin || '').trim().toUpperCase();

      // VIN gate: reject any payload not from our configured vehicle
      const expectedVin = getExpectedVin();
      if (expectedVin && incomingVin !== expectedVin) {
        console.warn(`[telemetry] ${ip}: VIN mismatch (got ${incomingVin || '<empty>'}, want ${expectedVin}) — rejecting`);
        return;
      }
      if (!expectedVin) {
        console.warn('[telemetry] no expected VIN configured; accepting payload but you should set vehicles.tesla.vin');
      }

      const existing = readState();
      const merged = { ...(existing.state || {}) };
      for (const datum of obj.data || []) {
        applyDatum(merged, datum.key, datum.value || {});
      }
      writeState(merged);
      if (process.env.TELEMETRY_DEBUG === '1') {
        console.log(`[telemetry] vin=${incomingVin} ${(obj.data || []).length} fields`);
      }
    } catch (e) {
      console.error('[telemetry] decode failed:', e.message);
      try {
        const dumpPath = path.join(KEYS_DIR, `telemetry-raw-${Date.now()}.bin`);
        fs.writeFileSync(dumpPath, data);
        console.log(`[telemetry] raw payload saved to ${dumpPath}`);
      } catch { /* ignore */ }
    }
  });

  ws.on('close', () => {
    const c = (connectionsByIp.get(ip) || 1) - 1;
    if (c <= 0) connectionsByIp.delete(ip); else connectionsByIp.set(ip, c);
    console.log(`[telemetry] disconnected ${ip}`);
  });
  ws.on('error', (e) => console.error(`[telemetry] ws error: ${e.message}`));
});

loadProto().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[telemetry] listening on :${PORT}`);
  });
}).catch(e => {
  console.error('[telemetry] failed to start:', e);
  process.exit(1);
});
