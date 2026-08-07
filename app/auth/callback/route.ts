import { NextRequest } from 'next/server';
import { writeTokens, TeslaTokens } from '@/lib/config';
import { clearTeslaReauthRequired } from '@/lib/sessionFlags';
import { verifyEnergySiteId, resetCircuitBreaker } from '@/lib/tesla';

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

  // Everything below used to be unguarded: a network blip on this fetch, or a
  // non-JSON error body from Tesla (res.json() ran *before* the res.ok check,
  // so an HTML/empty 4xx body threw rather than producing the 500 below),
  // escaped the route handler and surfaced as a raw framework error page at
  // exactly the URL the user was sitting on mid-reauth. The client-side error
  // boundary in app/page.tsx does not cover route handlers, so nothing caught
  // it and nothing logged it. Fail with a readable reason instead.
  let res: Response;
  try {
    res = await fetch('https://auth.tesla.com/oauth2/v3/token', {
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
  } catch (e) {
    console.error('[auth/callback] token exchange request failed:', e);
    return new Response(`Token exchange request failed: ${String(e).slice(0, 300)}`, { status: 502 });
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    console.error(`[auth/callback] token exchange HTTP ${res.status}: ${raw.slice(0, 300)}`);
    return new Response(`Token exchange failed: HTTP ${res.status} ${raw.slice(0, 300)}`, { status: 500 });
  }

  let data: TeslaTokens;
  try {
    data = JSON.parse(raw) as TeslaTokens;
  } catch {
    console.error('[auth/callback] token exchange returned non-JSON:', raw.slice(0, 300));
    return new Response(`Token exchange returned non-JSON: ${raw.slice(0, 300)}`, { status: 500 });
  }

  writeTokens(data);
  // Previously only cleared on the next successful poll cycle in
  // lib/tesla.ts — left a real window where fresh tokens were saved but
  // the dashboard still showed "reauth required" until that poll ran.
  // A completed callback IS the proof of a successful reauth; clear now.
  clearTeslaReauthRequired();
  // The 401 run that preceded this re-auth almost certainly tripped the
  // circuit breaker; leaving it open would skip every Fleet API call for the
  // next 5 minutes, which is 5 minutes in which nothing can confirm the new
  // token works (and, before the clear-on-success fix in lib/tesla.ts,
  // 5 minutes of stale "reauthenticate" banner).
  resetCircuitBreaker();

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
