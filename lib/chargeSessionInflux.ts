// Mirrors finished charge sessions (the rows appendChargeHistory writes to
// charge-history.jsonl) into InfluxDB, and backfills the existing history via
// /api/admin/influx-backfill.
//
// Point: ev_charge_session,side=LEFT|RIGHT,vehicle=rivian|tesla|unknown
//        energy_kwh=<float>[,duration_min=<float>][,start_soc,end_soc,avg_kw,peak_kw] <startedAt ms>
// Same measurement + tags + timestamp overwrites in Influx, so writing a
// session twice (live mirror + backfill, or a re-run backfill) is harmless.
//
// Uses the same INFLUX_* env vars and write URL as server/telemetry-influx.js.
// Type-only imports, so node:test can load this file with
// --experimental-strip-types and no node_modules.
import type { ChargeHistoryRow } from './chargeHistory';
import type { AppConfig } from './config';

export type SessionVehicleId = 'rivian' | 'tesla' | 'unknown';
export type VehicleIdFor = (row: Pick<ChargeHistoryRow, 'vehicleName' | 'side'>) => SessionVehicleId;

export const MEASUREMENT = 'ev_charge_session';
export const BATCH_LINES = 5000;
const MIRROR_TIMEOUT_MS = 5_000;
const BACKFILL_TIMEOUT_MS = 30_000;

export interface InfluxTarget {
  url: string;
  headers: Record<string, string>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// Same attribution as /api/energy: exact vehicle name first, then the
// configured charger side. Unlike /api/energy (which defaults to 'tesla'),
// a row that matches neither is tagged 'unknown' rather than guessed.
export function vehicleIdResolver(cfg: Pick<AppConfig, 'vehicles'> | null | undefined): VehicleIdFor {
  const byName = new Map<string, SessionVehicleId>();
  const bySide = new Map<string, SessionVehicleId>();
  const v = cfg?.vehicles;
  // Same insertion order as /api/energy's Maps, so a name/side shared by
  // both vehicles resolves the same way (the later entry, tesla, wins).
  if (v?.rivian) { byName.set(v.rivian.name, 'rivian'); bySide.set(v.rivian.chargerSide, 'rivian'); }
  if (v?.tesla) { byName.set(v.tesla.name, 'tesla'); bySide.set(v.tesla.chargerSide, 'tesla'); }
  return (row) => byName.get(row.vehicleName) ?? bySide.get(row.side) ?? 'unknown';
}

function escapeTag(value: string): string {
  return value.replace(/[\\,= ]/g, (c) => '\\' + c);
}

function finite(n: unknown): number | null {
  const x = typeof n === 'number' ? n : typeof n === 'string' && n.trim() !== '' ? Number(n) : NaN;
  return Number.isFinite(x) ? x : null;
}

// One line-protocol line, or null when the row can't be placed: unparseable
// startedAt, missing/negative energy, or a side other than LEFT/RIGHT.
// duration_min falls back to endedAt - startedAt and is left out when
// neither is usable. Fields are always written as floats (no `i` suffix) so
// the field type never conflicts across points.
export function sessionLine(row: ChargeHistoryRow, vehicle: SessionVehicleId): string | null {
  if (!row || (row.side !== 'LEFT' && row.side !== 'RIGHT')) return null;
  const ts = Date.parse(row.startedAt);
  if (!Number.isFinite(ts)) return null;
  const energy = finite(row.energyKwh);
  if (energy === null || energy < 0) return null;
  let duration = finite(row.durationMin);
  if (duration === null || duration < 0) {
    const end = Date.parse(row.endedAt);
    duration = Number.isFinite(end) && end >= ts ? (end - ts) / 60_000 : null;
  }
  const fields = [`energy_kwh=${energy}`];
  if (duration !== null) fields.push(`duration_min=${duration}`);
  for (const [name, v] of [['start_soc', row.startSoc], ['end_soc', row.endSoc], ['avg_kw', row.avgKw], ['peak_kw', row.peakKw]] as const) {
    const x = finite(v);
    if (x !== null && x >= 0) fields.push(`${name}=${x}`);
  }
  return `${MEASUREMENT},side=${escapeTag(row.side)},vehicle=${escapeTag(vehicle)} ${fields.join(',')} ${Math.round(ts)}`;
}

export interface SessionLinesResult {
  lines: string[];
  skipped: number;
  byVehicle: Record<string, number>;
  first: string | null;
  last: string | null;
}

export function sessionLines(rows: ChargeHistoryRow[], idFor: VehicleIdFor): SessionLinesResult {
  const lines: string[] = [];
  const byVehicle: Record<string, number> = {};
  let skipped = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    const id = row ? idFor(row) : 'unknown';
    const line = row ? sessionLine(row, id) : null;
    if (!line) { skipped++; continue; }
    lines.push(line);
    byVehicle[id] = (byVehicle[id] ?? 0) + 1;
    const ts = Date.parse(row.startedAt);
    if (ts < min) min = ts;
    if (ts > max) max = ts;
  }
  return {
    lines,
    skipped,
    byVehicle,
    first: lines.length ? new Date(min).toISOString() : null,
    last: lines.length ? new Date(max).toISOString() : null,
  };
}

// null unless all four INFLUX_* vars are set (same rule as
// server/telemetry-server.js maybeWriteInflux).
export function influxTarget(env: Record<string, string | undefined> = process.env): InfluxTarget | null {
  const { INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET } = env;
  if (!INFLUX_URL || !INFLUX_TOKEN || !INFLUX_ORG || !INFLUX_BUCKET) return null;
  const base = INFLUX_URL.endsWith('/') ? INFLUX_URL.slice(0, -1) : INFLUX_URL;
  return {
    url: base + '/api/v2/write?org=' + encodeURIComponent(INFLUX_ORG) +
      '&bucket=' + encodeURIComponent(INFLUX_BUCKET) + '&precision=ms',
    headers: { Authorization: 'Token ' + INFLUX_TOKEN, 'Content-Type': 'text/plain; charset=utf-8' },
  };
}

// Writes in batches of BATCH_LINES. Throws on the first failed batch with the
// HTTP status and the start of Influx's error body (never the token).
// Returns the number of lines written.
export async function writeLines(
  lines: string[],
  target: InfluxTarget,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = BACKFILL_TIMEOUT_MS,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < lines.length; i += BATCH_LINES) {
    const batch = lines.slice(i, i + BATCH_LINES);
    const res = await fetchImpl(target.url, {
      method: 'POST',
      headers: target.headers,
      body: batch.join('\n'),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { /* body unreadable */ }
      throw new Error(`influx write failed: HTTP ${res.status} after ${written} lines: ${detail}`);
    }
    written += batch.length;
  }
  return written;
}

// Live mirror for one finished session. Never throws: returns false when
// Influx isn't configured, the row can't be placed, or the write fails.
export async function mirrorSessionToInflux(
  row: ChargeHistoryRow,
  idFor: VehicleIdFor,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<boolean> {
  try {
    const target = influxTarget(env);
    if (!target) return false;
    const line = sessionLine(row, idFor(row));
    if (!line) return false;
    await writeLines([line], target, fetchImpl, MIRROR_TIMEOUT_MS);
    return true;
  } catch (e) {
    console.error('[charge-history] influx mirror failed:', e instanceof Error ? e.message : e);
    return false;
  }
}
