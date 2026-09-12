// EV dashboard -> InfluxDB line protocol export for Telegraf-pull ingestion.
// Reads the same raw keys/*.json source dumps as /api/metrics/raw and serializes
// ALL cached source state as line protocol (one measurement per section). Telegraf
// pulls this with data_format="influx" (passthrough), so new upstream fields land
// in InfluxDB automatically with zero per-field mapping. Secret scrub is always
// applied and location is dropped under vacation mode -- both inside
// buildInfluxLineProtocol, so the raw sources are passed through untouched here.
import { readFileSync } from 'fs';
import { join } from 'path';
import { readConfig } from '@/lib/config';
import { buildInfluxLineProtocol } from '@/server/telemetry-influx';

export const dynamic = 'force-dynamic';

// source key -> raw dump file under KEYS_DIR. Mirrors RAW_SOURCES in
// /api/metrics/raw and the SECTION_MEASUREMENTS map in server/telemetry-influx.js.
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
  const body = buildInfluxLineProtocol(sources, { vacationMode: readConfig().vacationMode });
  // 204 on a cold cache (no state yet) so Telegraf's success_status_codes=[200,204]
  // treats an empty pull as OK rather than an error.
  if (body === '') {
    return new Response(null, { status: 204 });
  }
  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
