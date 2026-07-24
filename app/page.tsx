'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { DashboardData, VehicleData, WallConnectorData, DashboardFlags } from '@/app/api/dashboard/route';
import {
  AuthBanner,
  VehicleCard as DesignVehicleCard,
  buildTopBanner,
  type Vehicle as DesignVehicle,
  type AlertInputs,
} from '@/components/VehicleCard';
import type { RivianVehicleState } from '@/lib/rivian';
import type { TeslaVehicleState } from '@/lib/tesla';

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

// ── Data mappers (server VehicleData → design Vehicle + AlertInputs) ─────────
function toDesignVehicle(v: VehicleData): DesignVehicle {
  const s = v.state;
  const isTesla = v.id === 'tesla';
  const t = isTesla ? (s as TeslaVehicleState | null) : null;
  return {
    id: v.id,
    charger: v.chargerSide,
    name: v.name,
    model: v.model,
    soc: s ? Math.round(s.chargePercent) : 0,
    limit: s ? Math.round(s.chargeLimit) : 80,
    range: s ? Math.round(s.rangeMi) : 0,
    odo: s ? Math.round(s.odometer) : 0,
    capacity: isTesla ? 82 : 135,
    charging: s?.isCharging ?? false,
    amps: t?.chargerActualCurrentA ?? 0,
    today: 0,
    ctrl: isTesla ? 'full' : 'schedule',
    apiLabel: isTesla ? 'TESLA FLEET API' : 'RIVIAN · UNOFFICIAL API',
    ac: s?.climateOn ?? false,
    locked: s?.isLocked ?? true,
    // Preserve prior null-atHome-means-probably-home behavior so vehicles
    // with stale GPS don't false-flag as AWAY.
    location: v.atHome === false ? 'away' : 'home',
    place: '',
    speed: 0,
  };
}

function buildAlerts(data: DashboardData): AlertInputs {
  const flags: DashboardFlags = data.flags;
  const rivVeh = data.vehicles.find(v => v.id === 'rivian');
  const rivState = rivVeh?.state as RivianVehicleState | null;

  // Pick the worst tire corner to surface (critical > low).
  const tires: Array<[AlertInputs['rivianTireCorner'], string]> = [
    ['FL', rivState?.tirePressureFL ?? ''],
    ['FR', rivState?.tirePressureFR ?? ''],
    ['RL', rivState?.tirePressureRL ?? ''],
    ['RR', rivState?.tirePressureRR ?? ''],
  ];
  let tireStatus: AlertInputs['rivianTire'] = 'ok';
  let tireCorner: AlertInputs['rivianTireCorner'] = 'FL';
  for (const [corner, v] of tires) {
    if (/critical/i.test(v)) { tireStatus = 'critical'; tireCorner = corner; break; }
    if (/low/i.test(v)) { tireStatus = 'low'; tireCorner = corner; }
  }

  return {
    teslaReauth: flags.teslaReauthRequired ? 'expired' : 'ok',
    rivianAuth: flags.rivianReauthRequired ? 'expired' : flags.rivianReauthDueSoon ? 'due-soon' : 'ok',
    rivianAuthDays: flags.rivianReauthDaysLeft ?? 0,
    rivianOta: flags.rivianOtaInstalling ? 'installing' : flags.rivianOtaUpdateAvailable ? 'available' : 'none',
    rivianOtaVersion: rivState?.otaAvailableVersion || rivState?.otaCurrentVersion || '',
    rivianTire: tireStatus,
    rivianTireCorner: tireCorner,
    rivianWiper: flags.rivianWiperFluidLow ? 'low' : 'ok',
    rivianBrake: flags.rivianBrakeFluidLow ? 'low' : 'ok',
    rivianThermal: flags.rivianHvThermalEvent ? 'detected' : 'ok',
    rivianDerate: flags.rivianDerateReason ?? '',
    rivianPluggedIn: flags.rivianPluggedIn,
    // Same underlying phenomenon as rivianDerate/rivianDerateActive
    // (throttling from max down to ~5kW), but sticky until unplugged rather
    // than clearing the instant the derate condition itself clears —
    // confirmed with the user this is the desired persistence for this chip.
    rivianHandleHot: flags.rivianDerateStickyUntilUnplugged,
    // Placeholder — a real "scope missing" detector needs a server-side flag.
    teslaLocationScope: 'granted',
  };
}

// ── Circuit Panel ─────────────────────────────────────────────────────────────
function CircuitPanel({ wallConnectors, vehicles }: {
  wallConnectors: WallConnectorData[];
  vehicles: VehicleData[];
}) {
  const left  = wallConnectors.find(w => w.side === 'LEFT');
  const right = wallConnectors.find(w => w.side === 'RIGHT');

  // The Wall Connector's own pilot-signal reading (vitals.vehicleConnected)
  // can false-negative for a vehicle using a J1772 adapter (Rivian doesn't
  // have a native Tesla connector) — confirmed 2026-07-19: Rivian's own API,
  // its app, and Home Assistant all agreed it was plugged in while the Wall
  // Connector alone said disconnected. Trust either signal: only show
  // "disconnected" when the Wall Connector AND the assigned vehicle's own
  // reported plug state both agree nothing's connected.
  const leftVehiclePluggedIn  = vehicles.find(v => v.chargerSide === 'LEFT')?.state?.isPluggedIn  ?? false;
  const rightVehiclePluggedIn = vehicles.find(v => v.chargerSide === 'RIGHT')?.state?.isPluggedIn ?? false;

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
    { name: 'LEFT',  wc: left,  inUse: leftInUse,  amps: Math.round(leftAmps),  session: leftSessionKwh,  today: leftTodayKwh,  color: LEFT_COLOR,  vehicleConnected: (left?.vitals?.vehicleConnected ?? false)  || leftVehiclePluggedIn  },
    { name: 'RIGHT', wc: right, inUse: rightInUse, amps: Math.round(rightAmps), session: rightSessionKwh, today: rightTodayKwh, color: RIGHT_COLOR, vehicleConnected: (right?.vitals?.vehicleConnected ?? false) || rightVehiclePluggedIn },
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
            : side.vehicleConnected ? 'Vehicle connected · not charging' : 'No vehicle connected';
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
    </div>
  );
}

// ── Camera Modal ──────────────────────────────────────────────────────────────
function CameraModal({ streamUrl, garageConnected, garageDoorOpen, onClose, onToggleGarage }: {
  streamUrl: string; garageConnected: boolean; garageDoorOpen: boolean | null;
  onClose: () => void; onToggleGarage: () => void;
}) {
  // No error handling existed before — a failed <img> load (wrong URL, CORS,
  // auth, host unreachable from outside the LAN) just rendered nothing,
  // which against this dark background reads as "black" rather than an
  // obvious broken state. Now logs to the server (visible via /api/errors,
  // same pipeline as window.onerror) and shows a real failure message.
  //
  // The <img> now points at /api/camera/stream (server-side proxy to
  // camera.streamUrl) instead of the raw LAN URL — the container can reach
  // the camera/Scrypted address even when the browser viewing the page
  // can't (Cloudflare Tunnel, a different VLAN, etc.), which is why the
  // stream "worked on-LAN" but rendered frozen from anywhere else.
  //
  // MJPEG multipart streams can also stall mid-connection (frames just stop
  // arriving) without the browser ever firing onError — that reads as a
  // frozen frame forever. lastFrameAt + the watchdog below catch that: no
  // new frame (onLoad fires once per replaced part) in 10s counts as dead,
  // and reloadKey forces a fresh proxy connection every 15s while dead.
  const [imgError, setImgError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const lastFrameAt = useRef(Date.now());
  useEffect(() => { setImgError(false); lastFrameAt.current = Date.now(); setReloadKey(k => k + 1); }, [streamUrl]);
  useEffect(() => {
    const watchdog = setInterval(() => {
      if (Date.now() - lastFrameAt.current > 10_000) {
        setImgError(true);
        setReloadKey(k => k + 1);
        lastFrameAt.current = Date.now();
      }
    }, 3_000);
    return () => clearInterval(watchdog);
  }, []);
  function reportCameraError() {
    setImgError(true);
    fetch('/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'camera.img', message: `Failed to load camera stream: ${streamUrl}` }),
    }).catch(() => null);
  }
  function onFrame() {
    lastFrameAt.current = Date.now();
    setImgError(false);
  }

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
          {streamUrl && !imgError ? (
            <img
              src={`/api/camera/stream?k=${reloadKey}`}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              alt="Camera"
              onError={reportCameraError}
              onLoad={onFrame}
            />
          ) : streamUrl && imgError ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#e2685f' }}>
              <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 44 }}>videocam_off</span>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: '0.06em', textAlign: 'center', lineHeight: 1.6, maxWidth: 320 }}>
                CAMERA STREAM FAILED TO LOAD<br />
                <span style={{ color: '#7d8893' }}>check the Stream URL in Settings, and whether it&apos;s reachable from wherever you&apos;re viewing this from</span>
              </span>
            </div>
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
  // null until mount — SSR renders the same placeholder as the initial
  // client render, so the clock never causes a hydration text mismatch
  // (server time vs. client time would otherwise differ by the network
  // round-trip, tripping React error #418).
  const [time, setTime] = useState<Date | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  // Banner dismissal state. Reauth-critical banners ignore this; only the
  // "due-soon" banner honors it, and only for the current tab session.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [appUpdateAvailable, setAppUpdateAvailable] = useState(false);

  // Checked once per load — this is a kiosk tab that stays open for days,
  // and /api/version caches the GitHub call for 5 min server-side anyway.
  useEffect(() => {
    fetch('/api/version').then(r => r.json()).then((d: { outdated?: boolean }) => {
      setAppUpdateAvailable(!!d.outdated);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setTime(new Date());
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
  const dateStr = time ? time.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : '';
  const timeStr = time ? time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '--:--';

  const ageSec = data && time ? Math.max(0, Math.floor((time.getTime() - new Date(data.lastUpdated).getTime()) / 1000)) : 0;

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
  const inUseCount = (leftWC?.vitals?.vehicleCharging ? 1 : 0) + (rightWC?.vitals?.vehicleCharging ? 1 : 0);
  // Strict: only count vehicles with explicit positive home GPS. The earlier
  // "null + online → home" heuristic over-counted any vehicle that lost its
  // GPS reading mid-day (Tesla without vehicle_location scope is a common
  // case — falsely showed 2 home when only 1 was). Matches the per-card
  // badge logic: card shows AWAY only on explicit false, but the rollup is
  // about "how many do I know are home" — so we want positive evidence.
  const vehiclesHome = vehicles.filter(v => v.connected && v.atHome === true).length;

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

  const alerts = useMemo(() => {
    if (!data) {
      return {
        teslaReauth: 'ok', rivianAuth: 'ok', rivianAuthDays: 0,
        rivianOta: 'none', rivianOtaVersion: '',
        rivianTire: 'ok', rivianTireCorner: 'FL',
        rivianWiper: 'ok', rivianBrake: 'ok',
        rivianThermal: 'ok', rivianDerate: '',
        rivianPluggedIn: false, rivianHandleHot: false,
        teslaLocationScope: 'granted',
      } as AlertInputs;
    }
    return buildAlerts(data);
  }, [data]);

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
            <a href="/admin" title={appUpdateAvailable ? 'Settings — update available' : 'Settings'}
              style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, background: '#161c22', color: '#7d8893', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 9, textDecoration: 'none' }}>
              <span style={{ fontFamily: "'Material Symbols Rounded'", fontSize: 18, lineHeight: 1 }}>settings</span>
              {appUpdateAvailable && (
                <span style={{ position: 'absolute', top: -3, right: -3, width: 9, height: 9, borderRadius: '50%', background: ACCENT, border: '2px solid #0e1216' }} />
              )}
            </a>
          </div>
          {/* Stat chips */}
          <div style={{ display: 'flex', gap: 11 }}>
            <StatChip label="DRAWING" value={totalKw} unit="kW" />
            <StatChip label="CHARGERS" value={String(inUseCount)} unit="/ 2 in use" />
            <StatChip label="VEHICLES" value={String(vehiclesHome)} unit="home" />
          </div>
        </div>
      </div>

      {/* ── Auth banner (Tesla / Rivian re-auth) ── */}
      {data && (
        <AuthBanner state={buildTopBanner(alerts, {
          onReauthTesla:  () => { window.location.href = '/admin?tesla_reauth=1'; },
          onReauthRivian: () => { window.location.href = '/admin?rivian_reauth=1'; },
          onDismiss:      () => setBannerDismissed(true),
          bannerDismissed,
        })} />
      )}

      {/* ── Vehicle Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, flex: 'none' }}>
        {vehicles.map((v, idx) => {
          const wc = wallConnectors.find(w => w.side === v.chargerSide);
          const dv = toDesignVehicle(v);
          return (
            <DesignVehicleCard
              key={v.id}
              vehicle={dv}
              side={idx === 0 ? 'left' : 'right'}
              alerts={alerts}
              alloc={() => {
                // Actual amps + kW pulled from the corresponding wall connector,
                // not from the vehicle's own charge_state (which lies about
                // "power flowing" when Tesla decides to under-report).
                const amps = wc?.vitals?.currentA ?? 0;
                const kw = (wc?.vitals?.powerW ?? 0) / 1000;
                return { amps, kw };
              }}
              etaFor={(veh) => veh.charging ? (v.state?.minutesToFull ?? 0) : 0}
              onToggleCharging={() => sendCommand(v.state?.isCharging ? 'charge_stop' : 'charge_start')}
              onToggleLock={() => sendCommand(v.state?.isLocked ? 'unlock' : 'lock')}
              onToggleAc={() => sendCommand(v.state?.climateOn ? 'climate_stop' : 'climate_start')}
              onSetLimit={(_veh, pct) => sendCommand('set_charge_limit', { percent: pct })}
            />
          );
        })}
      </div>

      {/* ── Circuit Panel ── */}
      <CircuitPanel wallConnectors={wallConnectors} vehicles={vehicles} />

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
