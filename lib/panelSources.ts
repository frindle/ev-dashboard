// IO for the panel feed (GET /api/panel): reads bloom-ledger, network-bandwidth-monitor, InfluxDB and the Rivian night
// plan, and hands each result to the pure parsers in lib/panelFeed.ts. Read-only: nothing here writes anywhere.
// Hosts and tokens come from the environment (see .env.example, "Panel feed"); a missing URL makes that section ok=0.
import { rivianNightPlan } from '@/lib/rivianNightPlan';
import {
  earnedCents, parseBloom, parseEv, parseFluxCsv, parseStorage, parseUnraidNet, parseWan,
  type Section, type Sources,
} from '@/lib/panelFeed';

const FETCH_MS = 5_000;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function base(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v.replace(/\/+$/, '') : null;
}

// ---- Influx (read): same server as the telemetry write path, bucket/token overridable for the Unraid metrics ----
function influxRead(): { url: string; headers: Record<string, string> } | null {
  const url = base('INFLUX_URL');
  const org = process.env.INFLUX_ORG;
  const token = process.env.PANEL_INFLUX_TOKEN || process.env.INFLUX_TOKEN;
  if (!url || !org || !token) return null;
  return {
    url: `${url}/api/v2/query?org=${encodeURIComponent(org)}`,
    headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/vnd.flux', Accept: 'application/csv' },
  };
}

export const panelBucket = (): string => process.env.PANEL_INFLUX_BUCKET?.trim() || 'metrics';

export function fluxFor(measurements: string[], fields: string[], bucket = panelBucket()): string {
  const m = measurements.map((x) => `r._measurement == "${x}"`).join(' or ');
  const f = fields.map((x) => `r._field == "${x}"`).join(' or ');
  return `from(bucket: "${bucket}") |> range(start: -15m) |> filter(fn: (r) => (${m}) and (${f})) |> last()`;
}

async function queryFlux(flux: string) {
  const t = influxRead();
  if (!t) throw new Error('influx not configured');
  const res = await fetch(t.url, { method: 'POST', headers: t.headers, body: flux, signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error(`influx HTTP ${res.status}`);
  return parseFluxCsv(await res.text());
}

const nowS = () => Math.floor(Date.now() / 1000);

async function storage(): Promise<Section> {
  const rows = await queryFlux(fluxFor(
    ['unraid_disk', 'unraid_array'],
    ['fs_size_kb', 'fs_used_kb', 'fs_free_kb', 'spinning', 'temp_c', 'state', 'parity_running', 'parity_progress', 'parity_errors', 'notif_unread_alert', 'notif_unread_warning'],
  ));
  return parseStorage(rows, nowS());
}

async function network(): Promise<Section> {
  const nm = base('PANEL_NETMON_URL');
  if (nm) {
    try {
      const wan = parseWan(await getJson(`${nm}/api/fw_wan_rates`));
      if (wan.ok) return wan;
    } catch { /* fall through to Unraid's own traffic */ }
  }
  const rows = await queryFlux(fluxFor(['unraid_net'], ['rx_bps', 'tx_bps']));
  return parseUnraidNet(rows, nowS());
}

async function darkbloom(): Promise<Section> {
  const bl = base('PANEL_BLOOM_LEDGER_URL');
  if (!bl) throw new Error('PANEL_BLOOM_LEDGER_URL not set');
  const [live, alerts] = await Promise.all([getJson(`${bl}/v1/live`), getJson(`${bl}/v1/alerts`)]);
  // $ today / this month per Mac; best effort, the section is still ok without them.
  const ids = ((live as { mac?: { machine_id?: string }[] })?.mac ?? []).map((m) => String(m.machine_id)).filter(Boolean).slice(0, 4);
  const earned: Record<string, { day?: number; month?: number }> = {};
  await Promise.all(ids.map(async (id) => {
    const q = `machine=${encodeURIComponent(id)}`;
    const [d, m] = await Promise.allSettled([
      getJson(`${bl}/v1/accounting/summary?period=day&${q}`), getJson(`${bl}/v1/accounting/summary?period=month&${q}`),
    ]);
    earned[id] = {
      day: d.status === 'fulfilled' ? earnedCents(d.value) : undefined,
      month: m.status === 'fulfilled' ? earnedCents(m.value) : undefined,
    };
  }));
  return parseBloom({ live, alerts, earned });
}

async function evTonight(): Promise<Section> {
  const run = await rivianNightPlan(Date.now());
  const r = run.built?.result;
  if (!r) return { ok: 0, st: 0 };
  return parseEv({
    plugged: run.state?.isPluggedIn ?? null, soc: run.state?.chargePercent ?? null, limit: run.state?.chargeLimit ?? null,
    amps: r.plan.amps, kwh: r.plan.kwh, windowHours: r.plan.windowHours, targetPct: r.plan.targetPct,
    shortfall: r.plan.shortfall, isWork: r.isWork,
  });
}

export const panelSources: Sources = { bl: darkbloom, nw: network, sd: storage, ev: evTonight };
