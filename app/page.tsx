'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardData, VehicleData, WallConnectorData } from './api/dashboard/route';

const REFRESH_MS = 30000;

// ── SVG Charge Dial ───────────────────────────────────────────────────────────
const CX = 90, CY = 90, R = 72;
const START_DEG = 135;
const SWEEP = 270;

function toRad(deg: number) { return (deg * Math.PI) / 180; }

function polarXY(deg: number) {
  return { x: CX + R * Math.cos(toRad(deg)), y: CY + R * Math.sin(toRad(deg)) };
}

function arcPath(startDeg: number, endDeg: number) {
  const s = polarXY(startDeg);
  const e = polarXY(endDeg);
  const sweep = ((endDeg - startDeg) + 360) % 360;
  if (sweep < 0.5) return '';
  const large = sweep > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

function degForPercent(pct: number) { return START_DEG + (pct / 100) * SWEEP; }

interface DialProps {
  chargePercent: number;
  chargeLimit: number;
  accent: string;
  onSetLimit?: (limit: number) => void;
}

function ChargeDial({ chargePercent, chargeLimit, accent, onSetLimit }: DialProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const [localLimit, setLocalLimit] = useState(chargeLimit);

  useEffect(() => { setLocalLimit(chargeLimit); }, [chargeLimit]);

  const chargeDeg = degForPercent(Math.min(chargePercent, 100));
  const limitDeg = degForPercent(localLimit);
  const handlePos = polarXY(limitDeg);

  function eventToAngleDeg(e: React.PointerEvent | PointerEvent): number {
    const svg = svgRef.current;
    if (!svg) return START_DEG;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 180 - CX;
    const y = ((e.clientY - rect.top) / rect.height) * 180 - CY;
    return (Math.atan2(y, x) * 180) / Math.PI;
  }

  function angleToPercent(deg: number): number {
    const norm = ((deg - START_DEG) + 360) % 360;
    if (norm > SWEEP) {
      return norm - SWEEP > 180 - SWEEP / 2 ? 0 : 100;
    }
    return Math.round((norm / SWEEP) * 100);
  }

  const onPointerDown = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    dragging.current = true;
    (e.target as SVGCircleElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    if (!dragging.current) return;
    const deg = eventToAngleDeg(e);
    const pct = Math.max(50, Math.min(100, angleToPercent(deg)));
    setLocalLimit(pct);
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    onSetLimit?.(localLimit);
  }, [localLimit, onSetLimit]);

  const minsToFull = chargePercent < localLimit ? Math.round(((localLimit - chargePercent) / 100) * 400) : 0;
  const etaStr = minsToFull > 0 ? `${Math.floor(minsToFull / 60)}h ${minsToFull % 60}m` : '–';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <svg ref={svgRef} viewBox="0 0 180 180" width={180} height={180}>
        {/* Track */}
        <path d={arcPath(START_DEG, START_DEG + SWEEP)} fill="none" stroke="#1e2b33" strokeWidth={10} strokeLinecap="round" />
        {/* Charge fill */}
        {chargePercent > 0 && (
          <path d={arcPath(START_DEG, chargeDeg)} fill="none" stroke={accent} strokeWidth={10} strokeLinecap="round" />
        )}
        {/* Limit marker */}
        <line
          x1={CX + (R - 14) * Math.cos(toRad(limitDeg))}
          y1={CY + (R - 14) * Math.sin(toRad(limitDeg))}
          x2={CX + (R + 4) * Math.cos(toRad(limitDeg))}
          y2={CY + (R + 4) * Math.sin(toRad(limitDeg))}
          stroke="#fff"
          strokeWidth={2}
          strokeLinecap="round"
          opacity={0.5}
        />
        {/* Drag handle */}
        <circle
          cx={handlePos.x}
          cy={handlePos.y}
          r={8}
          fill="#fff"
          stroke="#0e1216"
          strokeWidth={2}
          style={{ cursor: onSetLimit ? 'grab' : 'default' }}
          onPointerDown={onSetLimit ? onPointerDown : undefined}
          onPointerMove={onSetLimit ? onPointerMove : undefined}
          onPointerUp={onSetLimit ? onPointerUp : undefined}
        />
        {/* Percent text */}
        <text x={CX} y={CY - 6} textAnchor="middle" fill="#e8edf0" fontFamily="JetBrains Mono, monospace" fontSize={30} fontWeight={700}>
          {chargePercent}
        </text>
        <text x={CX} y={CY + 14} textAnchor="middle" fill="#6b8599" fontFamily="JetBrains Mono, monospace" fontSize={12}>
          %
        </text>
        {/* Limit label */}
        <text x={CX} y={CY + 32} textAnchor="middle" fill="#3d5566" fontFamily="JetBrains Mono, monospace" fontSize={10}>
          LIM {localLimit}%
        </text>
      </svg>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#6b8599' }}>
        ETA {etaStr}
      </div>
    </div>
  );
}

// ── Vehicle Card ──────────────────────────────────────────────────────────────
interface VehicleCardProps {
  vehicle: VehicleData;
  accent: string;
  onCommand: (cmd: string, params?: Record<string, unknown>) => void;
}

function chargeBadgeClass(v: VehicleData): string {
  if (!v.connected || !v.state) return 'disconnected';
  if (v.state.isCharging) return 'charging';
  if (v.state.chargePercent >= v.state.chargeLimit - 1) return 'full';
  return 'plugged';
}

function chargeBadgeText(v: VehicleData): string {
  if (!v.connected || !v.state) return 'Offline';
  if (v.state.isCharging) return 'Charging';
  if (v.state.chargePercent >= (v.state.chargeLimit - 1)) return 'Full';
  return v.state.chargingState;
}

function VehicleCard({ vehicle: v, accent, onCommand }: VehicleCardProps) {
  const s = v.state;
  const badgeClass = chargeBadgeClass(v);
  const badgeText = chargeBadgeText(v);

  const isTesla = v.id === 'tesla';
  const rangeMi = s ? Math.round(s.rangeMi) : 0;
  const addedMi = s ? Math.round(s.addedRangeMi) : 0;
  const chargeRate = s ? Math.round(s.chargeRateMph) : 0;
  const odo = s ? Math.round(s.odometer) : 0;

  function handleSetLimit(limit: number) {
    if (isTesla) onCommand('set_charge_limit', { percent: limit });
  }

  function handleActionClick() {
    if (!isTesla || !s) return;
    if (s.isCharging) {
      onCommand('charge_stop');
    } else {
      onCommand('charge_start');
    }
  }

  return (
    <div className="vehicle-card">
      {/* Header */}
      <div className="vehicle-card-header">
        <div className="vehicle-title">
          <div className="vehicle-name">{v.name}</div>
          <div className="vehicle-model">{v.model}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <div className="vehicle-badges">
            <div className={`charge-badge ${badgeClass}`}>{badgeText}</div>
          </div>
          {isTesla && s && (
            <div className="vehicle-controls">
              <button
                className={`ctrl-btn${s.isLocked ? ' active' : ''}`}
                title={s.isLocked ? 'Unlock' : 'Lock'}
                onClick={() => onCommand(s.isLocked ? 'unlock' : 'lock')}
              >
                <span className="icon" style={{ fontSize: 16 }}>{s.isLocked ? 'lock' : 'lock_open'}</span>
              </button>
              <button
                className={`ctrl-btn${s.climateOn ? ' active' : ''}`}
                title={s.climateOn ? 'Stop Climate' : 'Start Climate'}
                onClick={() => onCommand(s.climateOn ? 'climate_stop' : 'climate_start')}
              >
                <span className="icon" style={{ fontSize: 16 }}>ac_unit</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Vehicle image area */}
      <div className="vehicle-image-area">
        <div className="vehicle-image-placeholder">
          <span className="icon" style={{ fontSize: 40, opacity: 0.2 }}>directions_car</span>
        </div>
      </div>

      {/* Charge dial */}
      <div className="dial-area">
        <ChargeDial
          chargePercent={s?.chargePercent ?? 0}
          chargeLimit={s?.chargeLimit ?? 80}
          accent={accent}
          onSetLimit={isTesla && s ? handleSetLimit : undefined}
        />
      </div>

      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-cell">
          <div className="stat-label">Range</div>
          <div className={`stat-value${s ? '' : ' dim'}`}>{s ? `${rangeMi} mi` : '—'}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Added</div>
          <div className={`stat-value${s && addedMi > 0 ? ' accent' : ' dim'}`}>
            {s && addedMi > 0 ? `+${addedMi} mi` : '—'}
          </div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Charge Rate</div>
          <div className={`stat-value${s && chargeRate > 0 ? '' : ' dim'}`}>
            {s && chargeRate > 0 ? `${chargeRate} mph` : '—'}
          </div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Odometer</div>
          <div className={`stat-value dim`}>{s ? `${odo.toLocaleString()} mi` : '—'}</div>
        </div>
      </div>

      {/* Action button */}
      <div className="vehicle-action">
        {isTesla && s ? (
          <button
            className={`action-btn ${s.isCharging ? 'charging' : 'start'}`}
            onClick={handleActionClick}
          >
            <span className="icon" style={{ fontSize: 16 }}>
              {s.isCharging ? 'stop_circle' : 'bolt'}
            </span>
            {s.isCharging ? 'Stop Charging' : 'Start Charging'}
          </button>
        ) : (
          <button className="action-btn disabled" disabled>
            <span className="icon" style={{ fontSize: 16 }}>link_off</span>
            Not Connected
          </button>
        )}
      </div>
    </div>
  );
}

// ── Circuit Panel ─────────────────────────────────────────────────────────────
function CircuitPanel({ wallConnectors, site }: {
  wallConnectors: WallConnectorData[];
  site: DashboardData['site'];
}) {
  const MAX_AMPS = 48;
  const VOLTAGE = 240;

  const leftWc = wallConnectors.find(w => w.side === 'LEFT');
  const rightWc = wallConnectors.find(w => w.side === 'RIGHT');

  const leftAmps = leftWc?.vitals?.currentA ?? 0;
  const rightAmps = rightWc?.vitals?.currentA ?? 0;
  const totalAmps = leftAmps + rightAmps;

  const solarKw = site ? (site.solarPowerW / 1000).toFixed(1) : null;
  const totalKw = ((totalAmps * VOLTAGE) / 1000).toFixed(1);

  return (
    <div className="circuit-panel">
      <div className="circuit-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="circuit-label">Shared Circuit</span>
          <span className="circuit-specs">
            <span>{MAX_AMPS}A</span>
            <span style={{ color: '#1e2b33' }}>·</span>
            <span>{VOLTAGE}V</span>
          </span>
          {solarKw !== null && (
            <span className="circuit-specs" style={{ color: '#34e0c4' }}>
              <span className="icon" style={{ fontSize: 13 }}>wb_sunny</span>
              {solarKw} kW
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="circuit-power">{totalKw} kW</span>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#6b8599' }}>
            {totalAmps.toFixed(0)}/{MAX_AMPS}A
          </span>
        </div>
      </div>

      <div className="circuit-bar-wrap">
        <div className="circuit-bar-fill" style={{ width: `${Math.min((totalAmps / MAX_AMPS) * 100, 100)}%` }} />
      </div>

      <div className="wc-row">
        {[leftWc, rightWc].map(wc => {
          if (!wc) return null;
          const amps = wc.vitals?.currentA ?? 0;
          const charging = wc.vitals?.vehicleCharging ?? false;
          return (
            <div key={wc.side} className="wc-card">
              <div className="wc-info">
                <div className="wc-side">{wc.side} Wall Connector</div>
                <div className="wc-vehicle">{wc.vehicleName}</div>
                <div className="wc-status">
                  {wc.vitals ? (charging ? 'Charging' : wc.vitals.vehicleConnected ? 'Plugged in' : 'Available') : 'Offline'}
                </div>
              </div>
              <div className="wc-power">
                <div className={`wc-amps${amps === 0 ? ' idle' : ''}`}>{amps.toFixed(0)}</div>
                <div className="wc-unit">A</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Camera Modal ──────────────────────────────────────────────────────────────
function CameraModal({ streamUrl, garageDoorOpen, onClose, onToggleGarage }: {
  streamUrl: string;
  garageDoorOpen: boolean | null;
  onClose: () => void;
  onToggleGarage: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="camera-modal" onClick={e => e.stopPropagation()}>
        <div className="camera-modal-header">
          <span className="camera-modal-title">Garage Camera</span>
          <button className="ctrl-btn" onClick={onClose}>
            <span className="icon" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>

        <div className="camera-feed">
          {streamUrl ? (
            <img src={streamUrl} alt="Camera feed" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <span className="icon" style={{ fontSize: 40, opacity: 0.3 }}>videocam_off</span>
              <span>Camera not configured</span>
            </div>
          )}
        </div>

        <div className="camera-modal-footer">
          <div style={{ fontSize: 12, color: '#6b8599' }}>
            {garageDoorOpen === null ? 'Garage door status unknown' :
              garageDoorOpen ? 'Garage door is open' : 'Garage door is closed'}
          </div>
          <button
            className={`garage-btn ${garageDoorOpen === null ? 'unknown' : garageDoorOpen ? 'open' : 'closed'}`}
            onClick={onToggleGarage}
          >
            <span className="icon" style={{ fontSize: 16 }}>
              {garageDoorOpen ? 'garage' : 'garage'}
            </span>
            {garageDoorOpen === null ? 'Toggle Door' : garageDoorOpen ? 'Close Door' : 'Open Door'}
          </button>
        </div>
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

  const accent = '#34e0c4';

  // Clock
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Data fetch
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard', { cache: 'no-store' });
      if (!res.ok) { setFeedState('error'); return; }
      const json = await res.json() as DashboardData;
      setData(json);
      const ageMs = Date.now() - new Date(json.lastUpdated).getTime();
      setFeedState(ageMs < 60000 ? 'live' : 'stale');
    } catch {
      setFeedState('error');
    }
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
      setTimeout(fetchData, 2000);
    } finally {
      setCommandPending(false);
    }
  }

  const dateStr = time.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const weather = data?.weather;
  const streamUrl = '';

  return (
    <div className="dashboard">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <span className="site-name">Halton Place</span>
          <span className="header-time mono">{dateStr} · {timeStr}</span>
          {weather && (
            <div className="weather-badge">
              <span className="icon" style={{ fontSize: 14 }}>wb_sunny</span>
              <span>{weather.temp}°C</span>
              <span style={{ color: '#3d5566' }}>·</span>
              <span style={{ textTransform: 'capitalize' }}>{weather.condition}</span>
            </div>
          )}
        </div>
        <div className="header-right">
          <div className={`feed-status`}>
            <div className={`feed-dot ${feedState}`} />
            <span style={{ color: '#6b8599', fontSize: 12 }}>
              {feedState === 'live' ? 'Live' : feedState === 'stale' ? 'Stale' : 'Error'}
            </span>
          </div>
          <button
            className={`icon-btn${data?.garageDoorOpen ? ' active' : ''}`}
            onClick={() => setShowCamera(true)}
            title="Garage / Camera"
          >
            <span className="icon" style={{ fontSize: 16 }}>garage</span>
            <span style={{ fontSize: 12 }}>
              {data?.garageDoorOpen === true ? 'Open' : data?.garageDoorOpen === false ? 'Closed' : 'Garage'}
            </span>
          </button>
          <button className="icon-btn" onClick={() => setShowCamera(true)} title="Camera">
            <span className="icon" style={{ fontSize: 16 }}>videocam</span>
          </button>
          <a href="/admin" className="icon-btn" title="Settings">
            <span className="icon" style={{ fontSize: 16 }}>settings</span>
          </a>
        </div>
      </header>

      {/* Vehicles */}
      <div className="vehicles-row">
        {(data?.vehicles ?? [
          { id: 'rivian', name: 'Midknight', model: 'Rivian R1S', chargerSide: 'LEFT', state: null, connected: false },
          { id: 'tesla', name: 'Tesla', model: 'Model 3', chargerSide: 'RIGHT', state: null, connected: false },
        ]).map(v => (
          <VehicleCard
            key={v.id}
            vehicle={v}
            accent={accent}
            onCommand={(cmd, params) => sendCommand(cmd, params)}
          />
        ))}
      </div>

      {/* Circuit Panel */}
      <CircuitPanel
        wallConnectors={data?.wallConnectors ?? [
          { side: 'LEFT', vehicleName: 'Midknight', vitals: null },
          { side: 'RIGHT', vehicleName: 'Tesla', vitals: null },
        ]}
        site={data?.site ?? null}
      />

      {/* Camera Modal */}
      {showCamera && (
        <CameraModal
          streamUrl={streamUrl}
          garageDoorOpen={data?.garageDoorOpen ?? null}
          onClose={() => setShowCamera(false)}
          onToggleGarage={() => { /* MyQ integration TBD */ }}
        />
      )}
    </div>
  );
}
