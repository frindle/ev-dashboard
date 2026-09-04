import { NextRequest } from 'next/server';
import { readConfig, writeConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

// Minimal machine-facing toggle for Vacation Mode, so an external automation
// (Home Assistant reacting to the ecobee thermostat entering away/vacation)
// can flip the privacy switch without round-tripping the WHOLE AppConfig
// through /api/config. Reads current config, flips only `vacationMode`, and
// writes it back — every other field is preserved exactly. See lib/vacation.ts
// for what the flag redacts (all vehicle location, server-side).
//
// LAN-only, matching /api/config which is likewise unauthenticated: the
// dashboard has no auth layer and this endpoint grants no more than the admin
// panel's own save already does. If auth is added later, add it in both places.

export async function GET() {
  return Response.json({ vacationMode: readConfig().vacationMode });
}

export async function POST(req: NextRequest) {
  let on: unknown;
  try {
    on = (await req.json())?.on;
  } catch {
    return Response.json({ error: 'body must be JSON {"on": boolean}' }, { status: 400 });
  }
  if (typeof on !== 'boolean') {
    return Response.json({ error: '"on" must be a boolean' }, { status: 400 });
  }
  const cfg = readConfig();
  if (cfg.vacationMode === on) {
    return Response.json({ ok: true, vacationMode: on, changed: false });
  }
  writeConfig({ ...cfg, vacationMode: on });
  return Response.json({ ok: true, vacationMode: on, changed: true });
}
