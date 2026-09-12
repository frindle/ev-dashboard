#!/usr/bin/env python3
"""Reference impl for: ev-influx-write-request. Adds buildInfluxWriteRequest,
keeps buildTelemetryPoints intact, extends the exports."""
import pathlib, sys
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'server/telemetry-influx.js'
t = p.read_text()

OLD = "module.exports = { buildTelemetryPoints };"
NEW = '''function buildInfluxWriteRequest(state, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  if (!o.influxUrl || !o.influxToken) return null;
  const points = buildTelemetryPoints(state, { vacationMode: o.vacationMode, ts: o.ts });
  const body = require('./influx-line-protocol').pointsToLineProtocol(points);
  if (!body) return null;
  const base = String(o.influxUrl).replace(/\\/$/, '');
  const url = base + '/api/v2/write?org=' + encodeURIComponent(o.influxOrg == null ? '' : o.influxOrg) +
    '&bucket=' + encodeURIComponent(o.influxBucket == null ? '' : o.influxBucket) + '&precision=ms';
  return {
    url,
    method: 'POST',
    headers: { 'Authorization': 'Token ' + o.influxToken, 'Content-Type': 'text/plain; charset=utf-8' },
    body,
  };
}

module.exports = { buildTelemetryPoints, buildInfluxWriteRequest };'''

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
