#!/usr/bin/env node
// scripts/backfill-tesla-charge.mjs
// Offline backfill for charge-history.jsonl rows that were truncated by the
// wall-connector freshness bug (sessions closed after ~15 min, so early-Sept
// rows show ~0.30 kWh / 15 min). The daily push-log frames DID capture the full
// charge — ACChargingPower streamed the whole time — so we recompute energy by
// integrating those frames and rewrite ONLY the bad rows. Non-matching rows are
// preserved byte-for-byte (original line text, original order).
//
// Usage:
//   node scripts/backfill-tesla-charge.mjs --push-log-dir <dir> --history <file> \
//        [--date YYYY-MM-DD ...] [--vehicle <name>] [--dry-run]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const USAGE = `Usage: node scripts/backfill-tesla-charge.mjs --push-log-dir <dir> --history <file> \
     [--date YYYY-MM-DD ...] [--vehicle <name>] [--dry-run]`;

function parseArgs(argv) {
  const opts = { pushLogDir: null, history: null, dates: [], vehicle: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--push-log-dir') opts.pushLogDir = argv[++i];
    else if (a === '--history') opts.history = argv[++i];
    else if (a === '--date') opts.dates.push(argv[++i]);
    else if (a === '--vehicle') opts.vehicle = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else { console.error(`Unknown argument: ${a}\n${USAGE}`); process.exit(2); }
  }
  if (!opts.pushLogDir || !opts.history) {
    console.error('Missing required --push-log-dir and/or --history.\n' + USAGE);
    process.exit(2);
  }
  return opts;
}

// Recompute energy/duration for one charge date from its push-log frames.
// Returns null when no charging (ACChargingPower > 0) is seen that day.
function recomputeFromPushLog(pushLogDir, dateStr) {
  let raw;
  try { raw = readFileSync(join(pushLogDir, `${dateStr}.jsonl`), 'utf-8'); }
  catch { return null; }

  const frames = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let f;
    try { f = JSON.parse(line); } catch { continue; }
    if (f.source !== 'tesla' || typeof f.receivedAt !== 'string') continue;
    const ts = Date.parse(f.receivedAt);
    if (Number.isNaN(ts)) continue;
    frames.push({ ts, changed: f.changed && typeof f.changed === 'object' ? f.changed : {} });
  }
  if (!frames.length) return null;

  // Frames may be out of order — sort by receivedAt.
  frames.sort((a, b) => a.ts - b.ts);

  // Charge window: first frame that sets ACChargingPower > 0 to the first later
  // frame that sets it back to 0 (if it never returns to 0, use last frame time).
  let startTs = null;
  let endTs = null;
  for (const f of frames) {
    const p = f.changed.ACChargingPower;
    if (typeof p !== 'number') continue;
    if (startTs === null && p > 0) { startTs = f.ts; }
    else if (startTs !== null && p === 0) { endTs = f.ts; break; }
  }
  if (startTs === null) return null; // no charging seen for this date
  if (endTs === null) endTs = frames[frames.length - 1].ts;

  // Integrate: carry ACChargingPower forward across frames, add power * dtHours
  // per inter-frame interval using the power in effect at the START of the
  // interval. Skip gaps >= 10 min (container-down gaps must not be integrated) —
  // mirrors updateSessionKwh in app/api/dashboard/route.ts.
  let kwh = 0;
  let powerKw = 0;
  for (let i = 0; i < frames.length && i < frames.length - 1; i++) {
    const cur = frames[i];
    if (cur.changed.ACChargingPower !== undefined) powerKw = cur.changed.ACChargingPower;
    // Only integrate intervals inside the charge window.
    if (cur.ts < startTs || cur.ts > endTs) continue;
    const next = frames[i + 1];
    if (next.ts > endTs) break;
    const dtHours = (next.ts - cur.ts) / 3_600_000;
    if (dtHours >= 10 / 60) continue; // gap too large — skip
    kwh += powerKw * dtHours;
  }

  return {
    energyKwh: Math.round(kwh * 100) / 100,
    durationMin: Math.floor((endTs - startTs) / 60_000), // round DOWN, never Math.round
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dateSet = new Set(opts.dates);

  let raw;
  try { raw = readFileSync(opts.history, 'utf-8'); }
  catch (e) { console.error(`Cannot read history file: ${e.message}`); process.exit(1); }

  // Split into lines but keep the original line text for every row we don't
  // change — non-matching rows must be preserved byte-for-byte.
  const hadTrailingNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (hadTrailingNewline && lines.length && lines[lines.length - 1] === '') lines.pop();

  let changedCount = 0;
  const outLines = [];
  for (const line of lines) {
    if (!line) { outLines.push(line); continue; }
    let row;
    try { row = JSON.parse(line); } catch { outLines.push(line); continue; }

    const chargeDate = String(row.startedAt ?? '').slice(0, 10);
    const matchesVehicle = !opts.vehicle || row.vehicleName === opts.vehicle;
    const matchesDate = dateSet.size === 0 || dateSet.has(chargeDate);
    if (!matchesVehicle || !matchesDate) { outLines.push(line); continue; }

    const recomputed = recomputeFromPushLog(opts.pushLogDir, chargeDate);
    if (recomputed === null) { outLines.push(line); continue; } // no charging seen — leave unchanged

    const before = { energyKwh: row.energyKwh, durationMin: row.durationMin };
    if (before.energyKwh === recomputed.energyKwh && before.durationMin === recomputed.durationMin) {
      outLines.push(line); // nothing to fix
      continue;
    }

    // Update ONLY energyKwh and durationMin — keep other fields and key order.
    row.energyKwh = recomputed.energyKwh;
    row.durationMin = recomputed.durationMin;
    const newLine = JSON.stringify(row);
    outLines.push(newLine);
    changedCount++;

    if (opts.dryRun) {
      console.log(`[dry-run] ${row.vehicleName} ${chargeDate}: ` +
        `energyKwh ${before.energyKwh} -> ${recomputed.energyKwh}, ` +
        `durationMin ${before.durationMin} -> ${recomputed.durationMin}`);
    } else {
      console.log(`${row.vehicleName} ${chargeDate}: energyKwh ${before.energyKwh} -> ${recomputed.energyKwh}, ` +
        `durationMin ${before.durationMin} -> ${recomputed.durationMin}`);
    }
  }

  if (opts.dryRun) {
    console.log(`[dry-run] ${changedCount} row(s) would change; nothing written.`);
    return;
  }

  writeFileSync(opts.history, outLines.join('\n') + (hadTrailingNewline ? '\n' : ''));
  console.log(`${changedCount} row(s) updated in ${opts.history}`);
}

main();
