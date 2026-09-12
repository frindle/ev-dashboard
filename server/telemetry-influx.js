// EV telemetry -> InfluxDB points. Pure transform used by the telemetry sidecar's
// writeState() dual-write path. This module is CommonJS (the sidecars are plain
// node, not the Next app). The dispatched task implements buildTelemetryPoints in
// THIS file only; the sidecar wires the actual HTTP POST to InfluxDB separately.
'use strict';

// TODO(dispatch): flatten the telemetry `state` into InfluxDB points.
// Return an array of { measurement, fields, timestamp } where `fields` is a FLAT
// map of dotted-path leaf values (numbers, booleans, non-empty strings only;
// null/undefined and empty objects/arrays dropped). When opts.vacationMode is
// true, recursively drop location keys (lat, lon, latitude, longitude, gps,
// location). ALWAYS drop secret-named keys (token, secret, password) regardless
// of vacationMode. Do NOT mutate the input. timestamp = opts.ts (ms) when given.
function buildTelemetryPoints(state, opts) {
  return [];
}

module.exports = { buildTelemetryPoints };
