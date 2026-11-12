// POST (JSON or the /trips forms), LAN-only like the rest of the app:
//   { kind: 'overlap', uid, day, choice: 'skip'|'going'|'fix' }
//   { kind: 'toggle',  uid, day, value: 'home'|'straight'|'' }
//   { kind: 'place',   uid | 'work', lat, lon, label? }   (a pick saved in keys/geo-overrides.json,
//                                                         and written to the event when PERSONAL_CAL_WRITEBACK=1)
import { NextRequest } from 'next/server';
import { writeBackPlace } from '@/lib/caldavWriteback';
import { WORK_KEY } from '@/lib/geocode';
import { setGeoOverride, mutateTripChoices } from '@/lib/tripStore';
import { runRivianChargeControl } from '@/lib/rivianChargeControl';

export const dynamic = 'force-dynamic';

// Back to the page the form was on, only on this host (never an outside referer).
function sameOriginPath(req: NextRequest): string {
  try {
    const r = new URL(req.headers.get('referer') ?? '');
    if (r.host === req.nextUrl.host) return r.pathname + r.search;
  } catch { /* no or bad referer */ }
  return '/trips';
}

export async function POST(req: NextRequest) {
  const isForm = (req.headers.get('content-type') ?? '').includes('form');
  let b: Record<string, unknown> | null = null;
  if (isForm) {
    const f = await req.formData().catch(() => null);
    b = f ? Object.fromEntries(f.entries()) : null;
  } else {
    b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  }
  const uid = typeof b?.uid === 'string' && b.uid.length > 0 && b.uid.length <= 300 ? b.uid : null;
  const day = Number(b?.day);
  let result = 'ok';
  if (b?.kind === 'overlap' && uid && Number.isInteger(day) && ['skip', 'going', 'fix'].includes(String(b.choice))) {
    await mutateTripChoices((c) => { c.choices[`${uid}@${day}`] = b!.choice as 'skip' | 'going' | 'fix'; });
  } else if (b?.kind === 'toggle' && uid && Number.isInteger(day)) {
    await mutateTripChoices((c) => {
      if (b!.value === 'home' || b!.value === 'straight') c.toggles[`${uid}@${day}`] = b!.value; else delete c.toggles[`${uid}@${day}`];
    });
  } else if (b?.kind === 'place' && uid) {
    const lat = Number(b.lat), lon = Number(b.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return Response.json({ error: 'bad coordinates' }, { status: 400 });
    }
    const label = typeof b.label === 'string' ? b.label.slice(0, 200) : '';
    await setGeoOverride(uid === 'work' ? WORK_KEY : uid, { lat, lon });
    if (uid !== 'work') result = await writeBackPlace(uid, { lat, lon, label });
  } else {
    return Response.json({ error: 'bad request' }, { status: 400 });
  }
  void runRivianChargeControl({ force: true });
  if (isForm) return new Response(null, { status: 303, headers: { Location: sameOriginPath(req) } });
  return Response.json({ ok: true, writeback: result });
}
