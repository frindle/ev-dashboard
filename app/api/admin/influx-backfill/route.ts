import { NextResponse } from 'next/server';
import { readChargeHistory } from '@/lib/chargeHistory';
import { readConfig } from '@/lib/config';
import { influxTarget, sessionLines, vehicleIdResolver, writeLines, MEASUREMENT } from '@/lib/chargeSessionInflux';

export const dynamic = 'force-dynamic';

// Copies every charge-history.jsonl session into InfluxDB as
// ev_charge_session points (see lib/chargeSessionInflux.ts). New sessions are
// mirrored live by appendChargeHistory; this fills in everything before that.
//   GET   dry run: what would be written, nothing is sent
//   POST  write all sessions. Idempotent (same tags + timestamp overwrite),
//         so it is safe to re-run.
// 503 when any INFLUX_* env var is unset.
// NOTE: like every other route under /api/admin here, this has no auth of its
// own and relies on the deployment being LAN-only.

async function plan() {
  const rows = await readChargeHistory();
  return { rows: rows.length, ...sessionLines(rows, vehicleIdResolver(readConfig())) };
}

function notConfigured() {
  return NextResponse.json(
    { configured: false, error: 'INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG and INFLUX_BUCKET must all be set' },
    { status: 503 },
  );
}

export async function GET() {
  if (!influxTarget()) return notConfigured();
  const { lines, ...summary } = await plan();
  return NextResponse.json({
    configured: true,
    dryRun: true,
    measurement: MEASUREMENT,
    ...summary,
    toWrite: lines.length,
    sample: lines[0] ?? null,
  });
}

export async function POST() {
  const target = influxTarget();
  if (!target) return notConfigured();
  const { lines, ...summary } = await plan();
  try {
    const written = await writeLines(lines, target);
    return NextResponse.json({ configured: true, dryRun: false, measurement: MEASUREMENT, ...summary, written });
  } catch (e) {
    return NextResponse.json(
      { configured: true, dryRun: false, ...summary, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
