// GET ?q=<text>: places from the local geocoder (Nominatim on the LAN) for the
// /trips search box. LAN-only like the rest of the app (no auth).
import { NextRequest } from 'next/server';
import { searchPlaces } from '@/lib/geocode';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 200);
  return Response.json({ hits: await searchPlaces(q) });
}
