// GET ?q=<text>: places for the /trips search box, from the LAN Nominatim and,
// when that has no match (or NOMINATIM_URL is unset), the public one unless
// GEO_ONLINE=0 (lib/geocode.ts searchPlaces). The app itself is LAN-only (no auth).
import { NextRequest } from 'next/server';
import { searchPlaces } from '@/lib/geocode';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 200);
  return Response.json({ hits: await searchPlaces(q) });
}
