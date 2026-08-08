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
const { ByteBuffer } = require('flatbuffers');

// The vehicle does NOT send a raw protobuf Payload over the WebSocket --
// it wraps it in a FlatBuffers envelope (confirmed against Tesla's own
// teslamotors/fleet-telemetry repo: messages/tesla/FlatbuffersEnvelope.go,
// FlatbuffersStream.go, Message.go, verified byte-for-byte against a real
// captured payload). Envelope fields (vtable slot -> byte offset): Txid=4,
// Topic=6, MessageType=8, Message=10 (union), MessageId=12. MessageType 4 =
// FlatbuffersStream, whose fields are: CreatedAt=4, SenderId=6, Payload=8
// (byte vector -- the actual protobuf-encoded Payload our schema decodes),
// DeviceType=10 (constant "vehicle_device"), DeviceId=12 (the vehicle's VIN,
// straight from its mTLS cert CN). Decoding the raw WS frame directly as
// protobuf (the old code) fails immediately since FlatBuffers and protobuf
// are structurally unrelated wire formats. Also: the inner protobuf Payload
// does NOT reliably carry a `vin` field in this wire format (a real captured
// payload had none) -- DeviceId is the actual source of truth for VIN gating.
const MSG_TYPE_FLATBUFFERS_STREAM = 4;

function extractStreamMessage(data) {
  const bb = new ByteBuffer(data);
  const envelopePos = bb.readInt32(bb.position()) + bb.position();

  const messageType = readByteField(bb, envelopePos, 8);
  if (messageType !== MSG_TYPE_FLATBUFFERS_STREAM) return null; // e.g. StreamAck, ignore

  const messageOffset = bb.__offset(envelopePos, 10);
  if (!messageOffset) return null;
  const streamPos = bb.__indirect(envelopePos + messageOffset);

  const payloadFieldOffset = bb.__offset(streamPos, 8);
  if (!payloadFieldOffset) return null;
  const vectorStart = bb.__vector(streamPos + payloadFieldOffset);
  const vectorLen = bb.__vector_len(streamPos + payloadFieldOffset);
  const protoBytes = bb.bytes().subarray(vectorStart, vectorStart + vectorLen);

  const vin = readByteVectorField(bb, streamPos, 12);
  return { protoBytes, vin };
}

function readByteField(bb, tablePos, vtableOffset) {
  const offset = bb.__offset(tablePos, vtableOffset);
  return offset ? bb.readUint8(tablePos + offset) : 0;
}

function readByteVectorField(bb, tablePos, vtableOffset) {
  const offset = bb.__offset(tablePos, vtableOffset);
  if (!offset) return '';
  const start = bb.__vector(tablePos + offset);
  const len = bb.__vector_len(tablePos + offset);
  return Buffer.from(bb.bytes().subarray(start, start + len)).toString('utf-8');
}

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
  // Message-typed variants (locationValue, tireLocationValue, timeValue,
  // doorValue) are objects, not scalars -- their cases below read
  // value.<name> directly instead of through v, same pattern as Location.
  const v = value.stringValue ?? value.intValue ?? value.longValue
         ?? value.floatValue ?? value.doubleValue ?? value.booleanValue
         ?? value.locationValue ?? value.chargingValue ?? value.shiftStateValue
         ?? value.detailedChargeStateValue ?? value.hvacPowerValue
         ?? value.sentryModeStateValue ?? value.chargePortLatchValue
         ?? value.fastChargerValue ?? value.cableTypeValue
         ?? value.scheduledChargingModeValue ?? null;

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

    // Charging state — enum values shared by both ChargeState and
    // DetailedChargeState (protos/vehicle_data.proto): 0 Unknown,
    // 1 Disconnected, 2 NoPower, 3 Starting, 4 Charging, 5 Complete,
    // 6 Stopped. Plugged in is anything except Unknown/Disconnected --
    // NoPower/Stopped/Complete all still mean a cable is connected.
    case 'ChargeState':
    case 'DetailedChargeState':
      state.isCharging = (v === 4);
      state.isPluggedIn = (v !== 0 && v !== 1);
      state.chargingState = String(v);
      // Per-field timestamp -- writeState() stamps ONE fetchedAt for the
      // whole merged object regardless of which field actually changed, so
      // "cache is recent" doesn't mean "this specific field is recent" (a
      // Soc-only datum bumps fetchedAt without touching isPluggedIn at all).
      // Confirmed 2026-08-08: this let a stale isPluggedIn=true survive
      // indefinitely past when the car was actually unplugged and driven
      // away, as long as SOME telemetry kept trickling in. route.ts gates
      // isPluggedIn trust on this specifically now, not on fetchedAt.
      state._chargeStateUpdatedAt = Date.now();
      break;

    // Charging power / progress -- ChargeAmps is actual amps, NOT mph;
    // these used to share one field (bug, caught 2026-07-25 when both got
    // subscribed at once -- whichever arrived last silently overwrote
    // chargeRateMph with a wrong-unit number).
    case 'ChargeAmps':
      state.chargerActualCurrentA = Number(v) || 0; break;
    case 'ChargeRateMilePerHour':
      state.chargeRateMph = Number(v) || 0; break;
    case 'TimeToFullCharge':
      // Tesla reports hours as float, our model uses minutes
      state.minutesToFull = Math.round((Number(v) || 0) * 60); break;
    case 'ChargerVoltage':
      state.chargerVoltage = Number(v) || 0; break;
    // Reported directly by the vehicle (accounts for phases/power factor),
    // more accurate than deriving amps * voltage ourselves.
    case 'ACChargingPower':
      state.chargerPowerKw = Number(v) || 0; break;

    // Access / climate
    case 'Locked':
      state.isLocked = Boolean(v); break;
    // HvacPower is the real on/off state of the whole climate system
    // (HvacPowerState: 0 Unknown, 1 Off, 2 On, 3 Precondition, 4 OverheatProtect).
    // HvacACEnabled (still subscribed, unused here) is only the AC/cooling
    // subsystem specifically -- it can read false while climate is still on
    // running fan-only/heat-only/defrost, which caused a stuck "climate on"
    // display after it got used for this instead (caught 2026-07-25).
    case 'HvacPower':
      state.climateOn = (v === 2 || v === 3 || v === 4); break;
    case 'BatteryHeaterOn':
      state.batteryHeaterOn = Boolean(v); break;
    case 'PreconditioningEnabled':
      state.preconditioningEnabled = Boolean(v); break;
    case 'WiperHeatEnabled':
      state.wiperHeatEnabled = Boolean(v); break;

    // Position
    case 'Location':
      if (value.locationValue) {
        state.lat = value.locationValue.latitude;
        state.lon = value.locationValue.longitude;
        // Per-field timestamp -- see the same comment on ChargeState above.
        // This is the one route.ts's atHome detection now trusts instead
        // of the whole-object fetchedAt (was letting a stale position read
        // as "home" indefinitely once the car stopped sending Location but
        // kept trickling other telemetry).
        state._locationUpdatedAt = Date.now();
      }
      break;
    case 'GpsHeading':
      state.gpsHeadingDeg = Number(v) || 0; break;
    case 'GpsState':
      state.gpsState = v; break;
    case 'LocatedAtHome':
      state.locatedAtHome = Boolean(v); break;
    case 'LocatedAtWork':
      state.locatedAtWork = Boolean(v); break;
    case 'LocatedAtFavorite':
      state.locatedAtFavorite = Boolean(v); break;

    // Driving
    case 'VehicleSpeed':
      state.speedMph = Number(v) || 0; break;

    // Gear → if we get any gear value the car is awake. Also expose the
    // actual P/R/N/D value (mirrors Rivian's gearStatus) -- previously
    // thrown away, which is why the arrival webhook had to hardcode
    // isDriving=true for Tesla instead of checking a real gear state.
    case 'Gear': {
      state.online = (v !== null && v !== undefined);
      const GEAR_MAP = { 2: 'park', 3: 'reverse', 4: 'neutral', 5: 'drive' };
      state.gearStatus = GEAR_MAP[v] || '';
      break;
    }

    // Security
    // SentryModeState: 0 Unknown, 1 Off, 2 Idle, 3 Armed, 4 Aware, 5 Panic, 6 Quiet
    case 'SentryMode':
      state.sentryModeState = v; break;
    case 'ValetModeEnabled':
      state.valetModeEnabled = Boolean(v); break;

    // Doors -- reuses the Doors message (same type as DoorState).
    case 'DoorState':
      if (value.doorValue) state.doorsOpen = value.doorValue;
      break;

    // Tire pressure -- not surfaced in the UI yet, captured for a future
    // parity feature with Rivian's tirePressureLow flags.
    case 'TpmsPressureFl':
      state.tpmsPressureFl = Number(v) || 0; break;
    case 'TpmsPressureFr':
      state.tpmsPressureFr = Number(v) || 0; break;
    case 'TpmsPressureRl':
      state.tpmsPressureRl = Number(v) || 0; break;
    case 'TpmsPressureRr':
      state.tpmsPressureRr = Number(v) || 0; break;
    case 'TpmsSoftWarnings':
      if (value.tireLocationValue) state.tpmsSoftWarnings = value.tireLocationValue;
      break;
    case 'TpmsHardWarnings':
      if (value.tireLocationValue) state.tpmsHardWarnings = value.tireLocationValue;
      break;

    // Charge port / cable
    case 'ChargePortDoorOpen':
      state.chargePortDoorOpen = Boolean(v); break;
    // ChargePortLatchValue: 0 Unknown, 1 SNA, 2 Disengaged, 3 Engaged, 4 Blocking
    case 'ChargePortLatch':
      state.chargePortLatch = v; break;
    // CableType: 0 Unknown, 1 IEC, 2 SAE, 3 GB_AC, 4 GB_DC, 5 SNA
    case 'ChargingCableType':
      state.chargingCableType = v; break;
    case 'FastChargerPresent':
      state.fastChargerPresent = Boolean(v); break;
    // FastCharger: 0 Unknown, 1 Supercharger, 2 CHAdeMO, 3 GB, 4 ACSingleWireCAN,
    // 5 Combo, 6 MCSingleWireCAN, 7 Other, 8 SNA
    case 'FastChargerType':
      state.fastChargerType = v; break;

    // OTA -- not surfaced in the UI yet, the OTA feature currently reads
    // from the REST poll's vehicle_state.software_update instead. Captured
    // here so it's available to switch to telemetry (zero poll cost) later.
    case 'SoftwareUpdateVersion':
      state.otaVersion = v; break;
    case 'SoftwareUpdateDownloadPercentComplete':
      state.otaDownloadPercent = Number(v) || 0; break;
    case 'SoftwareUpdateInstallationPercentComplete':
      state.otaInstallPercent = Number(v) || 0; break;
    case 'SoftwareUpdateExpectedDurationMinutes':
      state.otaExpectedDurationMin = Number(v) || 0; break;
    case 'SoftwareUpdateScheduledStartTime':
      if (value.timeValue) state.otaScheduledStartTime = value.timeValue;
      break;

    // Scheduled charging -- not surfaced in the UI yet.
    case 'ScheduledChargingPending':
      state.scheduledChargingPending = Boolean(v); break;
    case 'ScheduledChargingStartTime':
      if (value.timeValue) state.scheduledChargingStartTime = value.timeValue;
      break;
    case 'ScheduledDepartureTime':
      if (value.timeValue) state.scheduledDepartureTime = value.timeValue;
      break;
    // ScheduledChargingModeValue: 0 Unknown, 1 Off, 2 StartAt, 3 DepartBy
    case 'ScheduledChargingMode':
      state.scheduledChargingMode = v; break;

    // Trip stats -- not surfaced in the UI yet.
    case 'MilesSinceReset':
      state.milesSinceReset = Number(v) || 0; break;

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
      const stream = extractStreamMessage(data);
      if (!stream) return; // non-stream envelope message (e.g. StreamAck), nothing to decode

      const msg = Payload.decode(stream.protoBytes);
      const obj = Payload.toObject(msg, { enums: Number, defaults: false });
      // The protobuf Payload doesn't reliably carry `vin` in this wire format
      // -- the FlatBuffers envelope's DeviceId field is the real source.
      const incomingVin = (stream.vin || obj.vin || '').trim().toUpperCase();

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
