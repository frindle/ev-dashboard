import { reresolveVehicleId } from '@/lib/rivian';

export const dynamic = 'force-dynamic';

// POST /api/rivian/resolve-vehicle — retry vehicle-ID lookup using the
// already-saved session, no re-login/OTP needed.
export async function POST() {
  try {
    const result = await reresolveVehicleId();
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
