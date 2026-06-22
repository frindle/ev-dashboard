// Tesla Fleet Telemetry receiver.
//
// Architecture:
//   Tesla vehicle → mTLS (validated by Cloudflare Access at edge) →
//   Cloudflare Tunnel (HTTPS) → this server (plain ws on localhost) →
//   decodes protobuf → writes keys/tesla-state.json
//
// Cloudflare strips the mTLS layer at the edge after validation, so this
// server accepts plain WebSocket connections. Trust is enforced by the fact
// that only Cloudflare Tunnel can reach this port (not exposed externally).

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

// Map a single Datum into our TeslaVehicleState shape. Many of these are
// best-effort — Tesla's field semantics aren't fully documented and this
// will need iteration once we see real production data. Unknown keys are
// logged for visibility.
function applyDatum(state, key, value) {
  const fieldName = fieldNumberToName.get(key) || `Field${key}`;
  // value is an object with one populated oneof field
  const v = value.stringValue ?? value.intValue ?? value.longValue
         ?? value.floatValue ?? value.doubleValue ?? value.booleanValue
         ?? value.locationValue ?? value.chargingValue ?? value.shiftStateValue
         ?? value.asleep ?? value.doorValue ?? value.tireValue
         ?? value.detailedChargeStateValue ?? null;

  switch (fieldName) {
    case 'BatteryLevel':
    case 'Soc':
      state.chargePercent = Number(v) || 0; break;
    case 'ChargeLimitSoc':
      state.chargeLimit = Number(v) || 80; break;
    case 'ChargingState':
    case 'DetailedChargeStateField':
      // v is an enum number like ChargeStateCharging = 4
      state.isCharging = (v === 4 || v === 'ChargeStateCharging' || v === 'DetailedChargeStateCharging');
      state.chargingState = String(v); break;
    case 'Locked':
      state.isLocked = Boolean(v); break;
    case 'HvacACEnabled':
      state.climateOn = Boolean(v); break;
    case 'IdealBatteryRange':
    case 'EstBatteryRange':
    case 'RatedRange':
      state.rangeMi = Number(v) || 0; break;
    case 'Odometer':
      state.odometer = Number(v) || 0; break;
    case 'ChargeRateMilePerHour':
      state.chargeRateMph = Number(v) || 0; break;
    case 'TimeToFullCharge':
      // Tesla reports hours as float, our model uses minutes
      state.minutesToFull = Math.round((Number(v) || 0) * 60); break;
    case 'ChargerActualCurrent':
      state.chargerActualCurrentA = Number(v) || 0; break;
    case 'ChargerVoltage':
      state.chargerVoltage = Number(v) || 0; break;
    case 'Location':
      if (value.locationValue) {
        state.lat = value.locationValue.latitude;
        state.lon = value.locationValue.longitude;
      }
      break;
    case 'Gear':
      // ShiftStateP = 2 means parked — vehicle is online
      state.online = (v !== null && v !== undefined);
      break;
    default:
      // Log unknown so we can grow the mapping table
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
