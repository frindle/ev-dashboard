import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface WallConnectorConfig {
  serial: string;   // S/N from sticker — resolved to deviceId at runtime
  deviceId: string; // UUID — legacy fallback if serial is empty
  side: 'LEFT' | 'RIGHT';
  vehicleName: string;
  // Optional: Gen 3 Wall Connectors expose an unauthenticated local HTTP API
  // (http://<ip>/api/1/vitals) with zero Tesla Fleet API quota cost. When
  // set, per-connector vitals are read directly from the device on the LAN
  // instead of Tesla's cloud live_status — added 2026-07-25 to cut Fleet
  // API usage after hitting 80% of the monthly quota with days left in the
  // billing cycle. Leave blank to keep using the cloud API for this side.
  localIp: string;
}

export interface AppConfig {
  display: {
    siteName: string;
    accentColor: string;
  };
  vehicles: {
    tesla: {
      vin: string;
      name: string;
      model: string;
      chargerSide: 'LEFT' | 'RIGHT';
    };
    rivian: {
      name: string;
      model: string;
      chargerSide: 'LEFT' | 'RIGHT';
      email: string;
      password: string;
    };
  };
  energySite: {
    id: string;
    wallConnectors: WallConnectorConfig[];
  };
  garage: {
    provider: string;
    email: string;
    password: string;
    deviceSerial: string;
  };
  camera: {
    streamUrl: string;
    type: 'mjpeg' | 'rtsp' | 'hls';
  };
  weather: {
    apiKey: string;
    location: string;
    lat: number | null;
    lon: number | null;
  };
  home: {
    lat: number | null;
    lon: number | null;
    radiusMeters: number; // how close counts as "home"
    arrivalWebhookUrl: string; // fired once when Rivian enters the radius while still driving — e.g. Home Assistant webhook for garage lights
  };
  solar: {
    enabled: boolean;     // master switch — UI hides until true AND (host OR siteId) is set
    host: string;         // inverter LAN IP, e.g. "10.0.5.50" — preferred, real-time
    port: number;         // Modbus/TCP port, SolarEdge default is 1502 (not 502)
    unitId: number;       // Modbus device ID; default 1 for single inverter
    pollIntervalSec: number; // how often to read live registers
    siteId: string;       // monitoring.solaredge.com site ID — fallback when Modbus isn't set up
    username: string;     // monitoring.solaredge.com portal login
    password: string;
  };
  nvr: {
    enabled: boolean; // master switch — off until the NVR is actually recording (see api-docs/Reolink)
    host: string;     // NVR/camera LAN IP or hostname
    username: string;
    password: string;
    channel: number;  // camera channel on the NVR, 0 for a single IP camera
  };
}

const DEFAULT_CONFIG: AppConfig = {
  display: {
    siteName: 'Halton Place',
    accentColor: '#34e0c4',
  },
  vehicles: {
    tesla: {
      vin: '5YJ3E1EA3PF609276',
      name: 'Tesla',
      model: 'Model 3',
      chargerSide: 'RIGHT',
    },
    rivian: {
      name: 'Midknight',
      model: 'Rivian R1S',
      chargerSide: 'LEFT',
      email: '',
      password: '',
    },
  },
  energySite: {
    id: '2252299088632281',
    wallConnectors: [
      { serial: 'B7S23088J08030', deviceId: '9ded5c3b-f4ca-4061-b400-9e1591268156', side: 'LEFT', vehicleName: 'Midknight', localIp: '' },
      { serial: 'E4A23172000137', deviceId: 'e4a053b8-66cd-457e-b2bc-bc41005fb45f', side: 'RIGHT', vehicleName: 'Tesla', localIp: '' },
    ],
  },
  garage: {
    provider: 'myq',
    email: '',
    password: '',
    deviceSerial: '',
  },
  camera: {
    streamUrl: '',
    type: 'mjpeg',
  },
  weather: {
    apiKey: '',
    location: 'Halton Place',
    lat: null,
    lon: null,
  },
  home: {
    lat: null,
    lon: null,
    radiusMeters: 150,
    arrivalWebhookUrl: '',
  },
  solar: {
    enabled: false,
    host: '',
    port: 1502,
    unitId: 1,
    pollIntervalSec: 10,
    siteId: '',
    username: '',
    password: '',
  },
  nvr: {
    enabled: false,
    host: '',
    username: '',
    password: '',
    channel: 0,
  },
};

function configPath(): string {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  return join(dir, 'config.json');
}

export function readConfig(): AppConfig {
  const path = configPath();
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AppConfig>;
    const merged = deepMerge(DEFAULT_CONFIG, raw) as AppConfig;
    // deepMerge replaces arrays wholesale, so new fields on WC objects (like
    // serial) don't get seeded from defaults. Back-fill by matching on deviceId.
    merged.energySite.wallConnectors = merged.energySite.wallConnectors.map(wc => {
      const withSerial = wc.serial ? wc : (() => {
        const def = DEFAULT_CONFIG.energySite.wallConnectors.find(d => d.deviceId === wc.deviceId);
        return def?.serial ? { ...wc, serial: def.serial } : wc;
      })();
      // localIp is new (2026-07-25) — old saved configs won't have the key
      // at all, default it to '' rather than leaving it undefined.
      return { ...withSerial, localIp: withSerial.localIp ?? '' };
    });
    return merged;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeConfig(cfg: AppConfig): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (source === null || source === undefined) return target;
  if (typeof target !== 'object' || typeof source !== 'object') return source;
  if (Array.isArray(source)) return source;
  const out = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(source as Record<string, unknown>)) {
    out[key] = deepMerge(
      (target as Record<string, unknown>)[key],
      (source as Record<string, unknown>)[key],
    );
  }
  return out;
}

export interface TeslaTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
  issued_at?: number; // unix seconds — we add this when saving
}

export function readTokens(): TeslaTokens | null {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, 'tokens.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TeslaTokens;
  } catch {
    return null;
  }
}

export function writeTokens(tokens: TeslaTokens): void {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const path = join(dir, 'tokens.json');
  writeFileSync(path, JSON.stringify({ ...tokens, issued_at: Math.floor(Date.now() / 1000) }, null, 2));
}
