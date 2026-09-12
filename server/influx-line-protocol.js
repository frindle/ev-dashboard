// InfluxDB line-protocol serializer for telemetry points. Pure CommonJS; the
// telemetry sidecar composes buildTelemetryPoints() -> pointsToLineProtocol()
// -> HTTP POST to Influx /api/v2/write. The dispatched task implements
// pointsToLineProtocol in THIS file only.
'use strict';

// Each point is { measurement: string, fields: Record<string, number|boolean|string>,
// timestamp?: number (ms) }. Output: one line per point,
//   <measurement> <field1>=<v1>,<field2>=<v2> <timestampMs>
// joined by "\n". Rules: escape spaces and commas in the measurement, and
// spaces/commas/"=" in field KEYS with a backslash; string field VALUES are
// wrapped in double quotes with embedded " and \ backslash-escaped; boolean
// values become t/f; numeric values are emitted as-is (finite only). Skip
// points with no serializable fields. Omit the trailing timestamp when the
// point has none (or it is non-finite). Never throw on empty input (return "").

function escapeMeasurement(s) {
  return String(s).replace(/[ ,]/g, '\\$&');
}

function escapeKey(k) {
  return String(k).replace(/[ ,=]/g, '\\$&');
}

// Returns the serialized value, or null when the value is not serializable.
function formatValue(v) {
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string') return '"' + v.replace(/(["\\])/g, '\\$1') + '"';
  return null;
}

function pointsToLineProtocol(points) {
  if (!Array.isArray(points)) return '';
  const lines = [];
  for (const point of points) {
    if (!point || typeof point !== 'object') continue;
    const fields = point.fields;
    if (!fields) continue;
    const pairs = [];
    for (const [key, value] of Object.entries(fields)) {
      const serialized = formatValue(value);
      if (serialized === null) continue;
      pairs.push(escapeKey(key) + '=' + serialized);
    }
    if (!pairs.length) continue;
    let line = escapeMeasurement(point.measurement) + ' ' + pairs.join(',');
    if (Number.isFinite(point.timestamp)) line += ' ' + point.timestamp;
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = { pointsToLineProtocol };
