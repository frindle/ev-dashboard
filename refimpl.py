#!/usr/bin/env python3
"""Reference impl for: ev-lineprotocol (copies scratchpad body into target)."""
import pathlib, sys, shutil
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
target = wt / 'server/influx-line-protocol.js'
body = pathlib.Path("/private/tmp/claude-501/-Users-penn-Desktop-GitHub-Projects/d4bee9e0-131a-4fe1-bbb1-c183c7d42a03/scratchpad/ev_lineprotocol_refimpl.js")
assert body.exists(), f"refimpl body missing: {body}"
shutil.copyfile(body, target)
print("refimpl applied")
