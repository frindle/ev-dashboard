#!/usr/bin/env node
// Walk-forward backtest of the need-estimate models (EV charge plan #7).
// Usage (TZ matters: drive timestamps are bucketed into local days):
//   TZ=America/Los_Angeles node --experimental-strip-types scripts/backtest-need.mjs \
//     <rivian-daily-use.jsonl> <rivian-drives.jsonl> <workdays.json> [--limit 70] [--floor 25]
// Prints aggregates only: never a row, a date or a per-day value.
import { readFileSync } from 'node:fs';
import {
  buildNeedData, fitTempCurve, modelA, modelB, modelCombined, overridesFromPass1, ruleFromShorts, simulate, summarize, bandOf,
} from '../lib/needModels.ts';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = Number(args[i + 1]);
  args.splice(i, 2);
  return Number.isFinite(v) ? v : dflt;
};
const limit = opt('--limit', 70);
const floor = opt('--floor', 25);
const [dailyPath, drivesPath, workPath] = args;
if (!dailyPath || !drivesPath || !workPath) {
  console.error('usage: backtest-need.mjs <daily-use.jsonl> <drives.jsonl> <workdays.json> [--limit 70] [--floor 25]');
  process.exit(2);
}
const jsonl = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const data = buildNeedData(jsonl(dailyPath), jsonl(drivesPath), JSON.parse(readFileSync(workPath, 'utf8')));
const o = { limit, floor };

const a = simulate(data, modelA(data), o);
const b1 = simulate(data, modelB(data), o);
const overrides = overridesFromPass1(b1);
const b2 = simulate(data, modelB(data, overrides), o);
const rule = ruleFromShorts(summarize(a).workShort, summarize(b2).workShort);
const c = simulate(data, modelCombined(data, overrides, rule), o);

const f = (x, d = 1) => x.toFixed(d);
console.log(`limit ${limit}%  floor ${floor}%  window 8h (work day: 11:00 departure via nightWindow; off day: no shift)  kWh/% 1.44`);
console.log(`scored days ${a.length} (a) / ${b1.length} (b); overridden bands: ${[...overrides.keys()].sort((x, y) => x - y).join(', ') || 'none'}`);
console.log(`chosen work-day rule: ${rule.workDay}  (set NEED_RULE in lib/needModels.ts)`);
console.log('model        | short n (work/off/all) | short % (work/off/all)  | amps mean/p90 | mean|err| | bias  | nudges');
for (const [name, days] of [['a ewma', a], ['b pass 1', b1], ['b pass 2', b2], ['combined', c]]) {
  const s = summarize(days);
  console.log(`${name.padEnd(12)} | ${`${s.workShort}/${s.offShort}/${s.short}`.padEnd(22)} | ${`${f(s.workShortPct)}/${f(s.offShortPct)}/${f(s.shortPct)}`.padEnd(23)} | ${f(s.meanAmps)}/${f(s.p90Amps, 0)}`.padEnd(14) + ` | ${f(s.meanAbsErr).padEnd(9)} | ${f(s.bias).padEnd(5)} | ${s.nudges}`);
}

// Per-temperature-band table; mi/% from every drive (full period), shorts from the walk-forward work days.
const full = fitTempCurve(data, '9999-12-31');
for (const [name, days] of [['b pass 1', b1], ['b pass 2', b2]]) {
  const rows = new Map();
  for (const d of days) {
    if (!d.isWork || d.band === null) continue;
    const r = rows.get(d.band) ?? { n: 0, short: 0 };
    r.n++; if (d.short) r.short++;
    rows.set(d.band, r);
  }
  console.log(`\nper band, ${name}: band F | work days | short | work-day drives | mi/% median | mi/% p25`);
  for (const band of [...rows.keys()].sort((x, y) => x - y)) {
    const r = rows.get(band), st = full?.bands.get(band);
    console.log(`  ${band}-${band + 9} | ${r.n} | ${r.short} | ${st ? st.workDrives : 0} | ${st?.median != null ? f(st.median, 2) : '-'} | ${st?.p25 != null ? f(st.p25, 2) : '-'}`);
  }
}
