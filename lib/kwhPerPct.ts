// Measured wall kWh per 1% of SoC gained (EV charge plan #6): the rolling
// median over the last SESSIONS home sessions that gained >= MIN_GAIN_PCT.
// Pure; the night plan (lib/rivianNightPlan.ts) calls it with the Rivian's rows.
export const KWH_PER_PCT_SEED = 1.44;
export const KWH_PER_PCT_SESSIONS = 20;
export const KWH_PER_PCT_MIN_GAIN = 10;
// Fewer real samples than this are topped up with the seed so one odd first
// session can't swing the plan.
export const KWH_PER_PCT_MIN_SAMPLES = 5;

export interface SessionSocRow {
  startedAt: string;
  energyKwh: number;
  startSoc?: number | null;
  endSoc?: number | null;
}

export function measuredKwhPerPct(rows: SessionSocRow[], seed: number = KWH_PER_PCT_SEED): number {
  const samples = rows
    .filter((r) => typeof r.startSoc === 'number' && typeof r.endSoc === 'number'
      && Number.isFinite(Date.parse(r.startedAt)) && r.energyKwh > 0
      && (r.endSoc as number) - (r.startSoc as number) >= KWH_PER_PCT_MIN_GAIN)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .slice(-KWH_PER_PCT_SESSIONS)
    .map((r) => r.energyKwh / ((r.endSoc as number) - (r.startSoc as number)))
    // A ratio far from any real car is a logging glitch (a charge that spanned
    // a drive, a stuck SoC), not a measurement.
    .filter((x) => x > 0.5 && x < 3);
  while (samples.length < KWH_PER_PCT_MIN_SAMPLES) samples.push(seed);
  samples.sort((a, b) => a - b);
  const mid = samples.length >> 1;
  const median = samples.length % 2 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;
  return Math.round(median * 1000) / 1000;
}
