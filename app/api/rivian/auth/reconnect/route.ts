import { rivianLogin } from '@/lib/rivian';
import { readConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

// POST /api/rivian/auth/reconnect — no body. Uses the email/password saved
// from a prior successful login (config.vehicles.rivian) so the user only
// has to enter the OTP code, not retype credentials every time.
export async function POST() {
  const cfg = readConfig();
  const { email, password } = cfg.vehicles.rivian;
  if (!email || !password) {
    return Response.json({ error: 'No saved Rivian credentials — connect with email/password first' }, { status: 400 });
  }
  try {
    const result = await rivianLogin(email, password);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
