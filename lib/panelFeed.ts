// Panel feed: one small JSON for the ESP32 round display (Elecrow CrowPanel 2.1"), GET /api/panel.
// Pure: parsers for each source and the aggregator. The IO that reads the sources is lib/panelSources.ts.
//
// Every section is { ok, st, ... }: ok=1 data present, ok=0 source down and nothing recent to show; st=1 the data is
// older than it should be (the source answered with old points, or the last good copy is shown because the source
// failed just now). One dead source never blanks the panel.
//
// Keys (short on purpose; the whole body stays under 4 KB, see PANEL_MAX_BYTES):
//   v   format version (1)                       t   server time, epoch seconds
//   lvl overall alert level: "g" green, "a" amber, "r" red
//   why up to 3 short reasons for amber/red, e.g. "silent:m4max", "array:STOPPED", "wan:down", "src:nw"
//   go  only on red: the section the panel jumps to, "bl" (a silent Mac) or "sd" (array, parity, cache >= 90%)
//   bl  Darkbloom per Mac:  m: [{ n name, on 1 serving, s state text, w watts, jobs sandbox jobs,
//                                 td earned today (cents), tm earned this month (cents), age seconds since last
//                                 power minute, sl 1 silent (alert) }],   al: open bloom-ledger alert count
//   nw  network:            src "wan" | "unraid",  l: [{ n name, d down Mbps, u up Mbps }]
//   sd  storage:            tot: { s size GB, u used GB },  d: [{ n name, r role d|c|p, u used %, sp 1 spinning,
//                                 (a multi-SSD cache pool is one "cache" row)
//                                 t temp C }],  spin spinning disk count, nd disk count,  arr array state,
//                                 par 1 parity check running, pp parity progress %, pe parity errors,
//                                 na unread Unraid alert notifications, nwn unread warnings
//   ev  tonight's charge plan (Rivian): plug 1 plugged in, soc %, lim charge limit %, amps, kwh wall kWh tonight,
//                                 h charge window hours, tgt target SoC %, sf 1 shortfall, wk 1 work day
//
// Missing numbers are left out of the object, never sent as null, to save bytes and parse work on the device.

export const PANEL_MAX_BYTES = 4096;
export const CACHE_MS = 15_000;
export const SOURCE_TIMEOUT_MS = 6_000;
export const LAST_GOOD_MAX_MS = 10 * 60_000;   // a failed source shows its last good copy (st=1) this long
export const INFLUX_FRESH_S = 5 * 60;          // Unraid points older than this make storage/network stale

export type Level = 'g' | 'a' | 'r';
export type Section = { ok: 0 | 1; st: 0 | 1; [k: string]: unknown };

// ---------- small helpers ----------

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const rnd = (v: unknown, d = 0): number | undefined => {
  const n = num(v);
  if (n === undefined) return undefined;
  const f = 10 ** d;
  return Math.round(n * f) / f;
};
const str = (v: unknown, max = 16): string => String(v ?? '').slice(0, max);
const compact = <T extends Record<string, unknown>>(o: T): T => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

// ---------- Flux annotated CSV (Influx /api/v2/query) ----------

export type FluxRow = Record<string, string>;

// Tables are separated by blank lines; each starts with its own header row; "#..." lines are annotations.
export function parseFluxCsv(text: string): FluxRow[] {
  const rows: FluxRow[] = [];
  let header: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { header = null; continue; }
    if (line.startsWith('#')) continue;
    const cells = splitCsv(line);
    if (!header) { header = cells; continue; }
    const r: FluxRow = {};
    header.forEach((h, i) => { if (h) r[h] = cells[i] ?? ''; });
    rows.push(r);
  }
  return rows;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// ---------- storage (Influx unraid_disk + unraid_array) ----------

const DISK_FIELDS = new Set(['fs_size_kb', 'fs_used_kb', 'fs_free_kb', 'spinning', 'temp_c']);
const ARRAY_FIELDS = new Set(['state', 'parity_running', 'parity_progress', 'parity_errors', 'notif_unread_alert', 'notif_unread_warning']);

// rows: last() of each field per series, as FluxRow (_measurement, _field, _value, _time, name, role).
export function parseStorage(rows: FluxRow[], nowS: number): Section {
  const disks = new Map<string, { role: string; f: Record<string, number> }>();
  const arr: Record<string, string | number> = {};
  let newest = 0;
  for (const r of rows) {
    const t = Date.parse(r._time ?? '') / 1000;
    if (Number.isFinite(t) && t > newest) newest = t;
    if (r._measurement === 'unraid_disk' && DISK_FIELDS.has(r._field)) {
      const key = r.name || '?';
      const d = disks.get(key) ?? { role: r.role || '', f: {} };
      const v = Number(r._value);
      if (Number.isFinite(v)) d.f[r._field] = v;
      disks.set(key, d);
    } else if (r._measurement === 'unraid_array' && ARRAY_FIELDS.has(r._field)) {
      arr[r._field] = r._field === 'state' ? (r._value ?? '') : Number(r._value);
    }
  }
  if (!disks.size && !Object.keys(arr).length) return { ok: 0, st: 0 };
  const list = [...disks.entries()].map(([name, d]) => {
    const size = d.f.fs_size_kb, used = d.f.fs_used_kb;
    return compact({
      n: str(name, 8),
      r: d.role === 'cache' ? 'c' : d.role === 'parity' ? 'p' : 'd',
      u: size && used !== undefined ? Math.round((used / size) * 100) : undefined,
      sp: d.f.spinning === undefined ? undefined : d.f.spinning ? 1 : 0,
      t: rnd(d.f.temp_c),
      _sz: size, _us: used,
    });
  }).sort((a, b) => a.n.localeCompare(b.n, undefined, { numeric: true }));
  mergeCachePool(list);
  // Parity holds no files: leave it out of the capacity total.
  let s = 0, u = 0;
  for (const d of list) {
    if (d.r !== 'p') { s += (d._sz as number | undefined) ?? 0; u += (d._us as number | undefined) ?? 0; }
    delete (d as Record<string, unknown>)._sz; delete (d as Record<string, unknown>)._us;
  }
  const kbToGb = (kb: number) => Math.round(kb / 1_000_000);
  return {
    ok: 1,
    st: newest && nowS - newest > INFLUX_FRESH_S ? 1 : 0,
    ...compact({
      tot: { s: kbToGb(s), u: kbToGb(u) },
      d: list,
      spin: list.filter((d) => d.sp === 1).length,
      nd: list.length,
      arr: typeof arr.state === 'string' && arr.state ? str(arr.state, 12) : undefined,
      par: arr.parity_running === undefined ? undefined : arr.parity_running ? 1 : 0,
      pp: rnd(arr.parity_progress),
      pe: rnd(arr.parity_errors),
      na: rnd(arr.notif_unread_alert),
      nwn: rnd(arr.notif_unread_warning),
    }),
  };
}

// Unraid reports each SSD of a pool as its own disk, but only the first carries the pool's size and use. Show the
// pool as one "cache" row: use % from the members that report size, hottest member's temp, spinning if any is.
type DiskRow = { n: string; r: string; u?: number; sp?: number; t?: number; _sz?: unknown; _us?: unknown };
function mergeCachePool(list: DiskRow[]): void {
  const members = list.filter((d) => d.r === 'c');
  if (members.length < 2) return;
  let sz = 0, us = 0;
  for (const m of members) if (typeof m._sz === 'number' && typeof m._us === 'number') { sz += m._sz; us += m._us; }
  const temps = members.map((m) => m.t).filter((t): t is number => t !== undefined);
  const spin = members.map((m) => m.sp).filter((x): x is number => x !== undefined);
  const pool = compact({
    n: 'cache', r: 'c',
    u: sz ? Math.round((us / sz) * 100) : undefined,
    sp: spin.length ? (spin.some((x) => x === 1) ? 1 : 0) : undefined,
    t: temps.length ? Math.max(...temps) : undefined,
    _sz: sz || undefined, _us: sz ? us : undefined,
  }) as DiskRow;
  const at = list.indexOf(members[0]);
  for (let i = list.length - 1; i >= 0; i--) if (list[i].r === 'c') list.splice(i, 1);
  list.splice(at, 0, pool);
}

// ---------- network ----------

// network-bandwidth-monitor /api/fw_wan_rates: [{ iface, name, rx_mbps, tx_mbps }]
export function parseWan(body: unknown): Section {
  if (!Array.isArray(body)) return { ok: 0, st: 0 };
  const l = body.flatMap((r: Record<string, unknown>) => {
    const d = num(r.rx_mbps), u = num(r.tx_mbps);
    if (d === undefined && u === undefined) return [];
    return [compact({ n: str(String(r.name ?? r.iface ?? '').replace(/ WAN$/, ''), 10), d: rnd(d, 1), u: rnd(u, 1) })];
  });
  return l.length ? { ok: 1, st: 0, src: 'wan', l } : { ok: 0, st: 0 };
}

// Fallback: Unraid's own traffic, Influx unraid_net last() rx_bps / tx_bps per iface (bits/s).
export function parseUnraidNet(rows: FluxRow[], nowS: number): Section {
  const by = new Map<string, { d?: number; u?: number }>();
  let newest = 0;
  for (const r of rows) {
    if (r._measurement !== 'unraid_net') continue;
    const t = Date.parse(r._time ?? '') / 1000;
    if (Number.isFinite(t) && t > newest) newest = t;
    const v = Number(r._value);
    if (!Number.isFinite(v)) continue;
    const e = by.get(r.iface) ?? {};
    if (r._field === 'rx_bps') e.d = v / 1e6;
    else if (r._field === 'tx_bps') e.u = v / 1e6;
    by.set(r.iface, e);
  }
  const main = by.get('br0') ?? [...by.values()][0];
  if (!main) return { ok: 0, st: 0 };
  return { ok: 1, st: newest && nowS - newest > INFLUX_FRESH_S ? 1 : 0, src: 'unraid', l: [compact({ n: 'Unraid', d: rnd(main.d, 1), u: rnd(main.u, 1) })] };
}

// ---------- Darkbloom (bloom-ledger) ----------

export interface BloomInputs {
  live: unknown;                                   // GET /v1/live
  alerts: unknown;                                 // GET /v1/alerts
  earned?: Record<string, { day?: number; month?: number }>;   // cents per machine id, from /v1/accounting/summary
}

export function parseBloom(inp: BloomInputs): Section {
  const mac = (inp.live as { mac?: unknown })?.mac;
  if (!Array.isArray(mac)) return { ok: 0, st: 0 };
  const alerts = Array.isArray(inp.alerts) ? (inp.alerts as Record<string, unknown>[]) : [];
  const silent = new Set(alerts.filter((a) => a.alert === 'machine-silent').map((a) => String(a.machine_id)));
  let anyStale = false;
  const m = mac.map((r: Record<string, unknown>) => {
    const id = String(r.machine_id ?? '?');
    const e = inp.earned?.[id];
    if (r.stale === true) anyStale = true;
    const state = typeof r.darkbloom_state === 'string' ? r.darkbloom_state : '';
    return compact({
      n: str(id, 12),
      on: /serv|run|online|active/i.test(state) && !silent.has(id) ? 1 : 0,
      s: str(state, 12) || undefined,
      w: rnd(r.watts),
      jobs: rnd(r.sandbox_jobs),
      td: e?.day,
      tm: e?.month,
      age: rnd(r.age_s),
      sl: silent.has(id) ? 1 : undefined,
    });
  });
  return { ok: 1, st: anyStale ? 1 : 0, m, al: alerts.length };
}

// /v1/accounting/summary?period=day|month&machine=ID -> cents earned. totals.earned_micro is millionths of a dollar.
export function earnedCents(summary: unknown): number | undefined {
  const micro = num((summary as { totals?: { earned_micro?: unknown } })?.totals?.earned_micro);
  return micro === undefined ? undefined : Math.round(micro / 10_000);
}

// ---------- EV plan ----------

export interface EvInput {
  plugged?: boolean | null; soc?: number | null; limit?: number | null;
  amps?: number | null; kwh?: number | null; windowHours?: number | null; targetPct?: number | null;
  shortfall?: boolean | null; isWork?: boolean | null;
}
export function parseEv(i: EvInput | null): Section {
  if (!i) return { ok: 0, st: 0 };
  return {
    ok: 1, st: 0,
    ...compact({
      plug: i.plugged == null ? undefined : i.plugged ? 1 : 0,
      soc: rnd(i.soc), lim: rnd(i.limit), amps: rnd(i.amps), kwh: rnd(i.kwh, 1), h: rnd(i.windowHours, 1), tgt: rnd(i.targetPct),
      sf: i.shortfall ? 1 : undefined, wk: i.isWork == null ? undefined : i.isWork ? 1 : 0,
    }),
  };
}

// ---------- alert level ----------

export const CACHE_AMBER_PCT = 80;
export const CACHE_RED_PCT = 90;

// go: the section the panel jumps to on red ("bl" Darkbloom, "sd" storage), from the first red reason.
export function alertLevel(sec: { bl: Section; nw: Section; sd: Section; ev: Section }): { lvl: Level; why: string[]; go?: string } {
  const red: string[] = [], amber: string[] = [];
  let go: string | undefined;
  const bl = sec.bl as Section & { m?: { n: string; sl?: number }[]; al?: number };
  for (const m of bl.m ?? []) if (m.sl) { red.push(`silent:${m.n}`); go ??= 'bl'; }
  if (bl.ok && (bl.al ?? 0) > 0 && !red.length) amber.push(`bloom:${bl.al}`);
  const sd = sec.sd as Section & { arr?: string; pe?: number; na?: number; nwn?: number; d?: { n: string; r?: string; u?: number }[] };
  if (sd.ok) {
    const n = red.length;
    if (sd.arr && sd.arr.toUpperCase() !== 'STARTED') red.push(`array:${sd.arr}`);
    if ((sd.pe ?? 0) > 0) red.push('parity:err');
    const cache = (sd.d ?? []).find((d) => d.r === 'c' && d.u !== undefined);
    if (cache && (cache.u ?? 0) >= CACHE_RED_PCT) red.push(`cache:${cache.u}%`);
    if ((sd.na ?? 0) > 0) red.push(`unraid:${sd.na}!`);
    else if ((sd.nwn ?? 0) > 0) amber.push(`unraid:${sd.nwn}w`);
    if (cache && (cache.u ?? 0) >= CACHE_AMBER_PCT && (cache.u ?? 0) < CACHE_RED_PCT) amber.push(`cache:${cache.u}%`);
    const full = (sd.d ?? []).find((d) => d.r !== 'c' && (d.u ?? 0) >= 95);
    if (full) amber.push(`full:${full.n}`);
    if (red.length > n) go ??= 'sd';
  }
  const nw = sec.nw as Section & { l?: { d?: number; u?: number }[] };
  if (nw.ok && nw.src === 'wan' && (nw.l ?? []).length && (nw.l ?? []).every((x) => (x.d ?? 0) < 0.01 && (x.u ?? 0) < 0.01)) amber.push('wan:idle');
  if ((sec.ev as Section & { sf?: number }).sf) amber.push('ev:short');
  for (const k of ['bl', 'nw', 'sd', 'ev'] as const) {
    if (!sec[k].ok) amber.push(`src:${k}`);
    else if (sec[k].st) amber.push(`old:${k}`);
  }
  if (red.length) return { lvl: 'r', why: [...red, ...amber].slice(0, 3), ...(go ? { go } : {}) };
  if (amber.length) return { lvl: 'a', why: amber.slice(0, 3) };
  return { lvl: 'g', why: [] };
}

// ---------- aggregator ----------

export type SourceFn = () => Promise<Section>;
export interface Sources { bl: SourceFn; nw: SourceFn; sd: SourceFn; ev: SourceFn }

export interface PanelBody {
  v: 1; t: number; lvl: Level; why: string[]; go?: string;
  bl: Section; nw: Section; sd: Section; ev: Section;
}

export interface AggOpts {
  nowMs?: number;
  timeoutMs?: number;
  lastGood?: Map<string, { at: number; sec: Section }>;   // survives across calls (route keeps one)
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

// Run every source in parallel with its own timeout. A source that throws, times out or returns ok=0 shows its last
// good copy marked st=1 for up to LAST_GOOD_MAX_MS, else { ok:0 }.
export async function buildPanel(src: Sources, opts: AggOpts = {}): Promise<PanelBody> {
  const nowMs = opts.nowMs ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const good = opts.lastGood ?? new Map();
  const keys = ['bl', 'nw', 'sd', 'ev'] as const;
  const out = await Promise.all(keys.map(async (k): Promise<Section> => {
    let sec: Section;
    try { sec = await withTimeout(src[k](), timeoutMs); } catch { sec = { ok: 0, st: 0 }; }
    if (sec.ok) { good.set(k, { at: nowMs, sec }); return sec; }
    const g = good.get(k);
    if (g && nowMs - g.at <= LAST_GOOD_MAX_MS) return { ...g.sec, st: 1 };
    return { ok: 0, st: 0 };
  }));
  const [bl, nw, sd, ev] = out;
  const { lvl, why, go } = alertLevel({ bl, nw, sd, ev });
  return { v: 1, t: Math.floor(nowMs / 1000), lvl, why, ...(go ? { go } : {}), bl, nw, sd, ev };
}

// A 15 s cache around buildPanel; concurrent requests share one in-flight build.
export function makePanelCache(src: Sources, ttlMs = CACHE_MS, now: () => number = Date.now) {
  const lastGood = new Map<string, { at: number; sec: Section }>();
  let at = 0;
  let body: string | null = null;
  let inflight: Promise<string> | null = null;
  return async function get(): Promise<string> {
    if (body && now() - at < ttlMs) return body;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const b = await buildPanel(src, { nowMs: now(), lastGood });
        body = JSON.stringify(b);
        at = now();
        return body;
      } finally { inflight = null; }
    })();
    return inflight;
  };
}
