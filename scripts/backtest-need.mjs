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

// Reach mode (leave at only the minimum) scores the estimate itself and picks
// the band overrides and the work-day rule; live mode runs the real nightPlan.
const run = (mode) => {
  const om = { ...o, mode };
  const a = simulate(data, modelA(data), om);
  const b1 = simulate(data, modelB(data), om);
  return { a, b1 };
};
const reach = run('reach');
const overrides = overridesFromPass1(reach.b1);
const b2r = simulate(data, modelB(data, overrides), { ...o, mode: 'reach' });
const rule = ruleFromShorts(summarize(reach.a).workShort, summarize(b2r).workShort);
const cr = simulate(data, modelCombined(data, overrides, rule), { ...o, mode: 'reach' });
const live = run('live');
const b2l = simulate(data, modelB(data, overrides), { ...o, mode: 'live' });
const cl = simulate(data, modelCombined(data, overrides, rule), { ...o, mode: 'live' });
const a = reach.a, b1 = reach.b1, b2 = b2r;

const f = (x, d = 1) => x.toFixed(d);
const pctl = (xs, q) => { const s = [...xs].sort((x, y) => x - y); if (!s.length) return NaN; const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };
console.log(`limit ${limit}%  floor ${floor}%  margin 1.1  window 8h (work day: 11:00 departure via nightWindow; off day: no shift)  kWh/% 1.44`);
console.log(`scored days ${a.length} (a) / ${b1.length} (b); overridden bands: ${[...overrides.keys()].sort((x, y) => x - y).join(', ') || 'none'}`);
console.log(`chosen work-day rule (from reach mode): ${rule.workDay}  (set NEED_RULE in lib/needModels.ts)`);
const table = (title, rows) => {
  console.log(`\n${title}`);
  console.log('model        | n   | short n (work/off/all) | short % (work/off/all)  | amps mean/p90 | morning p10/p50 | arrival p10/min | mean|err| | bias  | nudges');
  for (const [name, days] of rows) {
    const s = summarize(days);
    const m = days.map((d) => d.morning), r = days.map((d) => d.arrival);
    console.log(`${name.padEnd(12)} | ${String(s.n).padEnd(3)} | ${`${s.workShort}/${s.offShort}/${s.short}`.padEnd(22)} | ${`${f(s.workShortPct)}/${f(s.offShortPct)}/${f(s.shortPct)}`.padEnd(23)} | ${`${f(s.meanAmps)}/${f(s.p90Amps, 0)}`.padEnd(13)} | ${`${f(pctl(m, 0.1), 0)}/${f(pctl(m, 0.5), 0)}`.padEnd(15)} | ${`${f(pctl(r, 0.1), 0)}/${f(Math.min(...r), 0)}`.padEnd(15)} | ${f(s.meanAbsErr).padEnd(9)} | ${f(s.bias).padEnd(5)} | ${s.nudges}`);
  }
};
table('REACH mode (every morning at only floor + need x 1.1: how often the estimate itself is beaten)', [['a ewma', a], ['b pass 1', b1], ['b pass 2', b2], ['combined', cr]]);
table('LIVE mode (real nightPlan: put-back / catch-up, 60% heat top-up, 6-48A)', [['a ewma', live.a], ['b pass 1', live.b1], ['b pass 2', b2l], ['combined', cl]]);

// Per-temperature-band table; mi/% from every drive (full period), shorts from the walk-forward work days.
const full = fitTempCurve(data, '9999-12-31');
for (const [name, days] of [['b pass 1 (reach)', b1], ['b pass 2 (reach)', b2]]) {
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
