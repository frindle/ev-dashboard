// Start/end SoC and avg/peak kW for one charge session (EV charge plan #6).
// Pure accumulator the dashboard poll steps once per cycle while a charger is
// in use; the result goes into ChargeHistoryRow and ev_charge_session.
export interface SessionStats {
  startSoc: number | null;
  peakKw: number;
  kwSec: number;     // kW x seconds, for the time-weighted average
  sec: number;
}

// 0 / non-finite SoC means "not reported" (a stripped Tesla response reads 0).
export function cleanSoc(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 100 ? x : null;
}

export function startStats(soc: unknown): SessionStats {
  return { startSoc: cleanSoc(soc), peakKw: 0, kwSec: 0, sec: 0 };
}

export function stepStats(s: SessionStats, kw: number, dtSec: number): SessionStats {
  if (!(dtSec > 0) || !Number.isFinite(kw) || kw < 0) return s;
  return { ...s, peakKw: Math.max(s.peakKw, kw), kwSec: s.kwSec + kw * dtSec, sec: s.sec + dtSec };
}

export function finishStats(s: SessionStats, endSoc: unknown): {
  startSoc?: number; endSoc?: number; avgKw?: number; peakKw?: number;
} {
  const out: { startSoc?: number; endSoc?: number; avgKw?: number; peakKw?: number } = {};
  const end = cleanSoc(endSoc);
  if (s.startSoc !== null) out.startSoc = s.startSoc;
  if (end !== null) out.endSoc = end;
  if (s.sec > 0) {
    out.avgKw = Math.round((s.kwSec / s.sec) * 100) / 100;
    out.peakKw = Math.round(s.peakKw * 100) / 100;
  }
  return out;
}
