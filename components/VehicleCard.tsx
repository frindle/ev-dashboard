// components/VehicleCard.tsx
// Ported from design handoff 2026-07-02 (vehicle-card.tsx).
// Contains AuthBanner + VehicleCard + shared severity palette + chip
// builder + banner builder. Kept as-is from the handoff except for
// this header comment — do not rename exports or paraphrase copy.

import * as React from 'react';

// ─────────────────────────────────────────────────────────────
// Shared severity palette (banner + chips)
// ─────────────────────────────────────────────────────────────

type Severity = 'info' | 'neutral' | 'warning' | 'critical';

const ACCENT = '#34e0c4';
const ACCENT_SOFT = 'rgba(52,224,196,0.16)';

const SEV: Record<Severity, { color: string; bg: string; border: string }> = {
  info:     { color: ACCENT,    bg: 'rgba(52,224,196,0.10)', border: 'rgba(52,224,196,0.22)' },
  neutral:  { color: '#a4afba', bg: '#1b232b',               border: 'rgba(255,255,255,0.06)' },
  warning:  { color: '#e0b53d', bg: 'rgba(224,181,61,0.10)', border: 'rgba(224,181,61,0.28)' },
  critical: { color: '#e2685f', bg: 'rgba(226,104,95,0.10)', border: 'rgba(226,104,95,0.28)' },
};

export const GlobalKeyframes: React.FC = () => (
  <style>{`
    @keyframes evpulse { 0%,100% { opacity: .45 } 50% { opacity: 1 } }
    @keyframes acspin  { to { transform: rotate(360deg) } }
  `}</style>
);

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export type Vehicle = {
  id: 'rivian' | 'tesla';
  charger: 'LEFT' | 'RIGHT';
  name: string;
  model: string;
  soc: number;
  limit: number;
  range: number;
  odo: number;
  capacity: number;
  charging: boolean;
  pluggedIn: boolean;
  amps: number;
  today: number;
  ctrl: 'full' | 'schedule';
  apiLabel: string;
  ac: boolean;
  locked: boolean;
  location: 'home' | 'away';
  place: string;
  speed: number;
};

export type AlertInputs = {
  teslaReauth:  'ok' | 'expired';
  rivianAuth:   'ok' | 'due-soon' | 'expired';
  rivianAuthDays: number;

  rivianOta:        'none' | 'available' | 'installing';
  rivianOtaVersion: string;
  rivianTire:       'ok' | 'low' | 'critical';
  rivianTireCorner: 'FL' | 'FR' | 'RL' | 'RR';
  rivianWiper:      'ok' | 'low';
  rivianBrake:      'ok' | 'low';
  rivianThermal:    'ok' | 'detected';
  rivianDerate:     string;
  rivianChargeSlowedLastSession: boolean;

  teslaLocationScope: 'granted' | 'missing';
};

type Chip = {
  icon: string;
  label: string;
  color: string;
  bg: string;
  border: string;
  anim?: string;
};

// ─────────────────────────────────────────────────────────────
// Chip / banner builders (pure)
// ─────────────────────────────────────────────────────────────

const mkChip = (sev: Severity, icon: string, label: string, extra: Partial<Chip> = {}): Chip => ({
  ...SEV[sev], icon, label, ...extra,
});

export function buildChipsFor(veh: Vehicle, a: AlertInputs): Chip[] {
  const chips: Chip[] = [];

  if (veh.id === 'rivian') {
    if (a.rivianThermal === 'detected') {
      chips.push(mkChip('critical', 'battery_alert',
        'THERMAL EVENT — CHECK RIVIAN APP',
        { anim: 'evpulse 1.6s ease-in-out infinite' }));
    } else if (a.rivianDerate?.trim()) {
      chips.push(mkChip('warning', 'device_thermostat',
        'CHARGING SLOWED — ' + a.rivianDerate.trim().toUpperCase()));
    } else if (a.rivianChargeSlowedLastSession) {
      chips.push(mkChip('info', 'history',
        'LAST CHARGE WAS SLOWED — MAY NOT HAVE REACHED GOAL'));
    }

    if (a.rivianOta === 'available') {
      chips.push(mkChip('info', 'system_update',
        'UPDATE ' + a.rivianOtaVersion + ' AVAILABLE'));
    } else if (a.rivianOta === 'installing') {
      chips.push(mkChip('info', 'sync',
        'INSTALLING ' + a.rivianOtaVersion + '…',
        { anim: 'acspin 2s linear infinite' }));
    }

    if (a.rivianTire !== 'ok') {
      const sev: Severity = a.rivianTire === 'critical' ? 'critical' : 'warning';
      chips.push(mkChip(sev, 'tire_repair',
        'TIRE ' + a.rivianTireCorner + ' · ' + a.rivianTire.toUpperCase()));
    }
    if (a.rivianBrake === 'low') chips.push(mkChip('warning', 'car_repair', 'BRAKE FLUID LOW'));
    if (a.rivianWiper === 'low') chips.push(mkChip('neutral',  'wash',       'WIPER FLUID LOW'));
  }

  if (veh.id === 'tesla' && a.teslaLocationScope === 'missing') {
    chips.push(mkChip('warning', 'location_off', 'LOCATION SCOPE MISSING · RE-AUTH'));
  }

  return chips;
}

type BannerState =
  | { show: false }
  | {
      show: true;
      color: string; bg: string; border: string;
      icon: string; title: string; copy: string;
      hasCta: boolean; ctaLabel?: string; onCta?: () => void;
      dismissible: boolean; onDismiss?: () => void;
    };

export function buildTopBanner(
  a: AlertInputs,
  handlers: { onReauthTesla: () => void; onReauthRivian: () => void; onDismiss: () => void; bannerDismissed: boolean }
): BannerState {
  if (a.teslaReauth === 'expired') {
    return { show: true, ...SEV.critical,
      icon: 'lock_reset',
      title: 'TESLA · RE-AUTHENTICATION REQUIRED',
      copy: 'Tesla connection expired. Re-authenticate to resume.',
      hasCta: true, ctaLabel: 'Re-authenticate', onCta: handlers.onReauthTesla,
      dismissible: false };
  }
  if (a.rivianAuth === 'expired') {
    return { show: true, ...SEV.critical,
      icon: 'lock_reset',
      title: 'RIVIAN · RE-AUTHENTICATION REQUIRED',
      copy: 'Rivian connection expired. Re-authenticate to resume.',
      hasCta: true, ctaLabel: 'Re-authenticate', onCta: handlers.onReauthRivian,
      dismissible: false };
  }
  if (a.rivianAuth === 'due-soon' && !handlers.bannerDismissed) {
    const d = a.rivianAuthDays;
    return { show: true, ...SEV.warning,
      icon: 'schedule',
      title: 'RIVIAN · ACCESS RENEWAL',
      copy: `Rivian access renews in ${d} day${d === 1 ? '' : 's'}.`,
      hasCta: true, ctaLabel: 'Re-authenticate', onCta: handlers.onReauthRivian,
      dismissible: true, onDismiss: handlers.onDismiss };
  }
  return { show: false };
}

// ─────────────────────────────────────────────────────────────
// AuthBanner
// ─────────────────────────────────────────────────────────────

export const AuthBanner: React.FC<{ state: BannerState }> = ({ state }) => {
  if (!state.show) return null;
  return (
    <div style={{
      flex: 'none', display: 'flex', alignItems: 'center', gap: 14,
      padding: '12px 18px', borderRadius: 14,
      background: state.bg, border: `1px solid ${state.border}`,
      borderLeft: `3px solid ${state.color}`,
    }}>
      <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 24, color: state.color, lineHeight: 1, flex: 'none' }}>
        {state.icon}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, letterSpacing: '.16em', color: state.color }}>
          {state.title}
        </span>
        <span style={{ fontSize: 13, color: '#e8edf2' }}>{state.copy}</span>
      </div>
      {state.hasCta && state.onCta && (
        <button onClick={state.onCta} style={{
          appearance: 'none', cursor: 'pointer', padding: '9px 18px',
          borderRadius: 10, background: state.color, color: '#0e1216',
          border: 'none', fontFamily: "'Space Grotesk', sans-serif",
          fontSize: 13, fontWeight: 600, flex: 'none',
        }}>{state.ctaLabel}</button>
      )}
      {state.dismissible && state.onDismiss && (
        <button onClick={state.onDismiss} title="Dismiss for 24h" style={{
          appearance: 'none', cursor: 'pointer', width: 32, height: 32,
          borderRadius: 9, background: 'transparent',
          border: '1px solid rgba(255,255,255,0.08)', color: '#a4afba',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0, flex: 'none',
        }}>
          <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 17, lineHeight: 1 }}>close</span>
        </button>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Card helpers
// ─────────────────────────────────────────────────────────────

const C = 326.726;
export const kwFor = (amps: number) => amps * 240 / 1000;

export function fmtEta(min: number): string {
  if (min <= 0) return 'AT TARGET';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m TO TARGET` : `${m}m TO TARGET`;
}

export function dialSetFromPointer(
  e: React.PointerEvent<SVGSVGElement>,
): number {
  const svg = e.currentTarget;
  const r = svg.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  let ang = Math.atan2(dx, -dy);
  if (ang < 0) ang += Math.PI * 2;
  const pct = ang / (Math.PI * 2) * 100;
  return Math.max(50, Math.min(100, Math.round(pct / 5) * 5));
}

// ─────────────────────────────────────────────────────────────
// VehicleCard
// ─────────────────────────────────────────────────────────────

export type VehicleCardProps = {
  vehicle: Vehicle;
  side: 'left' | 'right';
  alerts: AlertInputs;
  alloc: (v: Vehicle) => { amps: number; kw: number };
  etaFor: (v: Vehicle, kw: number) => number;

  onToggleCharging: (v: Vehicle) => void;
  onToggleLock:     (v: Vehicle) => void;
  onToggleAc:       (v: Vehicle) => void;
  onSetLimit:       (v: Vehicle, pct: number) => void;
};

export const VehicleCard: React.FC<VehicleCardProps> = (props) => {
  const { vehicle: v, side, alerts, alloc, etaFor,
          onToggleCharging, onToggleLock, onToggleAc, onSetLimit } = props;

  const isLeft = side === 'left';
  const rowDir: 'row' | 'row-reverse' = isLeft ? 'row-reverse' : 'row';
  const statsTextAlign = isLeft ? 'right' : 'left';
  const colInside  = isLeft ? 2 : 1;
  const colOutside = isLeft ? 1 : 2;
  const badgeAlign = isLeft ? 'flex-start' : 'flex-end';
  const nameAlign  = isLeft ? 'flex-end'   : 'flex-start';
  const footerDir: 'row' | 'row-reverse' = isLeft ? 'row' : 'row-reverse';
  const sourceAlign = isLeft ? 'left' : 'right';
  const chipsJustify = isLeft ? 'flex-end' : 'flex-start';

  const atHome       = v.location === 'home';
  const chargingHome = v.charging && atHome;
  const a            = alloc(v);
  const etaMin       = etaFor(v, a.kw);

  let statusLabel: string, statusAccent: boolean, statusPulse: boolean;
  if      (chargingHome) { statusLabel = 'CHARGING';        statusAccent = true;  statusPulse = true;  }
  else if (v.charging)   { statusLabel = 'CHARGING · AWAY'; statusAccent = true;  statusPulse = true;  }
  else if (!atHome)      { statusLabel = 'AWAY';            statusAccent = false; statusPulse = false; }
  else                   { statusLabel = 'IDLE';            statusAccent = false; statusPulse = false; }
  const statusColor = statusAccent ? ACCENT     : '#a4afba';
  const statusBg    = statusAccent ? ACCENT_SOFT : '#1b232b';
  const statusDot   = statusAccent ? ACCENT     : '#7d8893';
  const statusAnim  = statusPulse  ? 'evpulse 1.8s ease-in-out infinite' : 'none';

  const chips = buildChipsFor(v, alerts);

  const valueOffset = C - C * (v.soc / 100);
  const ang = (v.limit / 100) * Math.PI * 2;
  const tickX1 = (60 + 43 * Math.sin(ang)).toFixed(2);
  const tickY1 = (60 - 43 * Math.cos(ang)).toFixed(2);
  const tickX2 = (60 + 61 * Math.sin(ang)).toFixed(2);
  const tickY2 = (60 - 61 * Math.cos(ang)).toFixed(2);

  const etaLabel = chargingHome ? fmtEta(etaMin)
    : (!atHome && v.charging) ? 'CHARGING AWAY · ' + v.place
    : !atHome                 ? (v.speed > 0
                                  ? 'DRIVING ' + v.speed + ' mph · ' + v.place
                                  : 'PARKED · ' + v.place)
    :                           (v.soc >= v.limit ? 'AT TARGET' : 'IDLE · NOT PLUGGED IN');
  const etaColor = v.charging ? ACCENT : '#7d8893';

  // Start only makes sense plugged in; Stop stays available regardless (in
  // case charging is somehow still active without a fresh plug reading).
  const btnDisabled = !v.charging && !v.pluggedIn;
  const btnLabel  = v.charging ? 'Stop' : 'Start';
  const btnBg     = v.charging ? 'transparent' : (btnDisabled ? '#2a333c' : ACCENT);
  const btnBorder = v.charging ? '1px solid rgba(226,104,95,.5)' : '1px solid transparent';
  const btnColor  = v.charging ? '#e2685f' : (btnDisabled ? '#7d8893' : '#08231f');

  const dragging = React.useRef(false);
  const onDialDown = (e: React.PointerEvent<SVGSVGElement>) => {
    dragging.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    onSetLimit(v, dialSetFromPointer(e));
  };
  const onDialMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragging.current) onSetLimit(v, dialSetFromPointer(e));
  };
  const onDialUp = () => { dragging.current = false; };

  return (
    <div style={{
      background: '#161c22', border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 20, padding: '20px 22px',
      display: 'flex', flexDirection: 'column', gap: 14,
      boxShadow: '0 18px 44px -30px rgba(0,0,0,.85)',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 12, flexDirection: rowDir,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: nameAlign, flex: 'none' }}>
          <span style={{ fontSize: 19, fontWeight: 600 }}>{v.name}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#a4afba', letterSpacing: '.03em' }}>
            {v.model}
          </span>
        </div>

        {chips.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 6,
            flex: 1, minWidth: 0,
            alignContent: 'center', justifyContent: chipsJustify,
          }}>
            {chips.map((c, i) => (
              <span key={i} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: c.bg, color: c.color, border: `1px solid ${c.border}`,
                fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5,
                fontWeight: 600, letterSpacing: '.06em', padding: '5px 10px',
                borderRadius: 999, maxWidth: '100%',
              }}>
                <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 14, lineHeight: 1, flex: 'none', animation: c.anim ?? 'none' }}>
                  {c.icon}
                </span>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.label}</span>
              </span>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: badgeAlign, gap: 8, flex: 'none' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            background: statusBg, color: statusColor,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
            fontWeight: 600, letterSpacing: '.06em',
            padding: '6px 12px', borderRadius: 999,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusDot, animation: statusAnim }} />
            {statusLabel}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onToggleLock(v)} title={v.locked ? 'Locked' : 'Unlocked'} style={{
              appearance: 'none', cursor: 'pointer', width: 42, height: 42,
              borderRadius: 12, background: v.locked ? '#1b232b' : 'rgba(226,104,95,0.16)',
              border: '1px solid rgba(255,255,255,0.06)',
              color: v.locked ? '#a4afba' : '#e2685f',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
            }}>
              <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 22, lineHeight: 1 }}>
                {v.locked ? 'lock' : 'lock_open'}
              </span>
            </button>
            <button onClick={() => onToggleAc(v)} title={v.ac ? 'AC on' : 'AC off'} style={{
              appearance: 'none', cursor: 'pointer', width: 42, height: 42,
              borderRadius: 12, background: v.ac ? ACCENT_SOFT : '#1b232b',
              border: '1px solid rgba(255,255,255,0.06)',
              color: v.ac ? ACCENT : '#a4afba',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
            }}>
              <span style={{
                fontFamily: "'Material Symbols Rounded'", fontSize: 23, lineHeight: 1,
                animation: 'acspin 2.4s linear infinite',
                animationPlayState: v.ac ? 'running' : 'paused',
              }}>mode_fan</span>
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexDirection: rowDir }}>
        <svg width={128} height={128} viewBox="0 0 120 120"
             onPointerDown={onDialDown} onPointerMove={onDialMove} onPointerUp={onDialUp}
             style={{ flex: 'none', cursor: 'grab', touchAction: 'none' }}>
          <circle cx={60} cy={60} r={52} fill="none" stroke="#222b34" strokeWidth={9} />
          <g transform="rotate(-90 60 60)">
            <circle cx={60} cy={60} r={52} fill="none" stroke={ACCENT} strokeWidth={9}
                    strokeLinecap="round" strokeDasharray="326.726" strokeDashoffset={valueOffset} />
          </g>
          <line x1={tickX1} y1={tickY1} x2={tickX2} y2={tickY2} stroke="#e2685f" strokeWidth={3} strokeLinecap="round" />
          <text x={60} y={48} textAnchor="middle" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 7, letterSpacing: '.22em', fill: '#a4afba' }}>CHARGE</text>
          <text x={60} y={68} textAnchor="middle" style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, fontWeight: 600, fill: '#e8edf2' }}>{v.soc}%</text>
          <text x={60} y={82} textAnchor="middle" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 7, letterSpacing: '.18em', fill: '#e2685f' }}>LIMIT {v.limit}%</text>
        </svg>

        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          gridAutoFlow: 'dense',
          gap: '13px 18px', flex: 1, textAlign: statsTextAlign,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: colInside }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '.14em', color: '#7d8893' }}>RANGE LEFT</span>
            <span style={{ fontSize: 17, fontWeight: 600 }}>{v.range} <span style={{ fontSize: 11, color: '#a4afba', fontWeight: 500 }}>mi</span></span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: colOutside }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '.14em', color: '#7d8893' }}>ODOMETER</span>
            <span style={{ fontSize: 17, fontWeight: 600 }}>{v.odo.toLocaleString('en-US')} <span style={{ fontSize: 11, color: '#a4afba', fontWeight: 500 }}>mi</span></span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: colInside }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '.14em', color: '#7d8893' }}>TARGET</span>
            <span style={{ fontSize: 17, fontWeight: 600 }}>{v.limit}%</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: colOutside }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '.14em', color: '#7d8893' }}>CHARGE RATE</span>
            <span style={{ fontSize: 17, fontWeight: 600 }}>
              {chargingHome ? a.kw.toFixed(1) + ' kW' : (v.charging ? 'away' : '—')}
            </span>
          </div>
        </div>
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 11,
        borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexDirection: footerDir }}>
          {v.ctrl === 'full' && (
            <button onClick={() => onToggleCharging(v)} disabled={btnDisabled}
              title={btnDisabled ? 'Not plugged in' : undefined}
              style={{
                appearance: 'none', cursor: btnDisabled ? 'default' : 'pointer', flex: 'none',
                padding: '10px 18px', borderRadius: 11,
                background: btnBg, border: btnBorder, color: btnColor,
                fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 600,
              }}>{btnLabel}</button>
          )}
          {v.ctrl === 'schedule' && (
            <span style={{
              flex: 'none', padding: '10px 14px', borderRadius: 11,
              background: '#1b232b', border: '1px dashed rgba(255,255,255,0.12)',
              color: '#a4afba', fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10.5, letterSpacing: '.04em',
            }}>SCHEDULE ONLY</span>
          )}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5,
            fontWeight: 600, letterSpacing: '.04em', color: etaColor,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: etaColor }} />
            {etaLabel}
          </span>
        </div>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 8.5,
          letterSpacing: '.14em', color: '#5e6873', textAlign: sourceAlign,
        }}>
          {v.ctrl === 'full' ? 'CHARGE LIMIT' : 'CHARGE LIMIT · VIA SCHEDULE'} · DRAG DIAL · SOURCE {v.apiLabel}
        </span>
      </div>
    </div>
  );
};
