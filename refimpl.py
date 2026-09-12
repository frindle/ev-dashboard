#!/usr/bin/env python3
"""Reference impl for: ev-influx-dualwrite.

Applies the SIMPLEST correct wiring of the InfluxDB dual-write into
server/telemetry-server.js. The gate applies this, runs verify, then reverts it:
proves the task is satisfiable AND that verify enforces the spec.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'server/telemetry-server.js'
t = p.read_text()

# 1. require the composition module (near the other requires)
OLD_REQ = "const { ByteBuffer } = require('flatbuffers');"
NEW_REQ = (
    "const { ByteBuffer } = require('flatbuffers');\n"
    "const { buildInfluxWriteRequest } = require('./telemetry-influx');"
)
assert OLD_REQ in t, "require anchor not found"
t = t.replace(OLD_REQ, NEW_REQ, 1)

# 2. add getVacationMode() right after getExpectedVin()
OLD_VIN = (
    "function getExpectedVin() {\n"
    "  try {\n"
    "    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));\n"
    "    return (cfg?.vehicles?.tesla?.vin || '').trim().toUpperCase();\n"
    "  } catch { return ''; }\n"
    "}"
)
NEW_VIN = OLD_VIN + (
    "\n\n"
    "function getVacationMode() {\n"
    "  try {\n"
    "    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));\n"
    "    return Boolean(cfg && cfg.vacationMode);\n"
    "  } catch { return false; }\n"
    "}\n\n"
    "// Compose + fire the InfluxDB /api/v2/write POST for a telemetry state.\n"
    "// No-op unless all four INFLUX_* env vars are set. Returns the fetch promise\n"
    "// (or undefined when it does not fire) so callers/tests can observe it.\n"
    "function maybeWriteInflux(state, opts = {}) {\n"
    "  const influxUrl = process.env.INFLUX_URL;\n"
    "  const influxToken = process.env.INFLUX_TOKEN;\n"
    "  const influxOrg = process.env.INFLUX_ORG;\n"
    "  const influxBucket = process.env.INFLUX_BUCKET;\n"
    "  if (!influxUrl || !influxToken || !influxOrg || !influxBucket) return;\n"
    "  const req = buildInfluxWriteRequest(state, {\n"
    "    influxUrl, influxToken, influxOrg, influxBucket,\n"
    "    measurement: process.env.INFLUX_MEASUREMENT,\n"
    "    vacationMode: opts.vacationMode,\n"
    "  });\n"
    "  if (!req) return;\n"
    "  return fetch(req.url, { method: req.method, headers: req.headers, body: req.body });\n"
    "}"
)
assert OLD_VIN in t, "getExpectedVin anchor not found"
t = t.replace(OLD_VIN, NEW_VIN, 1)

# 3. dual-write from writeState, after the JSON write, non-blocking + crash-proof
OLD_WS = (
    "function writeState(state) {\n"
    "  try {\n"
    "    fs.writeFileSync(STATE_FILE, JSON.stringify({ state, fetchedAt: Date.now(), source: 'telemetry' }));\n"
    "  } catch (e) {\n"
    "    console.error('[telemetry] write failed:', e.message);\n"
    "  }\n"
    "}"
)
NEW_WS = (
    "function writeState(state) {\n"
    "  try {\n"
    "    fs.writeFileSync(STATE_FILE, JSON.stringify({ state, fetchedAt: Date.now(), source: 'telemetry' }));\n"
    "  } catch (e) {\n"
    "    console.error('[telemetry] write failed:', e.message);\n"
    "  }\n"
    "  // Best-effort InfluxDB dual-write -- never blocks or throws into the\n"
    "  // telemetry/JSON path (fire-and-forget, errors swallowed+logged).\n"
    "  try {\n"
    "    const p = maybeWriteInflux(state, { vacationMode: getVacationMode() });\n"
    "    if (p && typeof p.catch === 'function') p.catch((e) => console.error('[telemetry] influx write failed:', e.message));\n"
    "  } catch (e) {\n"
    "    console.error('[telemetry] influx write failed:', e.message);\n"
    "  }\n"
    "}"
)
assert OLD_WS in t, "writeState anchor not found"
t = t.replace(OLD_WS, NEW_WS, 1)

# 4. guard startup so importing the module is side-effect-free
OLD_START = (
    "loadProto().then(() => {\n"
    "  server.listen(PORT, '0.0.0.0', () => {\n"
    "    console.log(`[telemetry] listening on :${PORT}`);\n"
    "  });\n"
    "}).catch(e => {\n"
    "  console.error('[telemetry] failed to start:', e);\n"
    "  process.exit(1);\n"
    "});"
)
# Keep the inner startup lines BYTE-IDENTICAL (same indent) so only the guard
# line is a changed line. The guard is unobservable in-process (server startup
# needs a subprocess to exercise) -> annotated so the relevance mutator skips it.
NEW_START = (
    "if (require.main === module) { // relevance: unobservable -- server startup, not exercised by in-process unit tests\n"
    "loadProto().then(() => {\n"
    "  server.listen(PORT, '0.0.0.0', () => {\n"
    "    console.log(`[telemetry] listening on :${PORT}`);\n"
    "  });\n"
    "}).catch(e => {\n"
    "  console.error('[telemetry] failed to start:', e);\n"
    "  process.exit(1);\n"
    "});\n"
    "}\n\n"
    "module.exports = { writeState, maybeWriteInflux };"
)
assert OLD_START in t, "startup anchor not found"
t = t.replace(OLD_START, NEW_START, 1)

p.write_text(t)
print("refimpl applied")
