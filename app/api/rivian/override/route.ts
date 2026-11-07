// One-off Rivian charge override: GET status, POST { targetPct, byMs } to
// set ("be at targetPct% by byMs"), DELETE to clear. See
// lib/rivianChargeControl.ts.
import { NextRequest } from 'next/server';
import { validOverride } from '@/lib/chargeOverride';
import { clearOverride, writeOverride } from '@/lib/rivianOverrideStore';
import { runRivianChargeControl } from '@/lib/rivianChargeControl';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(await runRivianChargeControl());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const now = Date.now();
  const o = validOverride(body, now);
  if (!o) {
    return Response.json({ error: 'targetPct must be a whole number 50-100 and byMs a time within the next 14 days' }, { status: 400 });
  }
  await writeOverride({ ...o, setAtMs: now });
  return Response.json(await runRivianChargeControl({ force: true }));
}

export async function DELETE() {
  await clearOverride();
  return Response.json(await runRivianChargeControl({ force: true }));
}
