#!/usr/bin/env python3
"""Reference impl: buildInfluxLineProtocol composes all 5 sections -> line protocol."""
import pathlib, sys
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'server/telemetry-influx.js'
t = p.read_text()
OLD = "module.exports = { buildTelemetryPoints };"
NEW = '''function buildInfluxLineProtocol(sources, opts) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return '';
  const o = (opts && typeof opts === 'object') ? opts : {};
  const SECTIONS = [
    ['rivianRaw', 'ev_rivian_raw'],
    ['rivianState', 'ev_rivian_state'],
    ['teslaState', 'ev_tesla_state'],
    ['parallax', 'ev_parallax'],
    ['lastStatus', 'ev_last_status'],
  ];
  const points = [];
  for (const [key, measurement] of SECTIONS) {
    const section = sources[key];
    if (section == null) continue;
    const pts = buildTelemetryPoints(section, { vacationMode: o.vacationMode, ts: o.ts, measurement });
    for (const pt of pts) points.push(pt);
  }
  return require('./influx-line-protocol').pointsToLineProtocol(points);
}

module.exports = { buildTelemetryPoints, buildInfluxLineProtocol };'''
assert OLD in t, "refimpl anchor not found"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
