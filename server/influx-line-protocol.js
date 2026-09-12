// InfluxDB line-protocol serializer for telemetry points. Pure CommonJS; the
// telemetry sidecar composes buildTelemetryPoints() -> pointsToLineProtocol()
// -> HTTP POST to Influx /api/v2/write. The dispatched task implements
// pointsToLineProtocol in THIS file only.
'use strict';

// TODO(dispatch): serialize an array of points to InfluxDB line protocol.
// Each point is { measurement: string, fields: Record<string, number|boolean|string>,
// timestamp?: number (ms) }. Output: one line per point,
//   <measurement> <field1>=<v1>,<field2>=<v2> <timestampMs>
// joined by "\n". Rules: escape spaces, commas and "=" in measurement and field
// KEYS with a backslash; string field VALUES are wrapped in double quotes with
// embedded " and \ backslash-escaped; boolean values become t/f; numeric values
// are emitted as-is (finite only). Skip points with no fields. Omit the trailing
// timestamp when the point has none. Never throw on empty input (return "").
function pointsToLineProtocol(points) {
  return '';
}

module.exports = { pointsToLineProtocol };
