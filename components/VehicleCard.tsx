// components/VehicleCard.tsx
// Ported from design handoff 2026-07-25 (vehicle-card.tsx, tap-to-set charge
// limit popup + chip overlay iteration). Kept as-is from the handoff except
// for this header comment and the dial-wrapper positioning fix noted below —
// do not rename exports or paraphrase copy.

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
  critical: { color: '#e2685f', bg: 'rgba(226,104,95,0.10)', border: 'rgba(226,104,95,0.28)' }
};

// Keyframes used by chips + status pill. Not mounted here — evpulse/acspin
// are already defined globally in app/globals.css, mounting a duplicate
// <style> per card would be redundant.
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
  name: string;             // display name, e.g. 'Midknight'
  model: string;            // e.g. 'R1S · QUAD-MOTOR · LARGE PACK'
  soc: number;              // 0..100
  limit: number;            // 50..100
  range: number;            // mi
  odo: number;              // mi
  capacity: number;         // kWh
  charging: boolean;
  amps: number;
  today: number;            // kWh delivered today
  ctrl: 'full' | 'schedule';
  apiLabel: string;
  ac: boolean;
  locked: boolean;
  location: 'home' | 'away';
  place: string;
  speed: number;            // mph
};

export type AlertInputs = {
  // banner
  teslaReauth:  'ok' | 'expired';
  rivianAuth:   'ok' | 'due-soon' | 'expired';
  rivianAuthDays: number;

  // rivian card
  rivianOta:        'none' | 'available' | 'installing';
  rivianOtaVersion: string;
  rivianTire:       'ok' | 'low' | 'critical';
  rivianTireCorner: 'FL' | 'FR' | 'RL' | 'RR';
  rivianWiper:      'ok' | 'low';
  rivianBrake:      'ok' | 'low';
  rivianThermal:    'ok' | 'detected';
  rivianDerate:     string;           // non-empty = fire
  rivianPluggedIn:  boolean;          // "PLUGGED IN" chip — shown only while NOT charging (redundant if charging)
  rivianHandleHot:  boolean;          // "CHARGING RATE THROTTLED" chip

  // tesla card
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
  ...SEV[sev], icon, label, ...extra
});

export function buildChipsFor(veh: Vehicle, a: AlertInputs): Chip[] {
  const chips: Chip[] = [];

  if (veh.id === 'rivian') {
    // Handle-hot + plugged-in unshift LAST so they read first of all (most current status)
    if (a.rivianHandleHot) {
      chips.unshift(mkChip('warning', 'device_thermostat', 'CHARGING RATE THROTTLED'));
    }
    if (a.rivianPluggedIn && !veh.charging) {
      // Only show "plugged in" when it's the useful signal — i.e. plugged in but
      // NOT charging. While charging, plugged-in is implied; showing the chip then is redundant.
      chips.unshift(mkChip('info', 'power', 'PLUGGED IN'));
    }

    // Warnings prepended so they read first
    if (a.rivianThermal === 'detected') {
      chips.push(mkChip('critical', 'battery_alert',
        'THERMAL EVENT — CHECK RIVIAN APP',
        { anim: 'evpulse 1.6s ease-in-out infinite' }));
    } else if (a.rivianDerate?.trim()) {
      chips.push(mkChip('warning', 'device_thermostat',
        'CHARGING SLOWED — ' + a.rivianDerate.trim().toUpperCase()));
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
      const cornerNames: Record<string, string> = { FL: 'FRONT LEFT', FR: 'FRONT RIGHT', RL: 'REAR LEFT', RR: 'REAR RIGHT' };
      chips.push(mkChip(sev, 'tire_repair',
        (cornerNames[a.rivianTireCorner] || a.rivianTireCorner) + ' TIRE · ' + a.rivianTire.toUpperCase()));
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
// AuthBanner — mount above the "Energy" header
// ─────────────────────────────────────────────────────────────

export const AuthBanner: React.FC<{ state: BannerState }> = ({ state }) => {
  if (!state.show) return null;
  return (
    <div style={{
      flex: 'none', display: 'flex', alignItems: 'center', gap: 14,
      padding: '12px 18px', borderRadius: 14,
      background: state.bg, border: `1px solid ${state.border}`,
      borderLeft: `3px solid ${state.color}`
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
          fontSize: 13, fontWeight: 600, flex: 'none'
        }}>{state.ctaLabel}</button>
      )}
      {state.dismissible && state.onDismiss && (
        <button onClick={state.onDismiss} title="Dismiss for 24h" style={{
          appearance: 'none', cursor: 'pointer', width: 32, height: 32,
          borderRadius: 9, background: 'transparent',
          border: '1px solid rgba(255,255,255,0.08)', color: '#a4afba',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0, flex: 'none'
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

const C = 326.726;                             // 2π · r=52 (dial circumference)
export const kwFor = (amps: number) => amps * 240 / 1000;

export function fmtEta(min: number): string {
  if (min <= 0) return 'AT TARGET';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m TO TARGET` : `${m}m TO TARGET`;
}

// Drag handler — pointer → dial %, clamped 50..100 in 5% steps.
export function dialSetFromPointer(
  e: React.PointerEvent<SVGSVGElement>
): number {
  const svg = e.currentTarget;
  const r = svg.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  let ang = Math.atan2(dx, -dy);
  if (ang < 0) ang += Math.PI * 2;
  let pct = ang / (Math.PI * 2) * 100;
  return Math.max(50, Math.min(100, Math.round(pct / 5) * 5));
}

// ─────────────────────────────────────────────────────────────
// VehicleCard
// ─────────────────────────────────────────────────────────────

export type VehicleCardProps = {
  vehicle: Vehicle;
  side: 'left' | 'right';                 // left = dial on right (rowReverse)
  alerts: AlertInputs;
  alloc: (v: Vehicle) => { amps: number; kw: number };  // parent-owned circuit share
  etaFor: (v: Vehicle, kw: number) => number;            // minutes to target

  onToggleCharging: (v: Vehicle) => void;
  onToggleLock:     (v: Vehicle) => void;
  onToggleAc:       (v: Vehicle) => void;
  onSetLimit:       (v: Vehicle, pct: number) => void;   // called only on Save, Tesla-only flow
};

export const VehicleCard: React.FC<VehicleCardProps> = (props) => {
  const { vehicle: v, side, alerts, alloc, etaFor,
          onToggleCharging, onToggleLock, onToggleAc, onSetLimit } = props;

  // side vars — mirror everything from one flag
  const isLeft = side === 'left';
  const rowDir: 'row' | 'row-reverse' = isLeft ? 'row-reverse' : 'row';
  const statsTextAlign = isLeft ? 'right' : 'left';
  const colInside  = isLeft ? 2 : 1;   // RANGE + TARGET (dial-side column)
  const colOutside = isLeft ? 1 : 2;   // ODOMETER + CHARGE RATE
  const badgeAlign = isLeft ? 'flex-start' : 'flex-end';
  const nameAlign  = isLeft ? 'flex-end'   : 'flex-start';
  const footerDir: 'row' | 'row-reverse' = isLeft ? 'row' : 'row-reverse';
  const sourceAlign = isLeft ? 'left' : 'right';
  const chipsJustify = isLeft ? 'flex-end' : 'flex-start'; // unused since chips became an absolute overlay; kept to match design source verbatim

  const atHome       = v.location === 'home';
  const chargingHome = v.charging && atHome;
  const a            = alloc(v);
  const etaMin       = etaFor(v, a.kw);
  const canEditLimit = v.ctrl === 'full';   // only Tesla (Fleet API) can set a limit directly
  const pluggedIn    = v.charging || (v.id === 'rivian' && alerts.rivianPluggedIn);

  // status pill
  let statusLabel: string, statusAccent: boolean, statusPulse: boolean;
  if      (chargingHome) { statusLabel = 'CHARGING';        statusAccent = true;  statusPulse = true;  }
  else if (v.charging)   { statusLabel = 'CHARGING · AWAY'; statusAccent = true;  statusPulse = true;  }
  else if (!atHome)      { statusLabel = 'AWAY';            statusAccent = false; statusPulse = false; }
  else                   { statusLabel = 'IDLE';            statusAccent = false; statusPulse = false; }
  const statusColor = statusAccent ? ACCENT     : '#a4afba';
  const statusBg    = statusAccent ? ACCENT_SOFT : '#1b232b';
  const statusDot   = statusAccent ? ACCENT     : '#7d8893';
  const statusAnim  = statusPulse  ? 'evpulse 1.8s ease-in-out infinite' : 'none';

  // chips
  const chips = buildChipsFor(v, alerts);

  // dial geometry
  const valueOffset = C - C * (v.soc / 100);
  const ang = (v.limit / 100) * Math.PI * 2;
  const tickX1 = (60 + 43 * Math.sin(ang)).toFixed(2);
  const tickY1 = (60 - 43 * Math.cos(ang)).toFixed(2);
  const tickX2 = (60 + 61 * Math.sin(ang)).toFixed(2);
  const tickY2 = (60 - 61 * Math.cos(ang)).toFixed(2);

  // footer eta line
  const etaLabel = chargingHome ? fmtEta(etaMin)
    : (!atHome && v.charging) ? 'CHARGING AWAY · ' + v.place
    : !atHome                 ? (v.speed > 0
                                  ? 'DRIVING ' + v.speed + ' mph · ' + v.place
                                  : 'PARKED · ' + v.place)
    :                           (v.soc >= v.limit ? 'AT TARGET' : (pluggedIn ? 'PLUGGED IN · NOT CHARGING' : 'IDLE · NOT PLUGGED IN'));
  const etaColor = v.charging ? ACCENT : '#7d8893';

  // start/stop button — 1px border in BOTH states so card doesn't reflow
  const btnLabel  = v.charging ? 'Stop' : 'Start';
  const btnBg     = v.charging ? 'transparent' : ACCENT;
  const btnBorder = v.charging ? '1px solid rgba(226,104,95,.5)' : '1px solid transparent';
  const btnColor  = v.charging ? '#e2685f' : '#08231f';

  // dial: Tesla only, tap-to-open a limit editor (no drag — precise stepper instead)
  const [limitEditorOpen, setLimitEditorOpen] = React.useState(false);
  const [limitDraft, setLimitDraft] = React.useState(v.limit);
  const onDialTap = () => { if (canEditLimit) { setLimitDraft(v.limit); setLimitEditorOpen(true); } };
  const dialCursor = canEditLimit ? 'pointer' : 'default';

  // ── render ─────────────────────────────────────────────────
  return (
    <div style={{
      background: '#161c22', border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 20, padding: '20px 22px',
      display: 'flex', flexDirection: 'column', gap: 14,
      boxShadow: '0 18px 44px -30px rgba(0,0,0,.85)',
      position: 'relative'
    }}>
      {/* Chips overlay — absolutely positioned & centered so it never offsets the header */}
      {chips.length > 0 && (
        <div style={{
          position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center',
          maxWidth: 'calc(100% - 44px)', pointerEvents: 'none'
        }}>
          {chips.map((c, i) => (
            <span key={i} style={{
              pointerEvents: 'auto',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: c.bg, color: c.color, border: `1px solid ${c.border}`,
              fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5,
              fontWeight: 600, letterSpacing: '.06em', padding: '5px 10px',
              borderRadius: 999, maxWidth: '100%'
            }}>
              <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 14, lineHeight: 1, flex: 'none', animation: c.anim ?? 'none' }}>
                {c.icon}
              </span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.label}</span>
            </span>
          ))}
        </div>
      )}

      {/* ── HEADER: name/model | status + lock/AC (chips sit as an overlay above, not a layout row) ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 12, flexDirection: rowDir
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: nameAlign, flex: 'none' }}>
          <span style={{ fontSize: 19, fontWeight: 600 }}>{v.name}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#a4afba', letterSpacing: '.03em' }}>
            {v.model}
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: badgeAlign, gap: 8, flex: 'none' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            background: statusBg, color: statusColor,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
            fontWeight: 600, letterSpacing: '.06em',
            padding: '6px 12px', borderRadius: 999
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
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0
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
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0
            }}>
              <span style={{
                fontFamily: "'Material Symbols Rounded'", fontSize: 23, lineHeight: 1,
                animation: 'acspin 2.4s linear infinite',
                animationPlayState: v.ac ? 'running' : 'paused'
              }}>mode_fan</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── MIDDLE: dial + mirrored 2x2 stats ── */}
      <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexDirection: rowDir }}>
        {/* Dial wrapper — position:relative anchor for the SOC/limit text
            overlay and the limit-editor popup below. Without this, their
            position:absolute would anchor to the outer card instead of the
            128x128 dial (the card is the nearest OTHER positioned ancestor). */}
        <div style={{ position: 'relative', width: 128, height: 128, flex: 'none' }}>
          <svg width={128} height={128} viewBox="0 0 120 120"
               onClick={onDialTap}
               style={{ cursor: dialCursor, touchAction: 'none' }}>
            <circle cx={60} cy={60} r={52} fill="none" stroke="#222b34" strokeWidth={9} />
            <g transform="rotate(-90 60 60)">
              <circle cx={60} cy={60} r={52} fill="none" stroke={ACCENT} strokeWidth={9}
                      strokeLinecap="round" strokeDasharray="326.726" strokeDashoffset={valueOffset} />
            </g>
            <line x1={tickX1} y1={tickY1} x2={tickX2} y2={tickY2} stroke="#e2685f" strokeWidth={3} strokeLinecap="round" />
          </svg>
          {/* SOC/limit numbers render as an HTML overlay, not SVG <text> —
              mixed static+dynamic text inside SVG <text> failed to interpolate
              in the source engine; this overlay approach is the safe pattern. */}
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 1, pointerEvents: 'none'
          }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, letterSpacing: '.22em', color: '#a4afba' }}>CHARGE</span>
            <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 26, fontWeight: 600, color: '#e8edf2', lineHeight: 1.1 }}>{v.soc}%</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, letterSpacing: '.18em', color: '#e2685f' }}>LIMIT {v.limit}%</span>
          </div>

          {limitEditorOpen && (
            <div style={{
              position: 'absolute', top: 136, left: '50%', transform: 'translateX(-50%)', zIndex: 5,
              background: '#1b232b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14,
              padding: 14, display: 'flex', flexDirection: 'column', gap: 10, width: 200,
              boxShadow: '0 20px 44px -20px rgba(0,0,0,.9)'
            }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '.14em', color: '#a4afba' }}>SET CHARGE LIMIT</span>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <button onClick={() => setLimitDraft(d => Math.max(50, d - 5))} style={{
                  appearance: 'none', cursor: 'pointer', width: 34, height: 34, borderRadius: 9,
                  background: '#0e1216', border: '1px solid rgba(255,255,255,0.1)', color: '#e8edf2',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0
                }}>
                  <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 19, lineHeight: 1 }}>remove</span>
                </button>
                <span style={{ fontSize: 19, fontWeight: 600, width: 52, textAlign: 'center' }}>{limitDraft}%</span>
                <button onClick={() => setLimitDraft(d => Math.min(100, d + 5))} style={{
                  appearance: 'none', cursor: 'pointer', width: 34, height: 34, borderRadius: 9,
                  background: '#0e1216', border: '1px solid rgba(255,255,255,0.1)', color: '#e8edf2',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0
                }}>
                  <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 19, lineHeight: 1 }}>add</span>
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setLimitEditorOpen(false)} style={{
                  flex: 1, appearance: 'none', cursor: 'pointer', padding: 8, borderRadius: 9,
                  background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: '#a4afba',
                  fontFamily: "'Space Grotesk', sans-serif", fontSize: 12.5, fontWeight: 600
                }}>Cancel</button>
                <button onClick={() => { onSetLimit(v, limitDraft); setLimitEditorOpen(false); }} style={{
                  flex: 1, appearance: 'none', cursor: 'pointer', padding: 8, borderRadius: 9,
                  background: ACCENT, border: 'none', color: '#08231f',
                  fontFamily: "'Space Grotesk', sans-serif", fontSize: 12.5, fontWeight: 600
                }}>Save</button>
              </div>
            </div>
          )}
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          gridAutoFlow: 'dense',                          // required so mirrored columns fill row 1 correctly
          gap: '13px 18px', flex: 1, textAlign: statsTextAlign
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

      {/* ── FOOTER: start/stop + eta + source caption ── */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 11,
        borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 14
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexDirection: footerDir }}>
          {v.ctrl === 'full' && (
            <button onClick={() => onToggleCharging(v)} style={{
              appearance: 'none', cursor: 'pointer', flex: 'none',
              padding: '10px 18px', borderRadius: 11,
              background: btnBg, border: btnBorder, color: btnColor,
              fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 600
            }}>{btnLabel}</button>
          )}
          {v.ctrl === 'schedule' && (
            <span style={{
              flex: 'none', padding: '10px 14px', borderRadius: 11,
              background: '#1b232b', border: '1px dashed rgba(255,255,255,0.12)',
              color: '#a4afba', fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10.5, letterSpacing: '.04em'
            }}>SCHEDULE ONLY</span>
          )}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5,
            fontWeight: 600, letterSpacing: '.04em', color: etaColor
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: etaColor }} />
            {etaLabel}
          </span>
        </div>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 8.5,
          letterSpacing: '.14em', color: '#5e6873', textAlign: sourceAlign
        }}>
          {v.ctrl === 'full' ? 'CHARGE LIMIT' : 'CHARGE LIMIT · VIA SCHEDULE'} · {canEditLimit ? 'TAP DIAL TO SET' : 'SET VIA RIVIAN APP'} · SOURCE {v.apiLabel}
        </span>
      </div>
    </div>
  );
};
