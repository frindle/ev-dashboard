import { writeFile } from 'fs/promises';
import { join } from 'path';
import { readConfig, readTokens } from '@/lib/config';
import {
  fetchVehicleState,
  fetchSiteLiveStatus,
  fetchWallConnectorVitals,
  TeslaVehicleState,
  TeslaSiteState,
  WallConnectorVitals,
} from '@/lib/tesla';
import { fetchRivianVehicleState, hasRivianTokens, RivianVehicleState } from '@/lib/rivian';
import { getDoorState, hasMyQTokens } from '@/lib/myq';

export const dynamic = 'force-dynamic';

export interface VehicleData {
  id: 'tesla' | 'rivian';
  name: string;
  model: string;
  chargerSide: 'LEFT' | 'RIGHT';
  state: TeslaVehicleState | RivianVehicleState | null;
  connected: boolean;
  atHome: boolean | null; // true/false when GPS known, null when unknown
}

// Haversine distance in meters
function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const φ1 = aLat * Math.PI / 180;
  const φ2 = bLat * Math.PI / 180;
  const Δφ = (bLat - aLat) * Math.PI / 180;
  const Δλ = (bLon - aLon) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface WallConnectorData {
  side: 'LEFT' | 'RIGHT';
  vehicleName: string;
  vitals: WallConnectorVitals | null;
}

export interface DashboardData {
  vehicles: VehicleData[];
  wallConnectors: WallConnectorData[];
  site: TeslaSiteState | null;
  weather: WeatherData | null;
  garageConnected: boolean;
  garageDoorOpen: boolean | null;
  streamUrl: string;
  lastUpdated: string;
  teslaConnected: boolean;
  rivianConnected: boolean;
}

export interface WeatherData {
  temp: number;
  feelsLike: number;
  condition: string;
  icon: string;
  humidity: number;
}

async function fetchWeather(cfg: ReturnType<typeof readConfig>): Promise<WeatherData | null> {
  const { apiKey, lat, lon, location } = cfg.weather;
  if (!apiKey) return null;

  try {
    let url: string;
    if (lat !== null && lon !== null) {
      url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`;
    } else if (location) {
      url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${apiKey}&units=imperial`;
    } else {
      return null;
    }

    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[weather] OWM returned ${res.status}: ${body}`);
      return null;
    }

    interface OWMResponse {
      main: { temp: number; feels_like: number; humidity: number };
      weather: Array<{ description: string; icon: string }>;
    }
    const data = await res.json() as OWMResponse;
    return {
      temp: Math.round(data.main.temp),
      feelsLike: Math.round(data.main.feels_like),
      condition: (data.weather[0]?.description ?? '').replace(/^\w/, c => c.toUpperCase()),
      icon: data.weather[0]?.icon ?? '',
      humidity: data.main.humidity,
    };
  } catch (e) {
    console.error('[weather] fetch error:', e);
    return null;
  }
}

export async function GET() {
  const cfg = readConfig();
  const teslaConnected = readTokens() !== null;
  const rivianConnected = hasRivianTokens();
  const myqConnected = hasMyQTokens();

  const leftId  = cfg.energySite.wallConnectors.find(w => w.side === 'LEFT')?.deviceId  ?? '';
  const rightId = cfg.energySite.wallConnectors.find(w => w.side === 'RIGHT')?.deviceId ?? '';

  // Fetch all data in parallel
  const [teslaState, rivianState, siteState, wcLeft, wcRight, weather, doorState] = await Promise.all([
    teslaConnected ? fetchVehicleState(cfg.vehicles.tesla.vin) : Promise.resolve(null),
    rivianConnected ? fetchRivianVehicleState() : Promise.resolve(null),
    teslaConnected ? fetchSiteLiveStatus(cfg.energySite.id) : Promise.resolve(null),
    teslaConnected && leftId  ? fetchWallConnectorVitals(leftId)  : Promise.resolve(null),
    teslaConnected && rightId ? fetchWallConnectorVitals(rightId) : Promise.resolve(null),
    fetchWeather(cfg),
    myqConnected && cfg.garage.deviceSerial ? getDoorState(cfg.garage.deviceSerial) : Promise.resolve(null),
  ]);

  function computeAtHome(lat: number | null | undefined, lon: number | null | undefined): boolean | null {
    if (cfg.home.lat === null || cfg.home.lon === null) return null;
    if (lat === null || lat === undefined || lon === null || lon === undefined) return null;
    return distanceMeters(lat, lon, cfg.home.lat, cfg.home.lon) <= cfg.home.radiusMeters;
  }

  const vehicles: VehicleData[] = [
    {
      id: 'rivian',
      name: cfg.vehicles.rivian.name,
      model: cfg.vehicles.rivian.model,
      chargerSide: cfg.vehicles.rivian.chargerSide,
      state: rivianState,
      connected: rivianConnected,
      atHome: computeAtHome(rivianState?.lat, rivianState?.lon),
    },
    {
      id: 'tesla',
      name: cfg.vehicles.tesla.name,
      model: cfg.vehicles.tesla.model,
      chargerSide: cfg.vehicles.tesla.chargerSide,
      state: teslaState,
      connected: teslaConnected,
      atHome: computeAtHome(teslaState?.lat, teslaState?.lon),
    },
  ];

  const wallConnectors: WallConnectorData[] = [
    {
      side: 'LEFT',
      vehicleName: cfg.energySite.wallConnectors.find(w => w.side === 'LEFT')?.vehicleName ?? 'Rivian',
      vitals: wcLeft,
    },
    {
      side: 'RIGHT',
      vehicleName: cfg.energySite.wallConnectors.find(w => w.side === 'RIGHT')?.vehicleName ?? 'Tesla',
      vitals: wcRight,
    },
  ];

  const data: DashboardData = {
    vehicles,
    wallConnectors,
    site: siteState,
    weather,
    garageConnected: myqConnected,
    garageDoorOpen: doorState === 'open' ? true : doorState === 'closed' ? false : null,
    streamUrl: cfg.camera.streamUrl,
    lastUpdated: new Date().toISOString(),
    teslaConnected,
    rivianConnected,
  };

  // Persist to disk so the client can show last-known state on restart
  try {
    const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
    await writeFile(join(dir, 'last-status.json'), JSON.stringify(data));
  } catch { /* non-fatal */ }

  return Response.json(data);
}
