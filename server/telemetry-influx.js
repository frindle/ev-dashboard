// EV telemetry -> InfluxDB points. Pure transform used by the telemetry sidecar's
// writeState() dual-write path. This module is CommonJS (the sidecars are plain
// node, not the Next app). The dispatched task implements buildTelemetryPoints in
// THIS file only; the sidecar wires the actual HTTP POST to InfluxDB separately.
'use strict';

const DEFAULT_MEASUREMENT = 'ev_telemetry';
// Secret-named keys (token / secret / password) are ALWAYS dropped, at any depth,
// regardless of vacationMode -- matched as a case-insensitive substring so that
// apiToken, secretKey, dbPassword etc. all scrub out.
const SECRET_KEY_PARTS = ['token', 'secret', 'password'];
// Location keys recursively dropped when opts.vacationMode is true.
const LOCATION_KEYS = new Set(['lat', 'lon', 'latitude', 'longitude', 'gps', 'location']);

function isSecretKey(key) {
  const k = String(key).toLowerCase();
  return SECRET_KEY_PARTS.some((part) => k.includes(part));
}

function isLocationKey(key, vacationMode) {
  if (!vacationMode) return false;
  return LOCATION_KEYS.has(String(key).toLowerCase());
}

// Recursively flatten `value` into the flat dotted-path map `out`. Never mutates
// its input -- it only reads and rebuilds. Dropped: null/undefined, empty strings,
// non-finite numbers (NaN/Infinity are not valid Influx floats), secret keys, and
// location keys under vacationMode. Empty objects/arrays simply contribute no leaf.
function flatten(value, prefix, out, opts) {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === 'number') {
    if (Number.isFinite(value)) out[prefix] = value;
    return;
  }
  if (t === 'boolean' || t === 'string') {
    if (value !== '') out[prefix] = value;
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) flatten(value[i], prefix + '.' + i, out, opts);
    return;
  }
  if (t === 'object') {
    for (const key of Object.keys(value)) {
      if (isSecretKey(key) || isLocationKey(key, opts.vacationMode)) continue;
      flatten(value[key], prefix ? prefix + '.' + key : String(key), out, opts);
    }
  }
}

function buildTelemetryPoints(state, opts) {
  const options = (opts && typeof opts === 'object') ? opts : {};
  if (!state || typeof state !== 'object' || Array.isArray(state)) return [];
  const fields = {};
  flatten(state, '', fields, options);
  if (Object.keys(fields).length === 0) return [];
  const point = {
    measurement: (typeof options.measurement === 'string' && options.measurement !== '')
      ? options.measurement
      : DEFAULT_MEASUREMENT,
    fields,
  };
  if (typeof options.ts === 'number') point.timestamp = options.ts;
  return [point];
}

// Compose the InfluxDB /api/v2/write POST request for a telemetry state. Pure:
// no I/O, no mutation of `state`/`opts`. Returns null when there is nothing to
// write (empty body) or when influxUrl/influxToken are missing -- callers must
// not guess credentials or fire an empty POST.
function buildInfluxWriteRequest(state, opts) {
  const options = (opts && typeof opts === 'object') ? opts : {};
  const influxUrl = options.influxUrl;
  const influxToken = options.influxToken;
  if (!influxUrl || !influxToken) return null;
  const points = buildTelemetryPoints(state, { vacationMode: options.vacationMode, ts: options.ts });
  const body = require('./influx-line-protocol').pointsToLineProtocol(points);
  if (body === '') return null;
  let base = String(influxUrl);
  if (base.endsWith('/')) base = base.slice(0, -1); // trim exactly ONE trailing slash
  const org = encodeURIComponent(String(options.influxOrg || ''));
  const bucket = encodeURIComponent(String(options.influxBucket || ''));
  return {
    url: base + '/api/v2/write?org=' + org + '&bucket=' + bucket + '&precision=ms',
    method: 'POST',
    headers: {
      Authorization: 'Token ' + influxToken,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body,
  };
}

module.exports = { buildTelemetryPoints, buildInfluxWriteRequest };
