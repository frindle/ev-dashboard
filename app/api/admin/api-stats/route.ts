import { NextRequest } from 'next/server';
import { readApiCalls, ApiCallRecord } from '@/lib/apiLog';

export const dynamic = 'force-dynamic';

// Aggregations over the outbound-API call log. Purpose: figure out whether
// we're polling providers (Rivian especially) more often than we should.
// Query params:
//   ?hours=24        window size (default 24h)
//   ?provider=rivian filter (optional)
//
// Returns per-provider:
//   total, ok, error counts and rate/min
//   status breakdown
//   reason breakdown (throttled / unauthorized / server_error / timeout / network)
//   per-endpoint counts
//   latency p50 / p95
//   backoff-active fraction (how often we called while backoff was engaged)
//   per-hour histogram
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const hours = Math.max(1, Math.min(168, Number(url.searchParams.get('hours') ?? '24')));
  const providerFilter = url.searchParams.get('provider');
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const all = await readApiCalls(sinceMs);
  const recs = providerFilter
    ? all.filter(r => r.provider === providerFilter)
    : all;
  const byProvider: Record<string, ApiCallRecord[]> = {};
  for (const r of recs) {
    (byProvider[r.provider] ??= []).push(r);
  }
  const providers: Record<string, unknown> = {};
  for (const [prov, list] of Object.entries(byProvider)) {
    providers[prov] = summarize(list, hours);
  }
  return Response.json({
    ok: true,
    windowHours: hours,
    totalCalls: recs.length,
    providers,
  });
}

function summarize(list: ApiCallRecord[], hours: number) {
  const total = list.length;
  let ok = 0;
  let backoffActive = 0;
  const status: Record<number, number> = {};
  const reason: Record<string, number> = {};
  const endpoint: Record<string, { total: number; ok: number; errors: number }> = {};
  const perHour: Record<string, number> = {};
  const latencies: number[] = [];
  for (const r of list) {
    if (r.ok) ok++;
    if (r.backoffActive) backoffActive++;
    status[r.status] = (status[r.status] ?? 0) + 1;
    if (r.reason) reason[r.reason] = (reason[r.reason] ?? 0) + 1;
    const ep = endpoint[r.endpoint] ??= { total: 0, ok: 0, errors: 0 };
    ep.total++;
    if (r.ok) ep.ok++; else ep.errors++;
    latencies.push(r.durationMs);
    const hourKey = r.ts.slice(0, 13); // YYYY-MM-DDTHH
    perHour[hourKey] = (perHour[hourKey] ?? 0) + 1;
  }
  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] : 0;
  return {
    total,
    ok,
    errors: total - ok,
    errorRate: total ? +(1 - ok / total).toFixed(3) : 0,
    callsPerMin: +(total / (hours * 60)).toFixed(2),
    backoffActiveFraction: total ? +(backoffActive / total).toFixed(3) : 0,
    latencyMs: { p50: p(0.5), p95: p(0.95), max: latencies.at(-1) ?? 0 },
    status,
    reason,
    perEndpoint: Object.fromEntries(
      Object.entries(endpoint).sort(([, a], [, b]) => b.total - a.total),
    ),
    perHour,
  };
}
