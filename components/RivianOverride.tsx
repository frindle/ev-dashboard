'use client';

// Rivian charge override: "be at N% by <time>" for days that don't fit the
// daily plan. Talks to /api/rivian/override (lib/rivianChargeControl.ts).
import { useCallback, useEffect, useState } from 'react';

interface Status {
  daily: { tonightAmps: number } | null;
  // Rev 18: what the demand planner did with tonight (lib/chargePlan.ts PeakView).
  night: { peak?: { charge: boolean; plannedAmps: Array<number | null>; aimKw: number | null; houseKw: number | null; evKw: number; overKw: number; costUsd: number } | null } | null;
  override: { targetPct: number; byMs: number } | null;
  overridePlan: { amps: number; windows: number; feasible: boolean; reachablePct: number; raiseLimitTo: number | null } | null;
  controlEnabled: boolean;
  car: { amperage: number; startTime: number; duration: number; enabled: boolean } | null;
  error: string | null;
}

const MONO = "'JetBrains Mono',monospace";
const MUTED = '#7d8893';
const WARN = '#f0b54a';

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function fmtBy(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// datetime-local value for tomorrow 08:00, the usual "ready by" time
function defaultBy(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T08:00`;
}

export function RivianOverride() {
  const [s, setS] = useState<Status | null>(null);
  const [pct, setPct] = useState('80');
  const [by, setBy] = useState(defaultBy);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const call = useCallback(async (init?: RequestInit) => {
    try {
      const res = await fetch('/api/rivian/override', { cache: 'no-store', ...init });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setS(body);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    call();
    const t = setInterval(() => call(), 60_000);
    return () => clearInterval(t);
  }, [call]);

  const submit = async () => {
    setBusy(true);
    await call({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPct: Number(pct), byMs: new Date(by).getTime() }),
    });
    setBusy(false);
  };
  const clear = async () => {
    setBusy(true);
    await call({ method: 'DELETE' });
    setBusy(false);
  };

  const o = s?.override;
  const p = s?.overridePlan;
  const tonight = p && p.windows > 0 ? Math.max(p.amps, s?.daily?.tonightAmps ?? 0) : s?.daily?.tonightAmps;
  const input = { background: '#0f1418', color: '#e6edf3', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '5px 8px', fontFamily: MONO, fontSize: 12 };
  const button = { ...input, cursor: busy ? 'wait' : 'pointer', background: '#1f2830' };

  return (
    <div style={{ background: '#161c22', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 13, padding: '10px 15px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
      <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', color: MUTED }}>RIVIAN CHARGE</span>
      <span style={{ fontFamily: MONO, fontSize: 12 }}>
        {tonight != null ? `${tonight}A 00:00–08:00` : '—'}
        <span style={{ color: MUTED }}>
          {o ? ` · override ${o.targetPct}% by ${fmtBy(o.byMs)}${p && p.windows > 1 ? ` (${p.windows} nights)` : ''}` : ' · daily plan'}
          {s?.car ? ` · car set to ${s.car.amperage}A ${hhmm(s.car.startTime)}–${hhmm(s.car.startTime + s.car.duration)}` : ''}
          {s && !s.controlEnabled ? ' · not applied (control off)' : ''}
        </span>
      </span>
      {s?.night?.peak && (() => {
        const k = s.night.peak;
        const kw = (x: number | null) => (x === null ? '?' : x.toFixed(1));
        const nights = k.plannedAmps.map((a) => (a === null ? '–' : `${a}A`)).join(' / ');
        return (
          <span style={{ fontFamily: MONO, fontSize: 12, color: k.overKw > 0.05 ? WARN : MUTED }}>
            peak line {kw(k.aimKw)} kW · house {kw(k.houseKw)} · EV {k.charge ? k.evKw.toFixed(1) : '0'} kW
            {k.overKw > 0.05 ? ` · ${k.overKw.toFixed(1)} kW over (~$${k.costUsd.toFixed(2)})` : ' · under'}
            {` · nights ${nights}`}
          </span>
        );
      })()}
      {p?.raiseLimitTo != null && <span style={{ fontFamily: MONO, fontSize: 12, color: WARN }}>raise limit to {p.raiseLimitTo}% in the Rivian app</span>}
      {p && !p.feasible && (
        <span style={{ fontFamily: MONO, fontSize: 12, color: WARN }}>
          {p.windows ? `only ~${Math.floor(p.reachablePct)}% reachable by then` : 'no charge window before then'}
        </span>
      )}
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        {o ? (
          <button style={button} disabled={busy} onClick={clear}>Clear override</button>
        ) : (
          <>
            <input style={{ ...input, width: 52 }} type="number" min={50} max={100} step={1} value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Target charge %" />
            <span style={{ fontFamily: MONO, fontSize: 12, color: MUTED }}>% by</span>
            <input style={input} type="datetime-local" value={by} onChange={(e) => setBy(e.target.value)} aria-label="Ready by" />
            <button style={button} disabled={busy} onClick={submit}>Set</button>
          </>
        )}
      </span>
      {(err || s?.error) && <span style={{ flexBasis: '100%', fontFamily: MONO, fontSize: 11, color: WARN }}>{err ?? s?.error}</span>}
    </div>
  );
}
