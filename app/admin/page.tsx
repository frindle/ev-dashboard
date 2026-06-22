'use client';

import { useEffect, useRef, useState } from 'react';
import type { AppConfig } from '@/lib/config';

const TESLA_CLIENT_ID = 'b4a07679-8597-452d-a7c0-8a6a6b632c42';
const TESLA_AUTH_BASE = 'https://auth.tesla.com/oauth2/v3/authorize';
const TESLA_SCOPES = 'openid vehicle_device_data energy_device_data offline_access';

function teslaAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: TESLA_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: TESLA_SCOPES,
    state: 'dashboard',
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
      .then((d: { config: AppConfig; teslaConnected: boolean; rivianConnected: boolean }) => {
        setConfig(d.config);
        setTeslaConnected(d.teslaConnected);
        setRivianConnected(d.rivianConnected);
        setRivianEmail(d.config.vehicles.rivian.email);
        if (d.teslaConnected) fetchWallConnectors();
      });
  }, []);

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
    setRivianStep('idle');
    setRivianLoading(true);
    setRivianError('');
    try {
      const res = await fetch('/api/rivian/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: rivianEmail, password: rivianPassword }),
      });
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
        setRivianPassword('');
        update('vehicles', { rivian: { ...config!.vehicles.rivian, email: rivianEmail } });
      }
    } catch (e) {
      setRivianStep('error');
      setRivianError(String(e));
    } finally {
      setRivianLoading(false);
    }
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
      setRivianPassword('');
      setRivianOtpCode('');
      update('vehicles', { rivian: { ...config!.vehicles.rivian, email: rivianEmail } });
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
                {rivianError && (
                  <span style={{ fontSize: 12, color: '#e05555' }}>{rivianError}</span>
                )}
                {rivianStep === 'done' && (
                  <span style={{ fontSize: 12, color: '#34e07a' }}>✓ Connected successfully</span>
                )}
              </div>
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
