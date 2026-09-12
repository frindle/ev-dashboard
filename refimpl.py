#!/usr/bin/env python3
"""Reference impl for: ev-telemetry-influx.

Copies the finished telemetry-influx.js (kept OUTSIDE the worktree in scratchpad,
so refimpl-reverted removes it and the model never starts from the answer) into
the target. Proves the task is satisfiable and the verify enforces the spec.
"""
import pathlib, sys, shutil

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
target = wt / 'server/telemetry-influx.js'
body = pathlib.Path("/private/tmp/claude-501/-Users-penn-Desktop-GitHub-Projects/d4bee9e0-131a-4fe1-bbb1-c183c7d42a03/scratchpad/ev_telemetry_influx_refimpl.js")
assert body.exists(), f"refimpl body missing: {body}"
shutil.copyfile(body, target)
print("refimpl applied")
