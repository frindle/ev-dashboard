'use client';

import { useEffect, useRef, useState } from 'react';
import type { AppConfig } from '@/lib/config';

const TESLA_CLIENT_ID = 'b4a07679-8597-452d-a7c0-8a6a6b632c42';
const TESLA_AUTH_BASE = 'https://auth.tesla.com/oauth2/v3/authorize';
const TESLA_SCOPES = 'openid vehicle_device_data vehicle_location vehicle_cmds energy_device_data offline_access';

function teslaAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: TESLA_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: TESLA_SCOPES,
    state: 'dashboard',
    // Force Tesla to re-show the consent screen on every re-auth, so new
    // scopes added to TESLA_SCOPES actually get granted instead of being
    // silently dropped when an existing session is reused.
    prompt: 'login consent',
  });
  return `${TESLA_AUTH_BASE}?${params}`;
}

// ── Rivian auth state ─────────────────────────────────────────────────────────
type RivianAuthStep = 'idle' | 'loading' | 'otp_required' | 'done' | 'error';

interface RivianOtpState {
  otpToken: string;
  csrfToken: string;
  appSessionToken: string;
}

export default function AdminPage() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [teslaConnected, setTeslaConnected] = useState(false);
  const [rivianConnected, setRivianConnected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [wcDiscovered, setWcDiscovered] = useState<Array<{ serial: string; deviceId: string }>>([]);
  const [wcLoading, setWcLoading] = useState(false);
  const [wcError, setWcError] = useState('');

  // Rivian auth flow state
  const [rivianEmail, setRivianEmail] = useState('');
  const [rivianPassword, setRivianPassword] = useState('');
  const [rivianOtpCode, setRivianOtpCode] = useState('');
  const [rivianOtpState, setRivianOtpState] = useState<RivianOtpState | null>(null);
  const [rivianStep, setRivianStep] = useState<RivianAuthStep>('idle');
  const [rivianLoading, setRivianLoading] = useState(false);
  const [rivianError, setRivianError] = useState('');
  const rivianOtpRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (rivianStep === 'otp_required') rivianOtpRef.current?.focus(); }, [rivianStep]);
  const [rivianVehicleId, setRivianVehicleId] = useState<string | null>(null);
  const [rivianResolving, setRivianResolving] = useState(false);
  const [rivianResolveMsg, setRivianResolveMsg] = useState('');
  const [rivianHasSavedPassword, setRivianHasSavedPassword] = useState(false);
  const [rivianPendingSave, setRivianPendingSave] = useState(false);
  const [hasStoredNvrPassword, setHasStoredNvrPassword] = useState(false);

  // globals.css sets overflow:hidden + height:100% on html/body for the dashboard
  // clear both so the admin page can scroll normally
  useEffect(() => {
    document.documentElement.style.overflow = 'auto';
    document.documentElement.style.height = 'auto';
    document.body.style.overflow = 'auto';
    document.body.style.height = 'auto';
    return () => {
      document.documentElement.style.overflow = '';
      document.documentElement.style.height = '';
      document.body.style.overflow = '';
      document.body.style.height = '';
    };
  }, []);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then((d: { config: AppConfig; teslaConnected: boolean; rivianConnected: boolean; hasStoredRivianPassword: boolean; hasStoredNvrPassword: boolean }) => {
        setConfig(d.config);
        setTeslaConnected(d.teslaConnected);
        setRivianConnected(d.rivianConnected);
        setRivianEmail(d.config.vehicles.rivian.email);
        setRivianHasSavedPassword(d.hasStoredRivianPassword);
        setHasStoredNvrPassword(d.hasStoredNvrPassword);
        if (d.teslaConnected) fetchWallConnectors();
      });
    fetch('/api/rivian/auth')
      .then(r => r.json())
      .then((d: { vehicleId: string | null }) => setRivianVehicleId(d.vehicleId));
  }, []);

  async function retryVehicleLookup() {
    setRivianResolving(true);
    setRivianResolveMsg('');
    try {
      const res = await fetch('/api/rivian/resolve-vehicle', { method: 'POST' });
      const data = await res.json() as { ok: boolean; vehicleId: string; error?: string };
      if (!res.ok || data.error) {
        setRivianResolveMsg(data.error ?? 'Lookup failed');
      } else if (data.ok) {
        setRivianVehicleId(data.vehicleId);
        setRivianResolveMsg('✓ Vehicle ID resolved');
      } else {
        setRivianResolveMsg('Still no vehicle found — check the container logs, or reconnect.');
      }
    } catch (e) {
      setRivianResolveMsg(String(e));
    } finally {
      setRivianResolving(false);
    }
  }

  function update<K extends keyof AppConfig>(section: K, patch: Partial<AppConfig[K]>) {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, [section]: { ...(prev[section] as object), ...patch } } as AppConfig;
    });
  }

  async function fetchWallConnectors() {
    setWcLoading(true);
    setWcError('');
    try {
      const res = await fetch('/api/tesla/wall-connectors');
      const body = await res.json() as Array<{ serial: string; deviceId: string }> | { error: string };
      if (!res.ok || 'error' in body) {
        setWcError(('error' in body ? body.error : null) ?? `HTTP ${res.status}`);
        return;
      }
      setWcDiscovered(body as Array<{ serial: string; deviceId: string }>);
    } catch (e) {
      setWcError(String(e));
    } finally {
      setWcLoading(false);
    }
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  }

  async function connectRivian() {
    if (!rivianEmail || !rivianPassword) return;
    setRivianPendingSave(true);
    await doRivianLogin(fetch('/api/rivian/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: rivianEmail, password: rivianPassword }),
    }));
  }

  // One-click reconnect using the email/password saved from a prior login —
  // still requires the OTP code (can't be automated, it's time-limited).
  async function reconnectSaved() {
    setRivianPendingSave(false);
    await doRivianLogin(fetch('/api/rivian/auth/reconnect', { method: 'POST' }));
  }

  async function doRivianLogin(reqPromise: Promise<Response>) {
    setRivianStep('idle');
    setRivianLoading(true);
    setRivianError('');
    try {
      const res = await reqPromise;
      const data = await res.json() as {
        type?: string;
        otpToken?: string;
        csrfToken?: string;
        appSessionToken?: string;
        error?: string;
      };
      if (!res.ok || data.error) {
        setRivianStep('error');
        setRivianError(data.error ?? 'Login failed');
        return;
      }
      if (data.type === 'otp_required') {
        setRivianOtpState({
          otpToken: data.otpToken!,
          csrfToken: data.csrfToken!,
          appSessionToken: data.appSessionToken!,
        });
        setRivianStep('otp_required');
      } else {
        setRivianStep('done');
        setRivianConnected(true);
        if (rivianPendingSave) await saveRivianCredentials(rivianEmail, rivianPassword);
        setRivianHasSavedPassword(true);
        fetch('/api/rivian/auth').then(r => r.json()).then((d: { vehicleId: string | null }) => setRivianVehicleId(d.vehicleId));
      }
    } catch (e) {
      setRivianStep('error');
      setRivianError(String(e));
    } finally {
      setRivianLoading(false);
    }
  }

  // Persists email+password immediately on a successful login, rather than
  // waiting on the user to hit the page's general Save button — otherwise
  // "store credentials for reconnect" silently doesn't happen if they never
  // save afterward. Fetches the current config fresh instead of trusting
  // React state, since GET /api/config redacts passwords to '' and we don't
  // want to round-trip that blank back over a stale `config` closure.
  async function saveRivianCredentials(email: string, password: string) {
    const current = await fetch('/api/config').then(r => r.json()) as { config: AppConfig };
    const next: AppConfig = {
      ...current.config,
      vehicles: { ...current.config.vehicles, rivian: { ...current.config.vehicles.rivian, email, password } },
    };
    await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
    });
    setRivianPassword('');
    update('vehicles', { rivian: { ...config!.vehicles.rivian, email } });
  }

  async function submitOtp() {
    if (!rivianOtpState || !rivianOtpCode) return;
    setRivianLoading(true);
    setRivianError('');
    try {
      const res = await fetch('/api/rivian/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: rivianEmail,
          otpCode: rivianOtpCode,
          ...rivianOtpState,
        }),
      });
      const data = await res.json() as { type?: string; error?: string };
      if (!res.ok || data.error) {
        setRivianStep('error');
        setRivianError(data.error ?? 'OTP failed');
        return;
      }
      setRivianStep('done');
      setRivianConnected(true);
      setRivianOtpCode('');
      if (rivianPendingSave) await saveRivianCredentials(rivianEmail, rivianPassword);
      else setRivianPassword('');
      setRivianHasSavedPassword(true);
      fetch('/api/rivian/auth').then(r => r.json()).then((d: { vehicleId: string | null }) => setRivianVehicleId(d.vehicleId));
    } catch (e) {
      setRivianStep('error');
      setRivianError(String(e));
    } finally {
      setRivianLoading(false);
    }
  }

  if (!config) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <span style={{ color: '#6b8599', fontFamily: 'JetBrains Mono, monospace' }}>Loading…</span>
      </div>
    );
  }

  const redirectUri = 'https://ev-dashboard.penndalton.com/auth/callback';

  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <div className="admin-title">Data Connections</div>
          <div className="admin-subtitle">Configure API credentials and integrations for the EV dashboard.</div>
        </div>
        <a href="/" className="btn-secondary">
          <span className="icon" style={{ fontSize: 16 }}>arrow_back</span>
          Dashboard
        </a>
      </div>

      {/* ── Display ── */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div className="admin-section-title">
            <span className="icon" style={{ fontSize: 18 }}>display_settings</span>
            Display
          </div>
        </div>
        <div className="admin-section-body">
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">Site Name</label>
              <input
                className="form-input"
                value={config.display.siteName}
                onChange={e => update('display', { siteName: e.target.value })}
                placeholder="Halton Place"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Accent Color</label>
              <div className="color-row">
                <input
                  type="color"
                  className="color-input"
                  value={config.display.accentColor}
                  onChange={e => update('display', { accentColor: e.target.value })}
                />
                <input
                  className="form-input"
                  value={config.display.accentColor}
                  onChange={e => update('display', { accentColor: e.target.value })}
                  placeholder="#34e0c4"
                  style={{ flex: 1 }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Tesla ── */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div className="admin-section-title">
            <div className={`status-dot ${teslaConnected ? 'connected' : 'disconnected'}`} />
            Tesla Fleet API
          </div>
        </div>
        <div className="admin-section-body">
          <div className="tesla-auth-row">
            <div className={`tesla-auth-status${teslaConnected ? ' ok' : ''}`}>
              {teslaConnected
                ? '✓ Tokens saved — Tesla is connected'
                : 'Not authenticated. Click to authorize via Tesla.'}
            </div>
            <a
              href={teslaAuthUrl(redirectUri)}
              className="btn-primary"
              style={{ textDecoration: 'none' }}
            >
              <span className="icon" style={{ fontSize: 16 }}>open_in_new</span>
              {teslaConnected ? 'Re-authorize' : 'Connect Tesla'}
            </a>
          </div>
          <div className="form-hint">
            After clicking, log in to Tesla and approve access. You&apos;ll be redirected back and tokens will be saved automatically.
          </div>

          <div className="form-row-2" style={{ marginTop: 8 }}>
            <div className="form-row">
              <label className="form-label">Vehicle VIN</label>
              <input
                className="form-input"
                value={config.vehicles.tesla.vin}
                onChange={e => update('vehicles', { tesla: { ...config.vehicles.tesla, vin: e.target.value } })}
                placeholder="5YJ3E1EA3PF609276"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Energy Site ID</label>
              <input
                className="form-input"
                value={config.energySite.id}
                onChange={e => update('energySite', { ...config.energySite, id: e.target.value })}
                placeholder="2252299088632281"
              />
            </div>
          </div>

          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">Vehicle Display Name</label>
              <input
                className="form-input"
                value={config.vehicles.tesla.name}
                onChange={e => update('vehicles', { tesla: { ...config.vehicles.tesla, name: e.target.value } })}
                placeholder="Tesla"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Wall Connector Side</label>
              <select
                className="form-select"
                value={config.vehicles.tesla.chargerSide}
                onChange={e => update('vehicles', { tesla: { ...config.vehicles.tesla, chargerSide: e.target.value as 'LEFT' | 'RIGHT' } })}
              >
                <option value="LEFT">LEFT</option>
                <option value="RIGHT">RIGHT</option>
              </select>
            </div>
          </div>

          <div className="form-row">
            <label className="form-label">Wall Connector Assignment</label>
            <div className="form-row-2">
              {(['LEFT', 'RIGHT'] as const).map(side => {
                const current = config.energySite.wallConnectors.find(w => w.side === side);
                return (
                  <div key={side} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <span className="form-hint">{side} connector</span>
                    <select
                      className="form-select"
                      value={current?.deviceId ?? ''}
                      onChange={e => {
                        const chosen = wcDiscovered.find(w => w.deviceId === e.target.value);
                        const wcs = config.energySite.wallConnectors.map(w =>
                          w.side === side
                            ? { ...w, deviceId: chosen?.deviceId ?? e.target.value, serial: chosen?.serial ?? '' }
                            : w
                        );
                        update('energySite', { ...config.energySite, wallConnectors: wcs });
                      }}
                    >
                      <option value="">— select —</option>
                      {wcDiscovered.map(wc => (
                        <option key={wc.deviceId} value={wc.deviceId}>
                          {wc.serial || wc.deviceId}
                        </option>
                      ))}
                      {/* Keep current value selectable even if not in discovered list */}
                      {current?.deviceId && !wcDiscovered.find(w => w.deviceId === current.deviceId) && (
                        <option value={current.deviceId}>
                          {current.serial || current.deviceId}
                        </option>
                      )}
                    </select>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="form-hint">
                {wcLoading ? 'Fetching from Tesla…'
                  : wcError ? `Error: ${wcError}`
                  : wcDiscovered.length > 0 ? `${wcDiscovered.length} wall connector${wcDiscovered.length !== 1 ? 's' : ''} discovered from Tesla API.`
                  : teslaConnected ? 'No wall connectors found — check energy site ID.'
                  : 'Connect Tesla to discover wall connectors.'}
              </span>
              {teslaConnected && (
                <button className="btn-secondary" onClick={fetchWallConnectors} disabled={wcLoading}
                  style={{ padding: '3px 10px', fontSize: 11, flex: 'none' }}>
                  <span className="icon" style={{ fontSize: 13 }}>{wcLoading ? 'sync' : 'refresh'}</span>
                  Refresh
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Rivian ── */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div className="admin-section-title">
            <div className={`status-dot ${rivianConnected ? 'connected' : rivianStep === 'error' ? 'disconnected' : 'disconnected'}`} />
            Rivian
          </div>
          {rivianConnected && (
            <span style={{ fontSize: 12, color: '#34e07a' }}>✓ Connected</span>
          )}
        </div>
        <div className="admin-section-body">
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">Display Name</label>
              <input
                className="form-input"
                value={config.vehicles.rivian.name}
                onChange={e => update('vehicles', { rivian: { ...config.vehicles.rivian, name: e.target.value } })}
                placeholder="Midknight"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Wall Connector Side</label>
              <select
                className="form-select"
                value={config.vehicles.rivian.chargerSide}
                onChange={e => update('vehicles', { rivian: { ...config.vehicles.rivian, chargerSide: e.target.value as 'LEFT' | 'RIGHT' } })}
              >
                <option value="LEFT">LEFT</option>
                <option value="RIGHT">RIGHT</option>
              </select>
            </div>
          </div>

          {rivianStep !== 'otp_required' ? (
            <>
              <div className="form-row-2">
                <div className="form-row">
                  <label className="form-label">Rivian Email</label>
                  <input
                    className="form-input"
                    type="email"
                    value={rivianEmail}
                    onChange={e => setRivianEmail(e.target.value)}
                    placeholder="you@example.com"
                    disabled={rivianLoading}
                  />
                </div>
                <div className="form-row">
                  <label className="form-label">Rivian Password</label>
                  <input
                    className="form-input"
                    type="password"
                    value={rivianPassword}
                    onChange={e => setRivianPassword(e.target.value)}
                    placeholder="••••••••"
                    disabled={rivianLoading}
                    onKeyDown={e => e.key === 'Enter' && connectRivian()}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  className="btn-primary"
                  onClick={connectRivian}
                  disabled={rivianLoading || !rivianEmail || !rivianPassword}
                >
                  <span className="icon" style={{ fontSize: 16 }}>
                    {rivianLoading ? 'sync' : 'login'}
                  </span>
                  {rivianLoading ? 'Connecting…' : rivianConnected ? 'Re-connect Rivian' : 'Connect Rivian'}
                </button>
                {rivianHasSavedPassword && (
                  <button className="btn-secondary" onClick={reconnectSaved} disabled={rivianLoading}>
                    <span className="icon" style={{ fontSize: 16 }}>bolt</span>
                    Reconnect (saved credentials)
                  </button>
                )}
                {rivianError && (
                  <span style={{ fontSize: 12, color: '#e05555' }}>{rivianError}</span>
                )}
                {rivianStep === 'done' && (
                  <span style={{ fontSize: 12, color: '#34e07a' }}>✓ Connected successfully</span>
                )}
              </div>

              {rivianConnected && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  <span style={{ fontSize: 12, color: rivianVehicleId ? '#7d8893' : '#e0a555' }}>
                    Vehicle ID: {rivianVehicleId || 'not resolved — polling will not work'}
                  </span>
                  <button className="btn-secondary" onClick={retryVehicleLookup} disabled={rivianResolving}>
                    {rivianResolving ? 'Checking…' : 'Retry vehicle lookup'}
                  </button>
                  {rivianResolveMsg && <span style={{ fontSize: 12, color: '#a4afba' }}>{rivianResolveMsg}</span>}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: 13, color: '#6b8599', marginBottom: 4 }}>
                Rivian sent a verification code to <strong style={{ color: '#e8edf0' }}>{rivianEmail}</strong>. Enter it below.
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                <div className="form-row" style={{ flex: 1 }}>
                  <label className="form-label">Verification Code</label>
                  <input
                    ref={rivianOtpRef}
                    className="form-input"
                    value={rivianOtpCode}
                    onChange={e => setRivianOtpCode(e.target.value)}
                    placeholder="123456"
                    maxLength={8}
                    onKeyDown={e => e.key === 'Enter' && submitOtp()}
                    disabled={rivianLoading}
                  />
                </div>
                <button
                  className="btn-primary"
                  onClick={submitOtp}
                  disabled={rivianLoading || !rivianOtpCode}
                  style={{ marginBottom: 0 }}
                >
                  <span className="icon" style={{ fontSize: 16 }}>verified</span>
                  {rivianLoading ? 'Verifying…' : 'Verify'}
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => { setRivianStep('idle'); setRivianOtpState(null); setRivianOtpCode(''); }}
                >
                  Cancel
                </button>
              </div>
              {rivianError && (
                <span style={{ fontSize: 12, color: '#e05555' }}>{rivianError}</span>
              )}
            </>
          )}
          <div className="form-hint">
            Uses the Rivian app API (unofficial). Tokens are stored locally in the keys/ volume — passwords are not saved.
          </div>
        </div>
      </div>

      {/* ── Garage Door (planned: ratgdo) ── */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div className="admin-section-title">
            <div className="status-dot disconnected" />
            Garage Door
          </div>
          <span style={{ fontSize: 12, color: '#a4afba' }}>Planned: ratgdo</span>
        </div>
        <div className="admin-section-body">
          <div className="form-hint">
            MyQ integration was removed — Chamberlain now blocks third-party API access (401.122).
            Future support: <strong>ratgdo</strong> (local WiFi board, ~$30) for direct control.
            Until installed, the dashboard hides the garage button.
          </div>
        </div>
      </div>

      {/* ── Camera ── */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div className="admin-section-title">
            <div className={`status-dot ${config.camera.streamUrl ? 'connected' : 'disconnected'}`} />
            Garage Camera
          </div>
        </div>
        <div className="admin-section-body">
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">Stream Type</label>
              <select
                className="form-select"
                value={config.camera.type}
                onChange={e => update('camera', { type: e.target.value as 'mjpeg' | 'rtsp' | 'hls' })}
              >
                <option value="mjpeg">MJPEG (HTTP)</option>
                <option value="hls">HLS (m3u8)</option>
                <option value="rtsp">RTSP (requires proxy)</option>
              </select>
            </div>
            <div className="form-row">
              <label className="form-label">Stream URL</label>
              <input
                className="form-input"
                value={config.camera.streamUrl}
                onChange={e => update('camera', { streamUrl: e.target.value })}
                placeholder="http://192.168.1.x/stream"
              />
            </div>
          </div>
          <div className="form-hint">
            For RTSP streams, use a proxy like go2rtc or frigate to convert to MJPEG/HLS for browser playback.
          </div>
        </div>
      </div>

      {/* ── Weather ── */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div className="admin-section-title">
            <div className={`status-dot ${config.weather.apiKey ? 'connected' : 'disconnected'}`} />
            Weather
          </div>
        </div>
        <div className="admin-section-body">
          <div className="form-row">
            <label className="form-label">OpenWeatherMap API Key</label>
            <input
              className="form-input"
              value={config.weather.apiKey}
              onChange={e => update('weather', { apiKey: e.target.value })}
              placeholder="Get a free key at openweathermap.org"
            />
          </div>
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">Location Name</label>
              <input
                className="form-input"
                value={config.weather.location}
                onChange={e => update('weather', { location: e.target.value })}
                placeholder="Halton Place"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Coordinates (optional)</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="form-input"
                  type="number"
                  step="0.0001"
                  value={config.weather.lat ?? ''}
                  onChange={e => update('weather', { lat: e.target.value ? parseFloat(e.target.value) : null })}
                  placeholder="lat"
                />
                <input
                  className="form-input"
                  type="number"
                  step="0.0001"
                  value={config.weather.lon ?? ''}
                  onChange={e => update('weather', { lon: e.target.value ? parseFloat(e.target.value) : null })}
                  placeholder="lon"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Home Location ── */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div className="admin-section-title">
            <div className={`status-dot ${config.home.lat !== null && config.home.lon !== null ? 'connected' : 'disconnected'}`} />
            Home Location
          </div>
        </div>
        <div className="admin-section-body">
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">Latitude</label>
              <input
                className="form-input"
                type="number"
                step="0.000001"
                value={config.home.lat ?? ''}
                onChange={e => update('home', { lat: e.target.value ? parseFloat(e.target.value) : null })}
                placeholder="e.g. 33.123456"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Longitude</label>
              <input
                className="form-input"
                type="number"
                step="0.000001"
                value={config.home.lon ?? ''}
                onChange={e => update('home', { lon: e.target.value ? parseFloat(e.target.value) : null })}
                placeholder="e.g. -84.123456"
              />
            </div>
          </div>
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">Home Radius (meters)</label>
              <input
                className="form-input"
                type="number"
                step="10"
                min="25"
                value={config.home.radiusMeters}
                onChange={e => update('home', { radiusMeters: e.target.value ? parseInt(e.target.value, 10) : 150 })}
              />
            </div>
            <div className="form-row" style={{ justifyContent: 'flex-end' }}>
              <label className="form-label">&nbsp;</label>
              <button
                className="btn-secondary"
                onClick={() => {
                  if (!navigator.geolocation) { alert('Geolocation not supported by this browser'); return; }
                  navigator.geolocation.getCurrentPosition(
                    pos => update('home', { lat: pos.coords.latitude, lon: pos.coords.longitude }),
                    err => alert(`Could not get location: ${err.message}`),
                    { enableHighAccuracy: true, timeout: 10000 },
                  );
                }}
              >
                <span className="icon" style={{ fontSize: 16 }}>my_location</span>
                Use current location
              </button>
            </div>
          </div>
          <div className="form-hint">
            Used to detect whether a vehicle is home. A vehicle within the radius counts as &quot;home&quot;.
            150m covers most driveways/garages. If unset, the dashboard falls back to using each vehicle&apos;s online status.
          </div>
          <div className="form-row">
            <label className="form-label">Arrival webhook URL (Rivian only)</label>
            <input
              className="form-input"
              type="text"
              value={config.home.arrivalWebhookUrl}
              onChange={e => update('home', { arrivalWebhookUrl: e.target.value.trim() })}
              placeholder="http://homeassistant.local:8123/api/webhook/..."
            />
            <div className="form-hint">
              Fired once when the Rivian enters the home radius while still driving (not waiting for
              &quot;parked&quot;, to avoid lagging behind actual arrival). Leave blank to disable.
            </div>
          </div>
        </div>
      </div>

      {/* ── SolarEdge ── */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div className="admin-section-title">
            <div className={`status-dot ${config.solar.enabled && config.solar.host ? 'connected' : 'disconnected'}`} />
            SolarEdge Inverter
          </div>
        </div>
        <div className="admin-section-body">
          <div className="form-row">
            <label className="form-label">
              <input
                type="checkbox"
                checked={config.solar.enabled}
                onChange={e => update('solar', { enabled: e.target.checked })}
                style={{ marginRight: 8 }}
              />
              Enable SolarEdge polling
            </label>
            <div className="form-hint">
              Off by default. The dashboard ignores SolarEdge entirely until this is on AND the Inverter IP is set below.
            </div>
          </div>
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">Inverter IP</label>
              <input
                className="form-input"
                type="text"
                value={config.solar.host}
                onChange={e => update('solar', { host: e.target.value.trim() })}
                placeholder="10.0.5.50"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Modbus Port</label>
              <input
                className="form-input"
                type="number"
                value={config.solar.port}
                onChange={e => update('solar', { port: e.target.value ? parseInt(e.target.value, 10) : 1502 })}
              />
            </div>
          </div>
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">Device ID</label>
              <input
                className="form-input"
                type="number"
                value={config.solar.unitId}
                onChange={e => update('solar', { unitId: e.target.value ? parseInt(e.target.value, 10) : 1 })}
              />
            </div>
            <div className="form-row">
              <label className="form-label">Poll Interval (sec)</label>
              <input
                className="form-input"
                type="number"
                min="5"
                value={config.solar.pollIntervalSec}
                onChange={e => update('solar', { pollIntervalSec: e.target.value ? parseInt(e.target.value, 10) : 10 })}
              />
            </div>
          </div>
          <div className="form-hint">
            SolarEdge uses port 1502 (not the Modbus standard 502). Device ID 1 is correct for a single inverter.
            Only one Modbus/TCP client may connect at a time — disable Home Assistant&apos;s SolarEdge integration if you have one.
            After enabling Modbus on the inverter, the first poll must arrive within ~2 minutes or the port closes.
          </div>
        </div>
      </div>

      {/* ── NVR / Recorded Clips ──
          Off by default — no recording pipeline set up yet. Backend (lib/reolink.ts,
          /api/nvr/clips) is built and ready; flip this on once the NVR is actually
          capturing, then wire a clip-history UI into CameraModal. */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div className="admin-section-title">
            <div className={`status-dot ${config.nvr.enabled && config.nvr.host ? 'connected' : 'disconnected'}`} />
            NVR / Recorded Clips
          </div>
        </div>
        <div className="admin-section-body">
          <div className="form-row">
            <label className="form-label">
              <input
                type="checkbox"
                checked={config.nvr.enabled}
                onChange={e => update('nvr', { enabled: e.target.checked })}
                style={{ marginRight: 8 }}
              />
              Enable NVR clip history
            </label>
            <div className="form-hint">
              Off by default. Requires a Reolink camera/NVR actually recording — nothing to browse until then.
            </div>
          </div>
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">NVR / Camera IP</label>
              <input
                className="form-input"
                type="text"
                value={config.nvr.host}
                onChange={e => update('nvr', { host: e.target.value.trim() })}
                placeholder="10.0.6.180"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Channel</label>
              <input
                className="form-input"
                type="number"
                min="0"
                value={config.nvr.channel}
                onChange={e => update('nvr', { channel: e.target.value ? parseInt(e.target.value, 10) : 0 })}
              />
            </div>
          </div>
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">Username</label>
              <input
                className="form-input"
                type="text"
                value={config.nvr.username}
                onChange={e => update('nvr', { username: e.target.value })}
                placeholder="admin"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Password</label>
              <input
                className="form-input"
                type="password"
                value={config.nvr.password}
                onChange={e => update('nvr', { password: e.target.value })}
                placeholder={hasStoredNvrPassword ? '•••••••• (saved — leave blank to keep)' : '••••••••'}
              />
            </div>
          </div>
          <div className="form-hint">
            Channel is 0 for a single IP camera, or the NVR channel number for a multi-camera NVR.
          </div>
        </div>
      </div>

      {/* ── Charge History ── */}
      <ChargeStatsSection />

      {/* Save bar */}
      <div className="save-bar">
        {saved && (
          <div className="save-success">
            <span className="icon" style={{ fontSize: 16 }}>check_circle</span>
            Saved
          </div>
        )}
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

// ── Charge history stats ────────────────────────────────────────────────
// Reads the aggregations over charge-history.jsonl. The $/kWh rate is a
// local preference (localStorage), not part of server config.

interface ChargeStatsMonth { month: string; sessions: number; kwh: number; costUsd?: number }
interface ChargeStatsVehicle {
  vehicleName: string; side: string; totalSessions: number; totalKwh: number;
  totalCostUsd?: number; avgSessionKwh: number; months: ChargeStatsMonth[];
}
interface ChargeStatsSession {
  side: string; vehicleName: string; startedAt: string; endedAt: string;
  durationMin: number; energyKwh: number; costUsd?: number;
}
interface ChargeStats {
  ok: boolean; months: number; ratePerKwh: number | null;
  vehicles: ChargeStatsVehicle[]; recentSessions: ChargeStatsSession[];
}

function ChargeStatsSection() {
  const [stats, setStats] = useState<ChargeStats | null>(null);
  const [rate, setRate] = useState(() => {
    try { return localStorage.getItem('admin_kwh_rate') ?? ''; } catch { return ''; }
  });
  const [months, setMonths] = useState(6);

  useEffect(() => {
    const params = new URLSearchParams({ months: String(months) });
    if (rate && !isNaN(Number(rate))) params.set('rate', rate);
    fetch(`/api/admin/charge-stats?${params}`)
      .then(r => r.json())
      .then(setStats)
      .catch(() => setStats(null));
    try { localStorage.setItem('admin_kwh_rate', rate); } catch { /* private mode */ }
  }, [rate, months]);

  const fmtDate = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div className="admin-section-title">
          <span className="icon" style={{ fontSize: 18 }}>battery_charging_full</span>
          Charge History
        </div>
      </div>
      <div className="admin-section-body">
        <div className="form-row-2">
          <div className="form-row">
            <label className="form-label">Electricity Rate ($/kWh)</label>
            <input
              className="form-input"
              type="text"
              inputMode="decimal"
              value={rate}
              onChange={e => setRate(e.target.value)}
              placeholder="0.142 — leave blank to hide cost"
            />
          </div>
          <div className="form-row">
            <label className="form-label">Window (months)</label>
            <input
              className="form-input"
              type="number"
              min={1}
              max={36}
              value={months}
              onChange={e => setMonths(Math.max(1, Math.min(36, parseInt(e.target.value, 10) || 6)))}
            />
          </div>
        </div>

        {!stats || stats.vehicles.length === 0 ? (
          <div className="form-hint">
            No completed charge sessions recorded yet. Sessions are logged automatically
            when a wall connector goes active → idle (charge-history.jsonl).
          </div>
        ) : (
          <>
            {stats.vehicles.map(v => (
              <div key={`${v.side}-${v.vehicleName}`} style={{ marginBottom: 16 }}>
                <div className="form-label" style={{ marginBottom: 6 }}>
                  {v.vehicleName} ({v.side}) — {v.totalSessions} sessions · {v.totalKwh} kWh
                  {v.totalCostUsd != null ? ` · ~$${v.totalCostUsd.toFixed(2)}` : ''}
                  {` · avg ${v.avgSessionKwh} kWh/session`}
                </div>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', opacity: 0.6 }}>
                      <th style={{ padding: '2px 8px 2px 0' }}>Month</th>
                      <th style={{ padding: '2px 8px' }}>Sessions</th>
                      <th style={{ padding: '2px 8px' }}>kWh</th>
                      {stats.ratePerKwh != null && <th style={{ padding: '2px 8px' }}>Est. Cost</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {v.months.map(m => (
                      <tr key={m.month}>
                        <td style={{ padding: '2px 8px 2px 0' }}>{m.month}</td>
                        <td style={{ padding: '2px 8px' }}>{m.sessions}</td>
                        <td style={{ padding: '2px 8px' }}>{m.kwh}</td>
                        {stats.ratePerKwh != null && <td style={{ padding: '2px 8px' }}>${(m.costUsd ?? 0).toFixed(2)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            <div className="form-label" style={{ marginBottom: 6 }}>Recent sessions</div>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.6 }}>
                  <th style={{ padding: '2px 8px 2px 0' }}>Started</th>
                  <th style={{ padding: '2px 8px' }}>Vehicle</th>
                  <th style={{ padding: '2px 8px' }}>Duration</th>
                  <th style={{ padding: '2px 8px' }}>kWh</th>
                  {stats.ratePerKwh != null && <th style={{ padding: '2px 8px' }}>Est. Cost</th>}
                </tr>
              </thead>
              <tbody>
                {stats.recentSessions.map((s, i) => (
                  <tr key={i}>
                    <td style={{ padding: '2px 8px 2px 0' }}>{fmtDate(s.startedAt)}</td>
                    <td style={{ padding: '2px 8px' }}>{s.vehicleName}</td>
                    <td style={{ padding: '2px 8px' }}>{s.durationMin} min</td>
                    <td style={{ padding: '2px 8px' }}>{s.energyKwh}</td>
                    {stats.ratePerKwh != null && <td style={{ padding: '2px 8px' }}>${(s.costUsd ?? 0).toFixed(2)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
