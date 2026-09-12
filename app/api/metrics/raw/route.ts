// EV dashboard -> full-fidelity raw metrics export for InfluxDB/Telegraf ingestion.
// Exposes the raw keys/*.json dumps (rivian-state-debug.json, rivian-state.json,
// tesla-state.json, rivian-parallax.json, last-status.json) merged into one
// payload, scrubbed of secrets always and of location data when vacation mode is on.
import { readFileSync } from 'fs';
import { join } from 'path';
import { readConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

export interface MetricsRawOpts {
  vacationMode: boolean;
}

// Location keys stripped (recursively) when opts.vacationMode is true.
const LOCATION_KEYS = new Set(['lat', 'lon', 'latitude', 'longitude', 'gps', 'location']);
// Secret-named keys are stripped in BOTH modes -- substring match so
// accessToken / apiToken / clientSecret etc. never leak either.
const SECRET_KEY_MARKERS = ['token', 'secret', 'password'];

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_MARKERS.some((marker) => k.includes(marker));
}

// Deep-clone `value` while dropping secret-named keys (always) and location
// keys (vacation mode only). Primitives/null pass through untouched; objects
// and arrays are rebuilt, so the caller's inputs are never mutated.
function scrub(value: unknown, vacationMode: boolean): unknown {
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const lk = key.toLowerCase();
      if (isSecretKey(key) || (vacationMode && LOCATION_KEYS.has(lk))) continue;
      out[key] = scrub(val, vacationMode);
    }
    return out;
  }
  return value;
}

// Merge the provided raw source objects into one payload. Every source is
// represented under its own key; non-location, non-secret fields pass through
// unchanged. Inputs are deep-cloned (never mutated).
export function buildMetricsRawPayload(
  sources: Record<string, unknown>,
  opts: MetricsRawOpts,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [name, src] of Object.entries(sources)) {
    payload[name] = scrub(src, opts.vacationMode);
  }
  return payload;
}

// source key in the merged payload -> raw dump file under KEYS_DIR.
const RAW_SOURCES: Record<string, string> = {
  rivianRaw: 'rivian-state-debug.json',
  rivianState: 'rivian-state.json',
  teslaState: 'tesla-state.json',
  parallax: 'rivian-parallax.json',
  lastStatus: 'last-status.json',
};

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export async function GET() {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  const sources: Record<string, unknown> = {};
  for (const [name, file] of Object.entries(RAW_SOURCES)) {
    sources[name] = readJson(join(dir, file));
  }
  return new Response(JSON.stringify(buildMetricsRawPayload(sources, { vacationMode: readConfig().vacationMode })), {
    headers: { 'content-type': 'application/json' },
  });
}
