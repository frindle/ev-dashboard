// POST { uid, action: 'ignore' } (JSON or the /shifts form): skip that calendar
// event when planning charges. See lib/shiftChoices.ts.
import { NextRequest } from 'next/server';
import { validChoice } from '@/lib/shiftChoices';
import { ignoreShift } from '@/lib/shiftChoicesStore';
import { runRivianChargeControl } from '@/lib/rivianChargeControl';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const isForm = (req.headers.get('content-type') ?? '').includes('form');
  let body: unknown = null;
  if (isForm) {
    const f = await req.formData().catch(() => null);
    body = f ? { uid: f.get('uid'), action: f.get('action') } : null;
  } else {
    body = await req.json().catch(() => null);
  }
  const c = validChoice(body);
  if (!c) return Response.json({ error: 'need { uid, action: "ignore" }' }, { status: 400 });
  await ignoreShift(c.uid);
  void runRivianChargeControl({ force: true });
  if (isForm) return new Response(null, { status: 303, headers: { Location: req.headers.get('referer') ?? '/shifts' } });
  return Response.json({ ok: true });
}
