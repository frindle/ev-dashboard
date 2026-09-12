#!/usr/bin/env python3
"""Reference impl for ev-tesla-rest-capture-all.
Applies the intended fix to lib/tesla.ts so the gate can prove the verify goes
green on a correct change, then reverts it. Two edits, single file:
  1) add `raw?: Record<string, unknown>;` to the TeslaVehicleState interface
  2) add `raw: data,` to fetchVehicleState's returned object
Leaves the endpoints string and every typed mapping untouched.
"""
import sys, pathlib

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / "lib" / "tesla.ts"
s = p.read_text()

# 1) interface field -- insert after the last typed OTA field, before the
#    telemetry-only optional block.
iface_anchor = "  otaUpdateAvailable: boolean;\n"
assert s.count(iface_anchor) == 1, f"iface anchor count={s.count(iface_anchor)}"
s = s.replace(
    iface_anchor,
    iface_anchor
    + "\n  // Full parsed vehicle_data REST response, verbatim, so every field the\n"
    + "  // typed mapping ignores still reaches the cache and /api/metrics/influx.\n"
    + "  raw?: Record<string, unknown>;\n",
    1,
)

# 2) return object -- add `raw: data,` before the closing brace of the returned
#    object literal in fetchVehicleState.
ret_anchor = "    otaUpdateAvailable: otaStatus !== '',\n  };"
assert s.count(ret_anchor) == 1, f"return anchor count={s.count(ret_anchor)}"
s = s.replace(
    ret_anchor,
    "    otaUpdateAvailable: otaStatus !== '',\n    raw: data,\n  };",
    1,
)

p.write_text(s)
print("refimpl applied to", p)
