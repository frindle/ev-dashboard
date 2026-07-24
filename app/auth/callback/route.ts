import { NextRequest } from 'next/server';
import { writeTokens, TeslaTokens } from '@/lib/config';
import { clearTeslaReauthRequired } from '@/lib/sessionFlags';
import { verifyEnergySiteId } from '@/lib/tesla';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');

  if (error) {
    return new Response(`Tesla auth error: ${error}`, { status: 400 });
  }
  if (!code) {
    return new Response('No code received', { status: 400 });
  }

  const res = await fetch('https://auth.tesla.com/oauth2/v3/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: process.env.TESLA_CLIENT_ID,
      client_secret: process.env.TESLA_CLIENT_SECRET,
      code,
      redirect_uri: process.env.TESLA_REDIRECT_URI ?? 'https://ev-dashboard.penndalton.com/auth/callback',
    }),
  });

  const data = await res.json() as TeslaTokens;

  if (!res.ok) {
    return new Response(`Token exchange failed: ${JSON.stringify(data)}`, { status: 500 });
  }

  writeTokens(data);
  // Previously only cleared on the next successful poll cycle in
  // lib/tesla.ts — left a real window where fresh tokens were saved but
  // the dashboard still showed "reauth required" until that poll ran.
  // A completed callback IS the proof of a successful reauth; clear now.
  clearTeslaReauthRequired();

  // Confirmed 2026-07-25: the configured energy site ID can silently drift
  // from what Tesla's account actually reports, and a wrong ID fails
  // live_status calls in a way that just serves stale cache instead of
  // surfacing an error. Catch it here, right after a fresh token exists,
  // rather than relying on someone noticing stale data later.
  await verifyEnergySiteId().catch(e => console.warn('[auth/callback] verifyEnergySiteId failed:', e));

  return new Response('✓ Tesla auth complete. Tokens saved. You can close this tab.', {
    headers: { 'Content-Type': 'text/plain' },
  });
}
