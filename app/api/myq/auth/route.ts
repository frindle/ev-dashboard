import { myqLogin, hasMyQTokens } from '@/lib/myq';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ connected: hasMyQTokens() });
}

export async function POST(req: Request) {
  const { email, password } = await req.json() as { email?: string; password?: string };
  if (!email || !password) {
    return Response.json({ error: 'Email and password required' }, { status: 400 });
  }
  try {
    await myqLogin(email, password);
    return Response.json({ connected: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
