#!/usr/bin/env python3
"""Reference impl for: ev-tesla-capture-all

The gate applies this, runs the verify, and reverts it. It proves the task is
SATISFIABLE and the verify ENFORCES the spec. Simplest change: make applyDatum's
existing default clause CAPTURE the unmapped field under state.raw[fieldName]
instead of only logging it under TELEMETRY_DEBUG.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'server/telemetry-server.js'
t = p.read_text()

OLD = """    default:
      if (process.env.TELEMETRY_DEBUG === '1') {"""
NEW = """    default:
      // Full-fidelity capture: any field without an explicit case above is kept
      // raw under its canonical Field-enum name, so nothing Tesla streams is
      // dropped before writeState() (feeds /api/metrics/influx -> InfluxDB).
      if (v !== null && v !== undefined) {
        state.raw = state.raw || {};
        state.raw[fieldName] = v;
      }
      if (process.env.TELEMETRY_DEBUG === '1') {"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
