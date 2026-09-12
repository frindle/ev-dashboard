#!/usr/bin/env bash
# verify for: ev-tesla-rest-capture-all (--kind expression)
# Counting idiom, NOT `set -e` -- an aborting verify never prints why it failed.
cd "$(dirname "$0")" || exit 1

fails=0
NODE=$(command -v node)     # the queue daemon runs under launchd's PATH
[ -n "$NODE" ] || { echo "  FAIL: node not on PATH"; exit 1; }

echo "=== env bootstrap ==="
# A DANGLING node_modules symlink (the scaffold linked the worktree to the
# source, then the source's node_modules went away) is `[ ! -d ]`-true, so the
# old check fell through to `npm ci`, which then errors on the pre-existing
# symlink path. Remove a broken symlink first so npm can install cleanly.
if [ -L ./node_modules ] && [ ! -e ./node_modules ]; then
  echo "  node_modules is a dangling symlink -- removing so npm can install"
  rm -f ./node_modules
fi
if [ ! -d ./node_modules ]; then
  echo "  node_modules absent -- npm ci for env parity (tsc/tests need deps)"
  if [ -f package-lock.json ]; then _NPM="npm ci"; else _NPM="npm install"; fi
  if $_NPM >/tmp/_verify_npm.$$.log 2>&1; then echo "  ok: $_NPM"; else echo "  FAIL: $_NPM failed"; tail -20 /tmp/_verify_npm.$$.log; fails=$((fails+1)); fi
  rm -f /tmp/_verify_npm.$$.log
fi
_SCHEMA=""
[ -f prisma/schema.prisma ] && _SCHEMA=prisma/schema.prisma
[ -z "$_SCHEMA" ] && _SCHEMA=$(ls prisma/schema/*.prisma 2>/dev/null | head -1)
if [ -n "$_SCHEMA" ] && grep -q "generator" "$_SCHEMA" 2>/dev/null; then
  _OUT=$(grep -oE 'output[[:space:]]*=[[:space:]]*"[^"]+"' "$_SCHEMA" | head -1 | sed -E 's/.*"([^"]+)"/\1/')
  _SDIR=$(dirname "$_SCHEMA")
  _SKIP_PRISMA=""
  case "$_OUT" in
    /*) _ABS="$_OUT" ;;
    "") _ABS="node_modules/.prisma/client"
        # Default output lands INSIDE node_modules. When that is symlinked to the
        # source checkout, `prisma generate` writes into the SOURCE repo (outside
        # this worktree, and wrong if the schemas differ). Skip rather than
        # corrupt the source -- generate in the source repo, or set a
        # worktree-local `output` in the schema's generator block.
        if [ -L node_modules ]; then _SKIP_PRISMA=1; fi ;;
    *)  _ABS="$_SDIR/$_OUT" ;;
  esac
  if [ -n "$_SKIP_PRISMA" ]; then
    echo "  WARN: node_modules is symlinked to the source; skipping default-output prisma generate (would write into the source repo). Generate there, or set a worktree-local output in the schema."
  elif [ -d "$_ABS" ] && [ -n "$(ls -A "$_ABS" 2>/dev/null)" ]; then
    echo "  ok: prisma client present ($_ABS)"
  else
    echo "  prisma client missing ($_ABS) -- npx prisma generate"
    if npx --yes prisma generate >/tmp/_verify_prisma.$$.log 2>&1; then echo "  ok: prisma generate"; else echo "  WARN: prisma generate failed (continuing; tsc may flood with TS7006)"; tail -20 /tmp/_verify_prisma.$$.log; fi
    rm -f /tmp/_verify_prisma.$$.log
  fi
fi

# Expression mode extracts+evals the target as TEXT, so the fixture is plain ESM
# JS run under node -- no tsx (that is only for resolving a typed import). tsc is
# still the authoritative type gate on the target file.
if [ -x ./node_modules/.bin/tsc ]; then TSC="./node_modules/.bin/tsc"; else TSC="npx --yes tsc"; fi

echo "=== target parses ==="
# ts-parse is a convenience floor (TS analogue of `ast.parse`). NOT authoritative
# here: `tsc --noEmit` below parses AND type-checks the target. The ts-parse
# sidecar needs `typescript` installed in its own dir (bin/ts-mutator); when that
# is absent it cannot load -- WARN rather than FAIL so the gap does not read as a
# broken target.
if "$NODE" '/Users/penn/bin/ts-mutator/ts-parse.mjs' 'lib/tesla.ts' 2>/tmp/_verify_parse.$$.log; then
  echo "  ok: lib/tesla.ts parses"
elif grep -qiE "ERR_MODULE_NOT_FOUND|Cannot find (package|module) 'typescript'" /tmp/_verify_parse.$$.log; then
  echo "  WARN: ts-parse sidecar not installed (needs 'typescript' in bin/ts-mutator) -- relying on tsc --noEmit below"
else
  echo "  FAIL: lib/tesla.ts does not parse"; head -5 /tmp/_verify_parse.$$.log; fails=$((fails+1))
fi
rm -f /tmp/_verify_parse.$$.log

echo "=== types (tsc --noEmit) ==="
# Run the project check, but only FAIL when the error is in the file the model
# edited (lib/tesla.ts). Pre-existing errors elsewhere WARN and pass.
if $TSC --noEmit -p tsconfig.json >/tmp/_verify_tsc.$$.log 2>&1; then
  echo "  ok: tsc --noEmit clean"
elif grep -qE 'lib/tesla\.ts[(:]' /tmp/_verify_tsc.$$.log; then
  echo "  FAIL: tsc --noEmit reports errors in lib/tesla.ts"; grep -E 'lib/tesla\.ts[(:]' /tmp/_verify_tsc.$$.log | head -15; fails=$((fails+1))
else
  echo "  WARN: tsc --noEmit has pre-existing errors OUTSIDE lib/tesla.ts (not this task's) -- passing type gate"
fi
rm -f /tmp/_verify_tsc.$$.log

echo "=== spec literals ==="
if python3 ./check_literals.py; then
  echo "  ok: every Must-contain literal present"
else
  echo "  FAIL: a Must-contain literal is missing"; fails=$((fails+1))
fi

echo "=== behavioural cases (expression extract + eval) ==="
# node (not tsx): the fixture reads the target as text and evals it; nothing to
# type-strip or import-resolve.
if "$NODE" ./verify_impl.mjs; then
  echo "  ok: adversarial cases pass"
else
  echo "  FAIL: adversarial cases failed"; fails=$((fails+1))
fi

echo "--- $fails failed ---"
[ "$fails" -eq 0 ] && echo VERIFY_OK || exit 1
