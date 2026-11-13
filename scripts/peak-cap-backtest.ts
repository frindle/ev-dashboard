// EV peak cap backtest (#9b). Prints aggregates only: counts, kW and $ (no dates, addresses or account fields).
//
//   node --experimental-strip-types scripts/peak-cap-backtest.ts <days.csv>
//
// <days.csv> has the header: date,day_kw,night_kw,ev_kw_at_night_peak,house_night_kw,work[,temp_f]
// (work = 1/0). Build it from the nve_daily_peak measurement (day_peak_kw, night_peak_kw,
// ev_kw_at_night_peak, house_night_kw) with the shift calendar's work flag. Run it on a fixture in the
// sandbox; the real data is run later by the main session.
import { readFileSync } from 'node:fs';
import { backtestPeakCap, formatBacktest, type BacktestDay } from '../lib/peakCapBacktest.ts';

export function parseDaysCsv(text: string): BacktestDay[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = (lines.shift() ?? '').split(',').map((h) => h.trim());
  const col = (n: string) => head.indexOf(n);
  const need = ['date', 'day_kw', 'night_kw', 'ev_kw_at_night_peak', 'house_night_kw', 'work'];
  const missing = need.filter((n) => col(n) < 0);
  if (missing.length) throw new Error('missing columns: ' + missing.join(', '));
  const num = (s: string | undefined) => { const n = s === undefined || s.trim() === '' ? NaN : Number(s); return Number.isFinite(n) ? n : null; };
  return lines.map((l) => {
    const f = l.split(',');
    const tc = col('temp_f');
    return {
      date: f[col('date')].trim(), dayKw: num(f[col('day_kw')]), nightKw: num(f[col('night_kw')]),
      evKwAtNightPeak: num(f[col('ev_kw_at_night_peak')]), houseNightKw: num(f[col('house_night_kw')]),
      isWork: f[col('work')].trim() === '1', tempF: tc >= 0 ? num(f[tc]) : null,
    };
  });
}

if (process.argv[1] && process.argv[1].endsWith('peak-cap-backtest.ts')) {
  const file = process.argv[2];
  if (!file) { console.error('usage: peak-cap-backtest.ts <days.csv>'); process.exit(2); }
  console.log(formatBacktest(backtestPeakCap(parseDaysCsv(readFileSync(file, 'utf8')))).join('\n'));
}
