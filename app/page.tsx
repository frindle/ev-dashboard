'use client';

import { useState, useEffect, useCallback } from 'react';
import type { DashboardData, VehicleData, WallConnectorData } from '@/app/api/dashboard/route';

const REFRESH_MS = 30_000;
const CIRCUIT_AMPS = 48;
const VOLTS = 240;
const ACCENT = '#34e0c4';
const ACCENT_SOFT = 'rgba(52,224,196,0.16)';
const C = 326.726; // 2π × r52

function kwFor(amps: number) { return amps * VOLTS / 1000; }

function fmtEta(min: number): string {
  if (min <= 0) return 'AT TARGET';
  const total = Math.round(min);
  const h = Math.floor(total / 60), m = total % 60;
  return (h > 0 ? h + 'h ' : '') + m + 'm TO TARGET';
}

function owmIcon(code: string): string {
  const p = code.slice(0, 2), day = code.endsWith('d');
  const m: Record<string, string> = {
    '01': day ? 'clear_day' : 'clear_night',
    '02': day ? 'partly_cloudy_day' : 'partly_cloudy_night',
    '03': 'cloud', '04': 'cloud', '09': 'rainy', '10': 'rainy',
    '11': 'thunderstorm', '13': 'snowing', '50': 'foggy',
  };
  return m[p] ?? 'wb_sunny';
}

// ── Stat Chip ─────────────────────────────────────────────────────────────────
function StatChip({ label, value, unit, icon }: {
  label: string; value: string; unit: string; icon?: string;
}) {
  return (
    <div style={{ background: '#161c22', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 13, padding: '10px 15px', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 106 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, letterSpacing: '0.1em', color: '#7d8893' }}>
        {icon
          ? <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 13, color: ACCENT }}>{icon}</span>
          : <span style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT, flexShrink: 0 }} />}
        {label}
      </span>
      <span style={{ fontSize: 16, fontWeight: 600 }}>
        {value}<span style={{ fontSize: 11, color: '#a4afba', fontWeight: 500 }}> {unit}</span>
      </span>
    </div>
  );
}

// ── Charge Dial ───────────────────────────────────────────────────────────────
function ChargeDial({ soc, limit, accent, draggable, onSetLimit }: {
  soc: number; limit: number; accent: string; draggable: boolean;
  onSetLimit?: (l: number) => void;
}) {
  const [drag, setDrag] = useState(false);
  const valueOffset = C - C * (soc / 100);
  const lAng = (limit / 100) * Math.PI * 2;
  const tx1 = (60 + 43 * Math.sin(lAng)).toFixed(2);
  const ty1 = (60 - 43 * Math.cos(lAng)).toFixed(2);
  const tx2 = (60 + 61 * Math.sin(lAng)).toFixed(2);
  const ty2 = (60 - 61 * Math.cos(lAng)).toFixed(2);

  function dialSet(e: React.PointerEvent<SVGSVGElement>) {
    if (!onSetLimit) return;
    const r = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    let ang = Math.atan2(dx, -dy);
    if (ang < 0) ang += Math.PI * 2;
    let pct = (ang / (Math.PI * 2)) * 100;
    pct = Math.max(50, Math.min(100, Math.round(pct / 5) * 5));
    onSetLimit(pct);
  }

  return (
    <svg width="128" height="128" viewBox="0 0 120 120"
      onPointerDown={e => { if (!draggable) return; setDrag(true); try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {} dialSet(e); }}
      onPointerMove={e => { if (drag) dialSet(e); }}
      onPointerUp={() => setDrag(false)}
      style={{ flex: 'none', cursor: draggable ? 'grab' : 'default', touchAction: 'none' }}>
      <circle cx="60" cy="60" r="52" fill="none" stroke="#222b34" strokeWidth="9" />
      <g transform="rotate(-90 60 60)">
        <circle cx="60" cy="60" r="52" fill="none" stroke={accent} strokeWidth="9"
          strokeLinecap="round" strokeDasharray={C} strokeDashoffset={valueOffset} />
      </g>
      <line x1={tx1} y1={ty1} x2={tx2} y2={ty2} stroke="#e2685f" strokeWidth="3" strokeLinecap="round" />
      <text x="60" y="48" textAnchor="middle" style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 7, letterSpacing: '0.22em', fill: '#a4afba' }}>CHARGE</text>
      <text x="60" y="68" textAnchor="middle" style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 24, fontWeight: 600, fill: '#e8edf2' }}>{soc}%</text>
      <text x="60" y="82" textAnchor="middle" style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 7, letterSpacing: '0.18em', fill: '#e2685f' }}>LIMIT {limit}%</text>
    </svg>
  );
}

// ── Vehicle Card ──────────────────────────────────────────────────────────────
function VehicleCard({ v, idx, wcPowerW, accent, onCommand }: {
  v: VehicleData; idx: number; wcPowerW: number; accent: string;
  onCommand: (cmd: string, params?: Record<string, unknown>) => void;
}) {
  const s = v.state;
  const isTesla = v.id === 'tesla';
  const isLeft = idx === 0;

  const rowDir  = isLeft ? 'row-reverse' : 'row';
  const nameAlign  = isLeft ? 'flex-end'   : 'flex-start';
  const badgeAlign = isLeft ? 'flex-start' : 'flex-end';
  const statsAlign = isLeft ? 'right'      : 'left';
  const footerDir  = isLeft ? 'row'        : 'row-reverse';
  const sourceAlign = isLeft ? 'left'      : 'right';

  // 2026-06-26 design port: stats columns mirror so RANGE LEFT + TARGET
  // (the live driving / control numbers) always hug the dial regardless
  // of which side of the dashboard the card sits on. `grid-auto-flow:dense`
  // + explicit grid-column on each cell drives the swap.
  const colInside  = isLeft ? 2 : 1;
  const colOutside = isLeft ? 1 : 2;

  const soc    = s ? Math.round(s.chargePercent) : 0;
  const limit  = s ? Math.round(s.chargeLimit)   : 80;
  const range  = s ? Math.round(s.rangeMi)       : 0;
  const odoLabel = s ? Math.round(s.odometer).toLocaleString('en-US') : '—';
  const minutesToFull = s?.minutesToFull ?? 0;
  const isCharging   = s?.isCharging   ?? false;
  const isPluggedIn  = s?.isPluggedIn  ?? false;
  const isThrottled  = s?.isThrottled  ?? false;
  const derateReason = s?.derateReason ?? '';
  const isLocked     = s?.isLocked     ?? true;
  const climateOn    = s?.climateOn    ?? false;
  const online       = s?.online       ?? false;

  // atHome: true = confirmed home (GPS within radius), false = confirmed away,
  // null = unknown (no fresh GPS). Treat null as "home" so an asleep car at
  // home doesn't suddenly read AWAY whenever Tesla stops reporting location.
  const atHome       = v.atHome !== false;
  const chargingHome = isCharging && atHome;

  let badgeLabel: string, badgeAccent: boolean, badgePulse: boolean;
  if      (!v.connected)   { badgeLabel = 'DISCONNECTED';   badgeAccent = false; badgePulse = false; }
  else if (chargingHome)   { badgeLabel = 'CHARGING';        badgeAccent = true;  badgePulse = true;  }
  else if (isCharging)     { badgeLabel = 'CHARGING · AWAY'; badgeAccent = true;  badgePulse = true;  }
  else if (!atHome)        { badgeLabel = 'AWAY';            badgeAccent = false; badgePulse = false; }
  else if (!online)        { badgeLabel = 'ASLEEP';          badgeAccent = false; badgePulse = false; }
  else                     { badgeLabel = 'IDLE';            badgeAccent = false; badgePulse = false; }

  const badgeColor    = badgeAccent ? accent    : '#a4afba';
  const badgeBg       = badgeAccent ? ACCENT_SOFT : '#1b232b';
  const badgeDotColor = badgeAccent ? accent    : '#7d8893';
  const badgeDotAnim  = badgePulse ? 'evpulse 1.8s ease-in-out infinite' : 'none';

  const rateKw    = wcPowerW / 1000;
  const rateLabel = chargingHome && rateKw > 0
    ? rateKw.toFixed(1) + ' kW'
    : (isCharging ? 'away' : '—');
  const etaLabel  = chargingHome
    ? fmtEta(minutesToFull)
    : isCharging
      ? 'CHARGING AWAY'
      : !atHome
        ? 'AWAY'
        : isPluggedIn
          ? (soc >= limit ? 'AT TARGET' : 'PLUGGED IN · IDLE')
          : 'NOT PLUGGED IN';
  const etaColor  = isCharging ? accent : '#7d8893';

  // canControl: can change limit / drag dial — Tesla + connected, regardless of plug
  // canStartStop: can fire charge_start/stop — also requires the plug to be in
  // (otherwise Tesla returns "not_charging" with no progress)
  const canControl = isTesla && v.connected;
  const canStartStop = canControl && (isPluggedIn || isCharging);
  const scheduleOnly = !isTesla && v.connected && s !== null;
  const apiLabel  = isTesla ? 'TESLA FLEET API' : 'RIVIAN · UNOFFICIAL API';
  const limitNote = canControl ? 'CHARGE LIMIT' : 'CHARGE LIMIT · VIA SCHEDULE';

  return (
    <div style={{ background: '#161c22', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 20, padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14, boxShadow: '0 18px 44px -30px rgba(0,0,0,.85)' }}>
      {/* Name / badge row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexDirection: rowDir as React.CSSProperties['flexDirection'] }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: nameAlign as React.CSSProperties['alignItems'] }}>
          <span style={{ fontSize: 19, fontWeight: 600 }}>{v.name}</span>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, color: '#a4afba', letterSpacing: '0.03em' }}>{v.model}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: badgeAlign as React.CSSProperties['alignItems'], gap: 8, flex: 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: badgeAlign as React.CSSProperties['alignItems'] }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: badgeBg, color: badgeColor, fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', padding: '6px 12px', borderRadius: 999 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: badgeDotColor, animation: badgeDotAnim, flexShrink: 0 }} />
              {badgeLabel}
            </span>
            {isThrottled && isCharging && (
              <span title={`Charger derate: ${derateReason}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(224,181,61,0.15)', color: '#e0b53d', fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, fontWeight: 600, letterSpacing: '0.06em', padding: '4px 10px', borderRadius: 999 }}>
                <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 12, lineHeight: 1 }}>warning</span>
                THROTTLED · {derateReason.replace(/_/g, ' ').toUpperCase()}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={isTesla ? () => onCommand(isLocked ? 'unlock' : 'lock') : undefined}
              title={isLocked ? 'Locked' : 'Unlocked'}
              style={{ appearance: 'none', cursor: isTesla ? 'pointer' : 'default', width: 42, height: 42, borderRadius: 12, background: isLocked ? '#1b232b' : 'rgba(226,104,95,0.16)', border: '1px solid rgba(255,255,255,0.06)', color: isLocked ? '#a4afba' : '#e2685f', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
              <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 22, lineHeight: 1 }}>{isLocked ? 'lock' : 'lock_open'}</span>
            </button>
            <button
              onClick={isTesla ? () => onCommand(climateOn ? 'climate_stop' : 'climate_start') : undefined}
              title={climateOn ? 'AC on' : 'AC off'}
              style={{ appearance: 'none', cursor: isTesla ? 'pointer' : 'default', width: 42, height: 42, borderRadius: 12, background: climateOn ? ACCENT_SOFT : '#1b232b', border: '1px solid rgba(255,255,255,0.06)', color: climateOn ? accent : '#a4afba', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
              <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 23, lineHeight: 1, animation: 'acspin 2.4s linear infinite', animationPlayState: climateOn ? 'running' : 'paused' }}>mode_fan</span>
            </button>
          </div>
        </div>
      </div>

      {/* Dial + stats */}
      <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexDirection: rowDir as React.CSSProperties['flexDirection'] }}>
        <ChargeDial
          soc={soc} limit={limit} accent={accent}
          draggable={canControl}
          onSetLimit={canControl ? l => onCommand('set_charge_limit', { percent: l }) : undefined}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridAutoFlow: 'dense', gap: '13px 18px', flex: 1, textAlign: statsAlign as React.CSSProperties['textAlign'] }}>
          {/* RANGE LEFT and TARGET sit in colInside (the column next to the
              dial); ODOMETER and CHARGE RATE sit in colOutside. The grid
              flips between the left + right cards via the colInside/colOutside
              swap above, so range/target always hug the dial. */}
          {([
            ['RANGE LEFT',  s ? String(range) : '—', s ? 'mi' : '', colInside],
            ['ODOMETER',    s ? odoLabel       : '—', s ? 'mi' : '', colOutside],
            ['TARGET',      `${limit}%`,               '',           colInside],
            ['CHARGE RATE', rateLabel,                 '',           colOutside],
          ] as [string, string, string, number][]).map(([label, val, unit, col]) => (
            <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: col }}>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, letterSpacing: '0.14em', color: '#7d8893' }}>{label}</span>
              <span style={{ fontSize: 17, fontWeight: 600 }}>
                {val}{unit && <span style={{ fontSize: 11, color: '#a4afba', fontWeight: 500 }}> {unit}</span>}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexDirection: footerDir as React.CSSProperties['flexDirection'] }}>
          {canStartStop && (
            <button onClick={() => onCommand(isCharging ? 'charge_stop' : 'charge_start')}
              style={{ appearance: 'none', cursor: 'pointer', flex: 'none', padding: '10px 18px', borderRadius: 11, background: isCharging ? 'transparent' : accent, border: isCharging ? '1px solid rgba(226,104,95,.5)' : '1px solid transparent', color: isCharging ? '#e2685f' : '#08231f', fontFamily: "'Space Grotesk',sans-serif", fontSize: 13, fontWeight: 600 }}>
              {isCharging ? 'Stop' : 'Start'}
            </button>
          )}
          {scheduleOnly && (
            <span style={{ flex: 'none', padding: '10px 14px', borderRadius: 11, background: '#1b232b', border: '1px dashed rgba(255,255,255,0.12)', color: '#a4afba', fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, letterSpacing: '0.04em' }}>SCHEDULE ONLY</span>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em', color: etaColor }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: etaColor, flexShrink: 0 }} />
            {etaLabel}
          </span>
        </div>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 8.5, letterSpacing: '0.14em', color: '#5e6873', textAlign: sourceAlign as React.CSSProperties['textAlign'] }}>
          {limitNote}{canControl ? ' · DRAG DIAL' : ''} · SOURCE {apiLabel}
        </span>
      </div>
    </div>
  );
}

// ── Circuit Panel ─────────────────────────────────────────────────────────────
function CircuitPanel({ wallConnectors, solarPowerW }: {
  wallConnectors: WallConnectorData[];
  solarPowerW: number;
}) {
  const left  = wallConnectors.find(w => w.side === 'LEFT');
  const right = wallConnectors.find(w => w.side === 'RIGHT');

  const leftAmps  = left?.vitals?.currentA  ?? 0;
  const rightAmps = right?.vitals?.currentA ?? 0;
  const usedAmps  = Math.round(leftAmps + rightAmps);
  const leftInUse  = left?.vitals?.vehicleCharging  ?? false;
  const rightInUse = right?.vitals?.vehicleCharging ?? false;
  const activeCount = (leftInUse ? 1 : 0) + (rightInUse ? 1 : 0);

  const usedKw   = kwFor(usedAmps);
  const freeAmps = Math.max(0, CIRCUIT_AMPS - usedAmps);
  const leftPct  = `${Math.round((leftAmps  / CIRCUIT_AMPS) * 100)}%`;
  const rightPct = `${Math.round((rightAmps / CIRCUIT_AMPS) * 100)}%`;

  // session + today kWh now come from server-side integration (Tesla stopped
  // exposing session_energy_wh on the new live_status endpoint).
  const leftSessionKwh  = left?.sessionKwh  ?? 0;
  const rightSessionKwh = right?.sessionKwh ?? 0;
  const leftTodayKwh    = left?.todayKwh    ?? 0;
  const rightTodayKwh   = right?.todayKwh   ?? 0;
  const todayKwh = leftTodayKwh + rightTodayKwh;

  const statusLabel = activeCount === 0 ? 'IDLE — NOTHING CHARGING'
    : activeCount === 2 ? 'BOTH CHARGING — WITHIN CIRCUIT LIMIT'
    : 'ONE CONNECTOR ACTIVE';
  const statusColor = activeCount > 0 ? ACCENT : '#7d8893';

  // Per-side accent colors so when both connectors are active the user can
  // see at a glance how the demand is split. LEFT = Rivian (cool steel grey),
  // RIGHT = Tesla (cool blue). When idle, both fall back to a dim grey.
  const LEFT_COLOR  = '#9aa5b1';
  const RIGHT_COLOR = '#5b8def';
  const sides = [
    { name: 'LEFT',  wc: left,  inUse: leftInUse,  amps: Math.round(leftAmps),  session: leftSessionKwh,  today: leftTodayKwh,  color: LEFT_COLOR  },
    { name: 'RIGHT', wc: right, inUse: rightInUse, amps: Math.round(rightAmps), session: rightSessionKwh, today: rightTodayKwh, color: RIGHT_COLOR },
  ];

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 13, background: '#12181e', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 20, padding: '16px 22px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flex: 'none' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, letterSpacing: '0.14em', color: '#7d8893' }}>SHARED 48 A CIRCUIT · 240 V</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: "'JetBrains Mono',monospace", fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', color: statusColor }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor }} />
            {statusLabel}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 22, fontWeight: 600, lineHeight: 1 }}>{usedAmps} / {CIRCUIT_AMPS} A</span>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: '#a4afba', letterSpacing: '0.04em' }}>· {usedKw.toFixed(1)} kW</span>
          </div>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, color: '#a4afba' }}>{todayKwh.toFixed(1)} kWh today · {freeAmps} A free</span>
        </div>
      </div>

      {/* Split bar */}
      <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ position: 'relative', height: 24, borderRadius: 12, background: '#1b232b', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: leftPct, background: LEFT_COLOR, borderRadius: 12, transition: 'width .4s ease' }} />
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: rightPct, background: RIGHT_COLOR, borderRadius: 12, transition: 'width .4s ease' }} />
          <div style={{ position: 'absolute', left: '50%', top: 3, bottom: 3, width: 1, background: 'rgba(255,255,255,0.14)' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: "'JetBrains Mono',monospace", fontSize: 10 }}>
          <span style={{ color: LEFT_COLOR }}>◀ {left?.vehicleName ?? 'LEFT'} · {Math.round(leftAmps)} A</span>
          <span style={{ color: '#7d8893' }}>{freeAmps} A free</span>
          <span style={{ color: RIGHT_COLOR }}>{right?.vehicleName ?? 'RIGHT'} · {Math.round(rightAmps)} A ▶</span>
        </div>
      </div>

      {/* Wall connector sub-cards */}
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {sides.map(side => {
          const vitals = side.wc?.vitals;
          const kwLabel = vitals ? kwFor(vitals.currentA).toFixed(1) : '0.0';
          const kwColor = side.inUse ? side.color : '#5e6873';
          const sc = side.inUse ? side.color : '#7d8893';
          const dotAnim = side.inUse ? 'evpulse 1.8s ease-in-out infinite' : 'none';
          const connectedLabel = side.inUse
            ? (side.wc?.vehicleName ?? side.name) + ' charging'
            : vitals?.vehicleConnected ? 'Vehicle connected · not charging' : 'No vehicle connected';
          return (
            <div key={side.name} style={{ display: 'flex', flexDirection: 'column', gap: 10, background: '#161c22', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 16, padding: '13px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, letterSpacing: '0.14em', color: '#7d8893' }}>WALL CONNECTOR · {side.name}</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#d3dae1' }}>{connectedLabel}</span>
                </div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', fontFamily: "'JetBrains Mono',monospace", fontSize: 11, fontWeight: 600, color: sc }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: sc, animation: dotAnim }} />
                  {side.inUse ? 'IN USE' : 'AVAILABLE'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
                <span style={{ fontSize: 30, fontWeight: 600, lineHeight: 0.9, letterSpacing: '-0.02em', color: kwColor }}>{kwLabel}</span>
                <span style={{ fontSize: 13, color: '#a4afba', paddingBottom: 3 }}>kW · {side.amps} A</span>
              </div>
              <div style={{ display: 'flex', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 12, marginTop: 'auto' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, letterSpacing: '0.14em', color: '#7d8893' }}>SESSION</span>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{side.session > 0 ? side.session.toFixed(1) + ' kWh' : '—'}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, letterSpacing: '0.14em', color: '#7d8893' }}>TODAY</span>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{side.today.toFixed(1)} kWh</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Solar row (if generating) */}
      {solarPowerW > 0 && (
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'rgba(52,224,196,0.06)', border: '1px solid rgba(52,224,196,0.14)', borderRadius: 12 }}>
          <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 18, color: ACCENT }}>solar_power</span>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: '0.08em', color: '#a4afba' }}>SOLAR</span>
          <span style={{ fontSize: 16, fontWeight: 600 }}>{(solarPowerW / 1000).toFixed(1)}<span style={{ fontSize: 11, color: '#a4afba', fontWeight: 500 }}> kW</span></span>
        </div>
      )}
    </div>
  );
}

// ── Camera Modal ──────────────────────────────────────────────────────────────
function CameraModal({ streamUrl, garageConnected, garageDoorOpen, onClose, onToggleGarage }: {
  streamUrl: string; garageConnected: boolean; garageDoorOpen: boolean | null;
  onClose: () => void; onToggleGarage: () => void;
}) {
  const key = garageDoorOpen === true ? 'open' : garageDoorOpen === false ? 'closed' : 'unknown';
  const dm = {
    open:    { label: 'OPEN',    icon: 'garage_door', color: '#e0b53d', bg: 'rgba(224,181,61,0.15)', action: 'Close Garage' },
    closed:  { label: 'CLOSED',  icon: 'garage',      color: '#a4afba', bg: '#1b232b',               action: 'Open Garage'  },
    unknown: { label: 'UNKNOWN', icon: 'garage',      color: '#7d8893', bg: '#1b232b',               action: 'Toggle Garage' },
  }[key];

  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(8,11,14,0.82)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, animation: 'evfade .18s ease-out' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 760, maxWidth: '100%', background: '#12181e', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20, overflow: 'hidden', boxShadow: '0 40px 90px -40px rgba(0,0,0,.9)', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>Garage Camera</span>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '0.12em', color: '#7d8893' }}>RTSP · 1080p · WIDE</span>
          </div>
          <button onClick={onClose} style={{ appearance: 'none', cursor: 'pointer', width: 34, height: 34, borderRadius: 10, background: '#1b232b', border: '1px solid rgba(255,255,255,0.06)', color: '#d3dae1', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
            <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 20, lineHeight: 1 }}>close</span>
          </button>
        </div>
        {/* Video area */}
        <div style={{ position: 'relative', aspectRatio: '16/9', background: 'radial-gradient(120% 90% at 50% 30%, #1c252e 0%, #0c1014 100%)', overflow: 'hidden' }}>
          {streamUrl ? (
            <img src={streamUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="Camera" />
          ) : (
            <>
              <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(255,255,255,0.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.035) 1px,transparent 1px)', backgroundSize: '34px 34px' }} />
              <div style={{ position: 'absolute', left: 0, right: 0, height: '14%', background: 'linear-gradient(rgba(52,224,196,0.10),transparent)', animation: 'evscan 3.6s linear infinite' }} />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#5e6873' }}>
                <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 52 }}>videocam</span>
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: '0.1em', textAlign: 'center', lineHeight: 1.6, color: '#7d8893' }}>LIVE FEED PLACEHOLDER<br />point at your RTSP / MJPEG stream</span>
              </div>
            </>
          )}
          <span style={{ position: 'absolute', top: 14, left: 16, display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(226,104,95,0.18)', color: '#e2685f', fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', padding: '5px 10px', borderRadius: 999 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#e2685f', animation: 'evpulse 1.4s ease-in-out infinite' }} />LIVE
          </span>
        </div>
        {/* Footer - garage door (only when connected) */}
        {garageConnected && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 20px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 24, color: dm.color }}>{dm.icon}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, letterSpacing: '0.14em', color: '#7d8893' }}>GARAGE DOOR</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: dm.color }}>{dm.label}</span>
              </div>
            </div>
            <button onClick={onToggleGarage} style={{ appearance: 'none', cursor: 'pointer', padding: '12px 22px', borderRadius: 12, background: dm.bg, border: '1px solid rgba(255,255,255,0.08)', color: dm.color, fontFamily: "'Space Grotesk',sans-serif", fontSize: 14, fontWeight: 600 }}>
              {dm.action}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [feedState, setFeedState] = useState<'live' | 'stale' | 'error'>('stale');
  const [showCamera, setShowCamera] = useState(false);
  const [time, setTime] = useState(new Date());
  const [commandPending, setCommandPending] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Forward any uncaught client error to the server so it lands in keys/errors.log.
  // Without this, an iPad kiosk error is invisible — no devtools, no console access.
  useEffect(() => {
    const report = (source: string, message: string, stack?: string) => {
      fetch('/api/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, message, stack, extra: { ua: navigator.userAgent, url: location.href } }),
      }).catch(() => null);
    };
    const onError = (e: ErrorEvent) => report('client.window', e.message, e.error?.stack);
    const onRejection = (e: PromiseRejectionEvent) => report('client.promise', String(e.reason), e.reason?.stack);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  const fetchData = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/dashboard${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' });
      if (!res.ok) { setFeedState('error'); return; }
      const json = await res.json() as DashboardData;
      setData(json);
      setFeedState(Date.now() - new Date(json.lastUpdated).getTime() < 60000 ? 'live' : 'stale');
    } catch {
      setFeedState('error');
    }
  }, []);

  // Load last-known state from disk cache immediately so the dashboard isn't
  // blank while waiting for the first live poll after a container restart
  useEffect(() => {
    fetch('/api/dashboard/cached', { cache: 'no-store' })
      .then(r => r.status === 204 ? null : r.json())
      .then((cached: DashboardData | null) => {
        if (cached) {
          setData(cached);
          setFeedState('stale');
        }
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchData]);

  async function sendCommand(cmd: string, params?: Record<string, unknown>) {
    if (commandPending) return;
    setCommandPending(true);
    try {
      await fetch('/api/tesla/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, params }),
      });
      setTimeout(() => fetchData(true), 2000);
    } finally {
      setCommandPending(false);
    }
  }

  const vehicles: VehicleData[] = data?.vehicles ?? [
    { id: 'rivian', name: 'Midknight', model: 'Rivian R1S',  chargerSide: 'LEFT',  state: null, connected: false, atHome: null },
    { id: 'tesla',  name: 'Tesla',     model: 'Model 3',     chargerSide: 'RIGHT', state: null, connected: false, atHome: null },
  ];
  const wallConnectors: WallConnectorData[] = data?.wallConnectors ?? [
    { side: 'LEFT',  vehicleName: 'Midknight', vitals: null, sessionKwh: 0, todayKwh: 0 },
    { side: 'RIGHT', vehicleName: 'Tesla',     vitals: null, sessionKwh: 0, todayKwh: 0 },
  ];

  // Header values
  const weather = data?.weather;
  const dateStr = time.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  const ageSec = data ? Math.max(0, Math.floor((time.getTime() - new Date(data.lastUpdated).getTime()) / 1000)) : 0;

  let feedLabel: string, feedColor: string, feedBg: string, feedPulse: boolean;
  if (feedState === 'error') {
    feedLabel = 'API ERROR'; feedColor = '#e2685f'; feedBg = 'rgba(226,104,95,0.15)'; feedPulse = false;
  } else if (feedState === 'stale') {
    feedLabel = 'STALE'; feedColor = '#e0b53d'; feedBg = 'rgba(224,181,61,0.15)'; feedPulse = false;
  } else {
    feedLabel = `LIVE · ${ageSec}s AGO`; feedColor = ACCENT; feedBg = ACCENT_SOFT; feedPulse = true;
  }

  const leftWC  = wallConnectors.find(w => w.side === 'LEFT');
  const rightWC = wallConnectors.find(w => w.side === 'RIGHT');
  const totalAmps = (leftWC?.vitals?.currentA ?? 0) + (rightWC?.vitals?.currentA ?? 0);
  const totalKw = kwFor(totalAmps).toFixed(1);
  const solarPowerW = data?.site?.solarPowerW ?? 0;
  const solarKw = (solarPowerW / 1000).toFixed(1);
  const solarOn = solarPowerW > 100; // only show if meaningfully generating
  const inUseCount = (leftWC?.vitals?.vehicleCharging ? 1 : 0) + (rightWC?.vitals?.vehicleCharging ? 1 : 0);
  const vehiclesHome = vehicles.filter(v =>
    v.connected && (v.atHome === true || (v.atHome === null && v.state?.online))
  ).length;

  // Door
  const garageConnected = data?.garageConnected ?? false;
  const garageDoorOpen = data?.garageDoorOpen ?? null;
  const doorKey = garageDoorOpen === true ? 'open' : garageDoorOpen === false ? 'closed' : 'unknown';
  const doorDm = {
    open:    { label: 'OPEN',    icon: 'garage_door', color: '#e0b53d', bg: 'rgba(224,181,61,0.15)' },
    closed:  { label: 'CLOSED',  icon: 'garage',      color: '#a4afba', bg: '#1b232b' },
    unknown: { label: '—',       icon: 'garage',      color: '#7d8893', bg: '#1b232b' },
  }[doorKey];

  const streamUrl = data?.streamUrl ?? '';

  return (
    <div style={{ position: 'relative', width: 1180, height: 820, overflow: 'hidden', background: 'radial-gradient(1000px 600px at 78% -16%, #1a2530 0%, #0e1216 56%)', color: '#e8edf2', fontFamily: "'Space Grotesk',sans-serif", padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 11 }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 24, flex: 'none' }}>
        {/* Left: title */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '0.24em', color: '#7d8893' }}>HOME · ENERGY</span>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em' }}>Energy</h1>
          <span style={{ fontSize: 12, color: '#a4afba' }}>{dateStr} · {timeStr}</span>
        </div>
        {/* Right: controls + stat chips */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {weather && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#d3dae1' }}>
                <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 18, color: ACCENT }}>{owmIcon(weather.icon)}</span>
                {weather.temp}°F · {weather.condition}
              </span>
            )}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: feedBg, color: feedColor, fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', padding: '5px 11px', borderRadius: 999 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: feedColor, animation: feedPulse ? 'evpulse 1.8s ease-in-out infinite' : 'none', flexShrink: 0 }} />
              {feedLabel}
            </span>
            {garageConnected && (
              <button
                onClick={async () => {
                  const command = garageDoorOpen ? 'close' : 'open';
                  await fetch('/api/myq/door', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }) });
                  setTimeout(fetchData, 3000);
                }}
                title={garageDoorOpen ? 'Close garage' : 'Open garage'}
                style={{ appearance: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, background: doorDm.bg, color: doorDm.color, border: '1px solid rgba(255,255,255,0.06)', fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', padding: '5px 11px', borderRadius: 999 }}>
                <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 15, lineHeight: 1 }}>{doorDm.icon}</span>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: doorDm.color, flexShrink: 0 }} />
                GARAGE {doorDm.label}
              </button>
            )}
            {streamUrl && (
              <button onClick={() => setShowCamera(true)} title="Garage camera"
                style={{ appearance: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, background: '#161c22', color: '#d3dae1', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 9, padding: 0 }}>
                <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 18, lineHeight: 1 }}>videocam</span>
              </button>
            )}
            <a href="/admin" title="Settings"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, background: '#161c22', color: '#7d8893', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 9, textDecoration: 'none' }}>
              <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 18, lineHeight: 1 }}>settings</span>
            </a>
          </div>
          {/* Stat chips */}
          <div style={{ display: 'flex', gap: 11 }}>
            <StatChip label="DRAWING" value={totalKw} unit="kW" />
            {solarOn && <StatChip label="SOLAR" value={solarKw} unit="kW" icon="solar_power" />}
            <StatChip label="CHARGERS" value={String(inUseCount)} unit="/ 2 in use" />
            <StatChip label="VEHICLES" value={String(vehiclesHome)} unit="home" />
          </div>
        </div>
      </div>

      {/* ── Vehicle Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, flex: 'none' }}>
        {vehicles.map((v, idx) => {
          const wc = wallConnectors.find(w => w.side === v.chargerSide);
          return (
            <VehicleCard key={v.id} v={v} idx={idx} wcPowerW={wc?.vitals?.powerW ?? 0}
              accent={ACCENT} onCommand={(cmd, params) => sendCommand(cmd, params)} />
          );
        })}
      </div>

      {/* ── Circuit Panel ── */}
      <CircuitPanel wallConnectors={wallConnectors} solarPowerW={solarPowerW} />

      {/* ── Camera Modal ── */}
      {showCamera && (
        <CameraModal
          streamUrl={streamUrl}
          garageConnected={garageConnected}
          garageDoorOpen={garageDoorOpen}
          onClose={() => setShowCamera(false)}
          onToggleGarage={async () => {
            const command = garageDoorOpen ? 'close' : 'open';
            await fetch('/api/myq/door', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }) });
            setTimeout(fetchData, 3000);
          }}
        />
      )}
    </div>
  );
}
