// Runs the forecast-vs-actual scorer (lib/planScore.ts): once per day after 08:00 it scores the
// previous served day, and rescores the last 45 days that lacked a use or peak score (the NV usage
// is uploaded in batches, the daily-use log fills in later). Each scored day is also written to
// Influx as ev_plan_score,vehicle=rivian at that day's local noon, and the drift push goes out
// at most once an ISO week. Never throws.
//
// Actual use comes from the daily-use log (rivian-daily-use.jsonl): drive drops plus the parked
// drain, built from the drive log and the charge sessions, so it is the same measure the need
// model plans in. Lowest SoC comes from that day's drives in the drive log.
import { localDayNumber } from '@/lib/chargePlan';
import { fieldLine } from '@/lib/planInflux';
import { influxTarget, writeLines } from '@/lib/chargeSessionInflux';
import { readDailyUse, readDrives } from '@/lib/driveLogStore';
import { localDate } from '@/lib/rivianDailyUse';
import { loadPeakDays } from '@/lib/peakData';
import { driftDecision, scoreDay, type ScoreEntry } from '@/lib/planScore';
import { readScores, writeScores } from '@/lib/planScoreStore';
import { sendPush } from '@/lib/pushover';
import type { PlanStore } from '@/lib/planAlertStore';

export const SCORE_MEASUREMENT = 'ev_plan_score';
const RESCORE_DAYS = 45;

const dayDate = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);
const noonOf = (date: string): number => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d, 12).getTime(); };

export function scoreFields(e: ScoreEntry): Record<string, number | boolean | null> {
  return {
    planned_pct: e.plannedPct, planned_kwh: e.plannedKwh, actual_pct: e.actualPct, actual_kwh: e.actualKwh,
    use_err_pct: e.useErrPct, low_soc: e.lowSocPct, short: e.short,
    fc_peak_kw: e.fcPeakKw, fc_room_kw: e.fcRoomKw, fc_house_kw: e.fcHouseKw,
    day_peak_kw: e.peakKw, house_night_kw: e.houseNightKw, peak_err_pct: e.peakErrPct, room_kw: e.roomKw,
  };
}

const hasData = (e: ScoreEntry) => e.plannedPct !== null || e.actualPct !== null || e.lowSocPct !== null || e.peakScored;

export async function runScorer(
  now: number, store: PlanStore, ctx: { workDays: Set<number> | null; floorPct: number; lat: number | null; lon: number | null },
): Promise<void> {
  const today = localDayNumber(now);
  if (new Date(now).getHours() < 8 || store.scoreDay === today) return;
  try {
    const [entries, daily, drives, peakDays] = await Promise.all([
      readScores(), readDailyUse(), readDrives(), loadPeakDays({ workDays: ctx.workDays, lat: ctx.lat, lon: ctx.lon, now }),
    ]);
    const byDay = new Map(entries.map((e) => [e.day, e] as const));
    const changed: ScoreEntry[] = [];
    for (let day = today - RESCORE_DAYS; day < today; day++) {
      const old = byDay.get(day);
      if (day !== today - 1 && !(old && (old.actualPct === null || !old.peakScored))) continue;
      const date = dayDate(day);
      const row = daily.find((r) => r.date === date);
      const socs = drives.filter((d) => localDate(Date.parse(d.start)) === date)
        .flatMap((d) => [d.start_soc, d.end_soc]).filter((x): x is number => typeof x === 'number');
      const next = scoreDay({
        day, date, planned: store.planned[String(day)] ?? null,
        actualPct: row && !row.unknown ? row.used_pct : null,
        lowSocPct: socs.length ? Math.min(...socs) : null, floorPct: ctx.floorPct,
        peak: peakDays.find((p) => p.date === date) ?? null,
      });
      if (!hasData(next) || (old && JSON.stringify(old) === JSON.stringify(next))) continue;
      byDay.set(day, next);
      changed.push(next);
    }
    if (changed.length) {
      const lines = changed.flatMap((e) => fieldLine(SCORE_MEASUREMENT, 'rivian', scoreFields(e), noonOf(e.date)) ?? []);
      const target = influxTarget();
      if (target && lines.length) await writeLines(lines, target, undefined, 10_000).catch((e) => console.error('[plan-score] influx write failed:', e instanceof Error ? e.message : e));
      await writeScores([...byDay.values()]);
    }
    store.scoreDay = today;

    const drift = driftDecision([...byDay.values()], today, store.driftWeek);
    if (drift.fire) {
      const base = process.env.DASHBOARD_URL?.replace(/\/+$/, '');
      const link = base ? { url: `${base}/charging`, urlTitle: 'Forecast vs actual' } : undefined;
      if (await sendPush('Rivian forecast is drifting', drift.message, 0, link)) store.driftWeek = drift.week;
    }
  } catch (e) {
    console.error('[plan-score] failed:', e instanceof Error ? e.message : e);
  }
}
