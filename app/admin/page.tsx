'use client';

import { useEffect, useState } from 'react';
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

export default function AdminPage() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [teslaConnected, setTeslaConnected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then((d: { config: AppConfig; teslaConnected: boolean }) => {
        setConfig(d.config);
        setTeslaConnected(d.teslaConnected);
      });
  }, []);

  function update<K extends keyof AppConfig>(section: K, patch: Partial<AppConfig[K]>) {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, [section]: { ...(prev[section] as object), ...patch } } as AppConfig;
    });
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

  if (!config) {
    return (
      <div className="admin-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <span style={{ color: '#6b8599', fontFamily: 'JetBrains Mono, monospace' }}>Loading…</span>
      </div>
    );
  }

  const redirectUri = typeof window !== 'undefined'
    ? `${window.location.origin}/auth/callback`
    : 'https://penndalton.com/auth/callback/void';

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
            <div className="status-dot" style={{ background: teslaConnected ? undefined : undefined }} />
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
            <label className="form-label">Wall Connector Device IDs</label>
            <div className="form-row-2">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span className="form-hint">LEFT connector</span>
                <input
                  className="form-input"
                  value={config.energySite.wallConnectors.find(w => w.side === 'LEFT')?.deviceId ?? ''}
                  onChange={e => {
                    const wcs = config.energySite.wallConnectors.map(w =>
                      w.side === 'LEFT' ? { ...w, deviceId: e.target.value } : w
                    );
                    update('energySite', { ...config.energySite, wallConnectors: wcs });
                  }}
                  placeholder="9ded5c3b-..."
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span className="form-hint">RIGHT connector</span>
                <input
                  className="form-input"
                  value={config.energySite.wallConnectors.find(w => w.side === 'RIGHT')?.deviceId ?? ''}
                  onChange={e => {
                    const wcs = config.energySite.wallConnectors.map(w =>
                      w.side === 'RIGHT' ? { ...w, deviceId: e.target.value } : w
                    );
                    update('energySite', { ...config.energySite, wallConnectors: wcs });
                  }}
                  placeholder="e4a053b8-..."
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Rivian ── */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div className="admin-section-title">
            <div className={`status-dot ${config.vehicles.rivian.email ? 'partial' : 'disconnected'}`} />
            Rivian
          </div>
          <span style={{ fontSize: 11, color: '#3d5566' }}>Unofficial API — coming soon</span>
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
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">Rivian Email</label>
              <input
                className="form-input"
                type="email"
                value={config.vehicles.rivian.email}
                onChange={e => update('vehicles', { rivian: { ...config.vehicles.rivian, email: e.target.value } })}
                placeholder="you@example.com"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Rivian Password</label>
              <input
                className="form-input"
                type="password"
                value={config.vehicles.rivian.password}
                onChange={e => update('vehicles', { rivian: { ...config.vehicles.rivian, password: e.target.value } })}
                placeholder="••••••••"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── MyQ Garage ── */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div className="admin-section-title">
            <div className={`status-dot ${config.garage.email ? 'partial' : 'disconnected'}`} />
            MyQ Garage Door
          </div>
        </div>
        <div className="admin-section-body">
          <div className="form-row-2">
            <div className="form-row">
              <label className="form-label">MyQ Email</label>
              <input
                className="form-input"
                type="email"
                value={config.garage.email}
                onChange={e => update('garage', { email: e.target.value })}
                placeholder="you@example.com"
              />
            </div>
            <div className="form-row">
              <label className="form-label">MyQ Password</label>
              <input
                className="form-input"
                type="password"
                value={config.garage.password}
                onChange={e => update('garage', { password: e.target.value })}
                placeholder="••••••••"
              />
            </div>
          </div>
          <div className="form-row">
            <label className="form-label">Device Serial</label>
            <input
              className="form-input"
              value={config.garage.deviceSerial}
              onChange={e => update('garage', { deviceSerial: e.target.value })}
              placeholder="CG0DD..."
            />
            <span className="form-hint">Find in MyQ app → Device Info</span>
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
