#!/usr/bin/env bash
# verify for: a DIAGNOSIS deliverable (not a code fix)
# Counting idiom, NOT `set -e` -- an aborting verify never prints why it failed.
cd "$(dirname "$0")" || exit 1

fails=0

echo "=== DIAGNOSIS.md present ==="
if [ ! -f DIAGNOSIS.md ]; then
  echo "  FAIL: DIAGNOSIS.md is missing -- the diagnosis deliverable was never written"; fails=$((fails+1))
fi
# The whole contract hangs on this file; without it nothing else can be checked.
[ -f DIAGNOSIS.md ] || { echo "--- $fails failed ---"; exit 1; }

echo "=== DIAGNOSIS.md substantive ==="
sz=$(wc -c < DIAGNOSIS.md)
if [ "$sz" -lt 500 ]; then
  echo "  FAIL: DIAGNOSIS.md is only $sz bytes (< 500) -- too thin to be a real diagnosis"; fails=$((fails+1))
fi

echo "=== required sections ==="
for sec in "Root cause" "Evidence" "Fix sketch" "Falsifiable prediction"; do
  if grep -q "$sec" DIAGNOSIS.md; then
    echo "  ok: section '$sec' present"
  else
    echo "  FAIL: section '$sec' missing from DIAGNOSIS.md"; fails=$((fails+1))
  fi
done

echo "=== file:line grounding ==="
if grep -qE "[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:[0-9]+" DIAGNOSIS.md; then
  echo "  ok: at least one file.ext:line reference cited"
else
  echo "  FAIL: no file.ext:line reference in DIAGNOSIS.md -- the diagnosis is not grounded to code"; fails=$((fails+1))
fi

echo "=== anti-fabrication grounding ==="
# At least one cited path must resolve to a real file in THIS tree.
grounded=0
while IFS= read -r ref; do
  p="${ref%%:*}"
  if [ -f "$p" ]; then grounded=1; break; fi
done < <(grep -oE "[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:[0-9]+" DIAGNOSIS.md)
if [ "$grounded" -eq 1 ]; then
  echo "  ok: a cited path resolves to a real file in the tree"
else
  echo "  FAIL: no cited path in DIAGNOSIS.md is a real file here -- possible fabrication"; fails=$((fails+1))
fi

echo "=== SCOPE OF THIS GATE (read before trusting a pass) ==="
echo "  This verify checks the diagnosis's STRUCTURE only -- sections present,"
echo "  file:line grounding, cited path real. It does NOT and cannot validate that"
echo "  the claimed mechanism is CORRECT. A green diagnosis is UNVERIFIED, not proven:"
echo "  run the 'Falsifiable prediction' against the code/data before acting on it."

echo "--- $fails failed ---"
[ "$fails" -eq 0 ] && echo VERIFY_OK || exit 1
