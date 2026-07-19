import { readConfig } from './config';

// Fallback data source for SolarEdge when Modbus/TCP (lib/solaredge.ts) isn't
// set up — logs into monitoring.solaredge.com with the portal username/password
// (no API key) the same way Home Assistant's SolarEdge integration does for
// its "module-level statistics" mode. Ported from github.com/tronikos/solaredge-web.
//
// Caveat: this only exposes 15-minute-aggregated per-module energy (Wh), not
// live instantaneous power. We approximate "current" power from the most
// recent 15-min bucket (Wh × 4) — it lags reality by up to 15 minutes.
// Modbus is strictly better when available; this is a "something is better
// than nothing" fallback.

const LOGIN_URL = 'https://monitoring.solaredge.com/solaredge-apigw/api/login';
const ENERGY_URL = 'https://monitoring.solaredge.com/solaredge-web/p/playbackData';
const SESSION_TTL_MS = 30 * 60_000;

interface Session { cookies: Map<string, string>; loginAt: number }
let session: Session | null = null;

function applySetCookies(cookies: Map<string, string>, res: Response) {
  for (const raw of res.headers.getSetCookie()) {
    const pair = raw.split(';', 1)[0];
    const idx = pair.indexOf('=');
    if (idx > 0) cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function login(): Promise<Map<string, string>> {
  const { username, password } = readConfig().solar;
  if (!username || !password) throw new Error('SolarEdge web username/password not configured');

  const cookies = new Map<string, string>();
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ j_username: username, j_password: password }),
  });
  applySetCookies(cookies, res);
  if (!res.ok || !cookies.has('CSRF-TOKEN')) {
    throw new Error(`SolarEdge web login failed: ${res.status}`);
  }
  session = { cookies, loginAt: Date.now() };
  return cookies;
}

async function getSession(): Promise<Map<string, string>> {
  if (session && Date.now() - session.loginAt < SESSION_TTL_MS) return session.cookies;
  return login();
}

export interface SolarWebLive {
  acPowerW: number; // approximate — from the most recent 15-min bucket
  dailyKwh: number;
  fetchedAt: string;
}

export async function readSolarWebLive(): Promise<SolarWebLive> {
  const { siteId } = readConfig().solar;
  if (!siteId) throw new Error('SolarEdge site ID not configured');

  const cookies = await getSession();
  const csrf = cookies.get('CSRF-TOKEN')!;
  const res = await fetch(ENERGY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-TOKEN': csrf,
      Cookie: cookieHeader(cookies),
    },
    body: new URLSearchParams({ fieldId: siteId, timeUnit: '4' }), // 4 = DAY
  });
  applySetCookies(cookies, res);
  if (!res.ok) throw new Error(`SolarEdge web energy fetch failed: ${res.status}`);

  // Response body is a JS object literal, not strict JSON — same quoting
  // fixup the upstream python client uses.
  const text = (await res.text())
    .replace(/'/g, '"')
    .replace(/timeUnit:/g, '"timeUnit":')
    .replace(/fieldData:/g, '"fieldData":')
    .replace(/fieldDataArray:/g, '"fieldDataArray":')
    .replace(/reportersData:/g, '"reportersData":')
    .replace(/key:/g, '"key":')
    .replace(/value:/g, '"value":');
  const parsed = JSON.parse(text) as {
    reportersData: Record<string, Record<string, Array<{ key: number; value: string }>>>;
  };

  // Keys are chronologically ordered 15-min bucket timestamps; each value is
  // a per-module Wh reading for that bucket. Sum modules per bucket, sum
  // buckets for the day, use the last bucket as the current-power estimate.
  const bucketsWh = Object.values(parsed.reportersData).map(
    d => Object.values(d).flat().reduce((sum, e) => sum + Number(e.value), 0),
  );
  const dailyWh = bucketsWh.reduce((sum, wh) => sum + wh, 0);
  const lastWh = bucketsWh[bucketsWh.length - 1] ?? 0;

  return {
    acPowerW: Math.round(lastWh * 4), // Wh in a 15-min bucket → avg W
    dailyKwh: dailyWh / 1000,
    fetchedAt: new Date().toISOString(),
  };
}
