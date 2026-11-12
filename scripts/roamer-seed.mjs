#!/usr/bin/env node
// Builds the Rivian drive log and daily-use log from Roamer's two CSV exports
// (EV charge plan #6, the Roamer seed). Same row shapes and the same daily-use
// split as the live log (lib/rivianDailyUse.ts), but no map cells and at_home
// is null. Location, altitude, odometer, weather text and tags are dropped;
// rows marked Corrupted are skipped.
//
//   node --experimental-strip-types scripts/roamer-seed.mjs \
//     drive_sessions.csv charge_sessions.csv outdir [--since YYYY-MM-DD|none]
//
// --since defaults to 2026-05-06 (Midknight's first charge, config
// historySince), so the previous Rivian's rows never reach the seed.
// (Node 22.18+ strips types by default; the flag only matters on older 22.x.)
// Then copy rivian-drives.jsonl and rivian-daily-use.jsonl into keys/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedFromRoamer } from '../lib/roamerSeed.ts';

const args = process.argv.slice(2);
let since = '2026-05-06';
const si = args.indexOf('--since');
if (si >= 0) {
  const v = args[si + 1];
  since = v && v !== 'none' ? v : null;
  args.splice(si, 2);
}
const [drivesPath, chargesPath, outDir] = args;
if (!drivesPath || !chargesPath || !outDir) {
  console.error('usage: roamer-seed.mjs <drive_sessions.csv> <charge_sessions.csv> <outdir> [--since YYYY-MM-DD|none]');
  process.exit(2);
}

let result;
try {
  result = seedFromRoamer(readFileSync(drivesPath, 'utf-8'), readFileSync(chargesPath, 'utf-8'), since);
} catch (e) {
  console.error('roamer-seed failed:', e instanceof Error ? e.message : e);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
writeFileSync(join(outDir, 'rivian-drives.jsonl'), jsonl(result.drives));
writeFileSync(join(outDir, 'rivian-daily-use.jsonl'), jsonl(result.daily));
const known = result.daily.filter((d) => !d.unknown).length;
console.log(`drives: ${result.drives.length}  charges used: ${result.charges.length}  daily-use days: ${result.daily.length} (${known} known)`);
console.log(`skipped: corrupted ${result.skipped.corrupted}, under ${0.5} mi ${result.skipped.short}, incomplete ${result.skipped.incomplete}`);
console.log(`wrote ${join(outDir, 'rivian-drives.jsonl')} and ${join(outDir, 'rivian-daily-use.jsonl')}`);
