import { NextRequest } from 'next/server';
import { readConfig, writeConfig, AppConfig } from '@/lib/config';
import { hasTokens } from '@/lib/tesla';
import { hasRivianTokens } from '@/lib/rivian';
import { hasMyQTokens } from '@/lib/myq';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = readConfig();
  // Never send stored passwords back to the browser — write-only fields.
  // hasStoredXPassword tells the client whether one is saved without
  // exposing the value, so a reconnect button can offer "use saved
  // password" without the plaintext ever round-tripping over the wire.
  const redacted: AppConfig = {
    ...cfg,
    vehicles: { ...cfg.vehicles, rivian: { ...cfg.vehicles.rivian, password: '' } },
    garage: { ...cfg.garage, password: '' },
    nvr: { ...cfg.nvr, password: '' },
    solar: { ...cfg.solar, password: '' },
  };
  return Response.json({
    config: redacted,
    teslaConnected: hasTokens(),
    rivianConnected: hasRivianTokens(),
    myqConnected: hasMyQTokens(),
    hasStoredRivianPassword: cfg.vehicles.rivian.password !== '',
    hasStoredMyqPassword: cfg.garage.password !== '',
    hasStoredNvrPassword: cfg.nvr.password !== '',
    hasStoredSolarPassword: cfg.solar.password !== '',
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as AppConfig;
    // GET redacts passwords to '', so a blank incoming value means "unchanged"
    // — never let a normal settings save silently blank out a stored password.
    const existing = readConfig();
    if (!body.vehicles.rivian.password) body.vehicles.rivian.password = existing.vehicles.rivian.password;
    if (!body.garage.password) body.garage.password = existing.garage.password;
    if (!body.nvr.password) body.nvr.password = existing.nvr.password;
    if (!body.solar.password) body.solar.password = existing.solar.password;
    writeConfig(body);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}
