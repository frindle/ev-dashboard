import { NextRequest } from 'next/server';
import { readRivianRaw, readTeslaRaw } from '@/lib/rawState';
import { readConfig } from '@/lib/config';
import { scrubRawLocation } from '@/lib/vacation';

export const dynamic = 'force-dynamic';

// Serves the raw provider payloads the app already records to the keys volume.
//
// Why this exists: the dashboard's mapped state is deliberately lossy -- it
// carries only the fields the app currently knows to check -- so anything the
// vehicle does that isn't modelled is invisible through /api/dashboard. Found
// this the hard way 2026-08-24 with the R1S in service: /api/dashboard showed
// chargePercent 0, rangeMi 0, odometer 0, which reads as "empty battery" but
// actually means "field absent, defaulted to 0". The raw dump distinguishes
// the two; the mapped view cannot.
//
//   ?provider=rivian    the full GetVehicleState response, last successful poll
//   ?provider=tesla     recent logged response bodies (TESLA_LOG_API_BODIES=1)
//   ?provider=all       both (default)
//   ?limit=N            Tesla bodies to return, newest last (default 20, max 500)
//
// Read-only: serves files, issues no provider API calls, so hitting it cannot
// consume rate budget or perturb backoff state. Secrets are redacted by key
// name in lib/rawState.ts on the way out.
//
// NOTE: like every other route under /api/admin here, this has no auth of its
// own and relies on the deployment being LAN-only. It exposes vehicle location.
// If this app is ever put behind a public ingress, this route needs a guard
// before that happens.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const provider = (url.searchParams.get('provider') ?? 'all').toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? '20')));

  if (provider !== 'all' && provider !== 'rivian' && provider !== 'tesla') {
    return Response.json(
      { error: `unknown provider '${provider}'`, valid: ['rivian', 'tesla', 'all'] },
      { status: 400 },
    );
  }

  const out: Record<string, unknown> = { ts: new Date().toISOString() };
  if (provider === 'rivian' || provider === 'all') out.rivian = await readRivianRaw();
  if (provider === 'tesla' || provider === 'all') out.tesla = await readTeslaRaw(limit);

  // This diagnostic dump exposes raw provider payloads, which include vehicle
  // location (see the NOTE above). Honour Vacation Mode here too: recursively
  // null any location-named key so the raw view can't leak position while the
  // privacy switch is on. No marker is added — the scrubbed output just looks
  // like data without location. Reversible: turn Vacation Mode off to see full
  // raw data again.
  if (readConfig().vacationMode) {
    return Response.json(scrubRawLocation(out) as Record<string, unknown>);
  }

  return Response.json(out);
}
