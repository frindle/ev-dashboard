import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_MAX_BYTES, LAST_GOOD_MAX_MS, alertLevel, buildPanel, earnedCents, makePanelCache, parseBloom, parseEv, parseFluxCsv,
  parseStorage, parseUnraidNet, parseWan, type Section, type Sources,
} from './panelFeed.ts';

const NOW = Date.parse('2026-11-12T20:00:00Z');
const iso = (agoS: number) => new Date(NOW - agoS * 1000).toISOString();

// made-up Influx annotated CSV (two tables, annotation lines, blank line between tables)
const csv = (rows: [string, string, string, string, string, string][]) =>
  '#datatype,string,long,dateTime:RFC3339,string,string,string,string\n#group,false,false,false,true,true,true,true\n' +
  ',result,table,_time,_measurement,_field,_value,name,role\n' +
  rows.map((r, i) => `,_result,${i},${r[0]},${r[1]},${r[2]},${r[3]},${r[4]},${r[5]}`).join('\n') + '\n\n';

const DISK_ROWS: [string, string, string, string, string, string][] = [
  [iso(30), 'unraid_disk', 'fs_size_kb', '8000000000', 'disk1', 'data'],
  [iso(30), 'unraid_disk', 'fs_used_kb', '6000000000', 'disk1', 'data'],
  [iso(30), 'unraid_disk', 'spinning', '0', 'disk1', 'data'],
  [iso(30), 'unraid_disk', 'temp_c', '31', 'disk1', 'data'],
  [iso(30), 'unraid_disk', 'fs_size_kb', '8000000000', 'parity', 'parity'],
  [iso(30), 'unraid_disk', 'fs_used_kb', '8000000000', 'parity', 'parity'],
  [iso(30), 'unraid_disk', 'spinning', '1', 'parity', 'parity'],
  [iso(30), 'unraid_disk', 'fs_size_kb', '1000000000', 'cache', 'cache'],
  [iso(30), 'unraid_disk', 'fs_used_kb', '250000000', 'cache', 'cache'],
  [iso(30), 'unraid_array', 'state', 'STARTED', '', ''],
  [iso(30), 'unraid_array', 'parity_running', '0', '', ''],
  [iso(30), 'unraid_array', 'parity_errors', '0', '', ''],
  [iso(30), 'unraid_array', 'notif_unread_alert', '0', '', ''],
];

test('parseFluxCsv skips annotations and handles multiple tables and quotes', () => {
  const rows = parseFluxCsv(csv(DISK_ROWS.slice(0, 2)) + ',result,table,_time,_value\n,_r,0,t,"a,b"\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[0]._field, 'fs_size_kb');
  assert.equal(rows[2]._value, 'a,b');
});

test('storage: percent used, parity left out of the total, spinning count, array state', () => {
  const s = parseStorage(parseFluxCsv(csv(DISK_ROWS)), Math.floor(NOW / 1000)) as Record<string, any>;
  assert.equal(s.ok, 1);
  assert.equal(s.st, 0);
  assert.deepEqual(s.tot, { s: 9000, u: 6250 });
  assert.equal(s.nd, 3);
  assert.equal(s.spin, 1); // only parity is spinning
  assert.equal(s.arr, 'STARTED');
  const d1 = s.d.find((d: any) => d.n === 'disk1');
  assert.deepEqual([d1.r, d1.u, d1.sp, d1.t], ['d', 75, 0, 31]);
  assert.equal(s.d.find((d: any) => d.n === 'cache').r, 'c');
  assert.ok(!('t' in s.d.find((d: any) => d.n === 'cache'))); // missing numbers are left out
});

test('storage: old Influx points mark the section stale; no rows means ok=0', () => {
  const old = DISK_ROWS.map((r) => [iso(3600), ...r.slice(1)] as typeof r);
  assert.equal(parseStorage(parseFluxCsv(csv(old)), Math.floor(NOW / 1000)).st, 1);
  assert.equal(parseStorage([], 0).ok, 0);
});

test('network: WAN rows, " WAN" suffix trimmed, rounded; junk gives ok=0; Unraid fallback uses br0 in Mbps', () => {
  const w = parseWan([{ iface: 'eth0', name: 'Cox WAN', rx_mbps: 312.4567, tx_mbps: 11.04 }, { iface: 'x', name: 'Starlink WAN', rx_mbps: 90, tx_mbps: 8 }]) as any;
  assert.deepEqual(w.l, [{ n: 'Cox', d: 312.5, u: 11 }, { n: 'Starlink', d: 90, u: 8 }]);
  assert.equal(w.src, 'wan');
  assert.equal(parseWan({ error: 1 }).ok, 0);
  assert.equal(parseWan([]).ok, 0);
  const rows = [
    { _time: iso(10), _measurement: 'unraid_net', _field: 'rx_bps', _value: '50000000', iface: 'br0' },
    { _time: iso(10), _measurement: 'unraid_net', _field: 'tx_bps', _value: '2000000', iface: 'br0' },
    { _time: iso(10), _measurement: 'unraid_net', _field: 'rx_bps', _value: '1', iface: 'docker0' },
  ];
  const u = parseUnraidNet(rows, Math.floor(NOW / 1000)) as any;
  assert.deepEqual([u.src, u.l[0].d, u.l[0].u, u.st], ['unraid', 50, 2, 0]);
});

const LIVE = { at: 1, mac: [
  { machine_id: 'studio-m4', ts: 1, age_s: 60, stale: false, watts: 143.26, darkbloom_state: 'serving', sandbox_jobs: 0 },
  { machine_id: 'studio-m5', ts: 1, age_s: 5000, stale: true, watts: null, darkbloom_state: 'offline', sandbox_jobs: null },
] };

test('bloom: serving state, watts, earnings, silent machines from alerts; earned_micro to cents', () => {
  const s = parseBloom({
    live: LIVE,
    alerts: [{ alert: 'machine-silent', machine_id: 'studio-m5', age_s: 5000 }],
    earned: { 'studio-m4': { day: 523, month: 11890 } },
  }) as any;
  assert.equal(s.ok, 1);
  assert.equal(s.st, 1); // one machine's power minute is stale
  assert.deepEqual(s.m[0], { n: 'studio-m4', on: 1, s: 'serving', w: 143, jobs: 0, td: 523, tm: 11890, age: 60 });
  assert.deepEqual([s.m[1].on, s.m[1].sl, 'w' in s.m[1]], [0, 1, false]);
  assert.equal(s.al, 1);
  assert.equal(earnedCents({ totals: { earned_micro: 5_230_000 } }), 523);
  assert.equal(earnedCents({}), undefined);
  assert.equal(parseBloom({ live: { error: 'x' }, alerts: [] }).ok, 0);
});

test('ev: plan fields, missing ones left out; null gives ok=0', () => {
  const e = parseEv({ plugged: true, soc: 61.4, limit: 80, amps: 24, kwh: 18.26, windowHours: 7.5, targetPct: 78, shortfall: false, isWork: true }) as any;
  assert.deepEqual([e.plug, e.soc, e.lim, e.amps, e.kwh, e.h, e.tgt, e.wk, 'sf' in e], [1, 61, 80, 24, 18.3, 7.5, 78, 1, false]);
  assert.equal(parseEv(null).ok, 0);
});

const ok = (extra: Record<string, unknown> = {}): Section => ({ ok: 1, st: 0, ...extra });
const down = (): Section => ({ ok: 0, st: 0 });

function fakeSources(over: Partial<Record<'bl' | 'nw' | 'sd' | 'ev', () => Promise<Section>>> = {}): Sources {
  return {
    bl: async () => ok({ m: [{ n: 'a', on: 1 }], al: 0 }),
    nw: async () => ok({ src: 'wan', l: [{ n: 'Cox', d: 10, u: 1 }] }),
    sd: async () => ok({ arr: 'STARTED', d: [{ n: 'disk1', u: 50 }] }),
    ev: async () => ok({ plug: 1 }),
    ...over,
  };
}

test('aggregator: all ok is green with every section present', async () => {
  const p = await buildPanel(fakeSources(), { nowMs: NOW });
  assert.deepEqual([p.v, p.t, p.lvl, p.why], [1, Math.floor(NOW / 1000), 'g', []]);
  assert.ok([p.bl, p.nw, p.sd, p.ev].every((s) => s.ok === 1 && s.st === 0));
});

test('aggregator: one source down shows ok=0 for it only and the level goes amber', async () => {
  const p = await buildPanel(fakeSources({ nw: async () => { throw new Error('boom'); } }), { nowMs: NOW });
  assert.equal(p.nw.ok, 0);
  assert.ok(p.bl.ok && p.sd.ok && p.ev.ok);
  assert.deepEqual([p.lvl, p.why], ['a', ['src:nw']]);
});

test('aggregator: a slow source times out without holding the others back', async () => {
  const t0 = Date.now();
  const p = await buildPanel(fakeSources({ sd: () => new Promise<Section>(() => {}) }), { nowMs: NOW, timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(p.sd.ok, 0);
  assert.equal(p.bl.ok, 1);
});

test('aggregator: a failing source shows its last good copy as stale for a while, then ok=0', async () => {
  const lastGood = new Map();
  await buildPanel(fakeSources(), { nowMs: NOW, lastGood });
  const failing = fakeSources({ ev: async () => { throw new Error('x'); } });
  const p1 = await buildPanel(failing, { nowMs: NOW + 60_000, lastGood });
  assert.deepEqual([p1.ev.ok, p1.ev.st, (p1.ev as any).plug], [1, 1, 1]);
  assert.deepEqual([p1.lvl, p1.why], ['a', ['old:ev']]);
  const p2 = await buildPanel(failing, { nowMs: NOW + LAST_GOOD_MAX_MS + 1000, lastGood });
  assert.equal(p2.ev.ok, 0);
});

test('alert level: red for a silent Mac, a stopped array, parity errors or an unread Unraid alert; amber for the rest', () => {
  const g = { bl: ok({ m: [], al: 0 }), nw: ok({ src: 'wan', l: [{ d: 5, u: 1 }] }), sd: ok({ arr: 'STARTED', d: [] }), ev: ok() };
  assert.equal(alertLevel(g).lvl, 'g');
  assert.deepEqual(alertLevel({ ...g, bl: ok({ m: [{ n: 'm4', sl: 1 }], al: 1 }) }), { lvl: 'r', why: ['silent:m4'] });
  assert.equal(alertLevel({ ...g, sd: ok({ arr: 'STOPPED' }) }).lvl, 'r');
  assert.equal(alertLevel({ ...g, sd: ok({ arr: 'STARTED', pe: 2 }) }).lvl, 'r');
  assert.equal(alertLevel({ ...g, sd: ok({ arr: 'STARTED', na: 1 }) }).lvl, 'r');
  assert.equal(alertLevel({ ...g, sd: ok({ arr: 'STARTED', nwn: 1 }) }).lvl, 'a');
  assert.equal(alertLevel({ ...g, sd: ok({ arr: 'STARTED', d: [{ n: 'disk3', u: 96 }] }) }).lvl, 'a');
  assert.equal(alertLevel({ ...g, bl: ok({ m: [], al: 1 }) }).lvl, 'a'); // ring snapshot stale
  assert.equal(alertLevel({ ...g, nw: ok({ src: 'wan', l: [{ d: 0, u: 0 }] }) }).lvl, 'a');
  assert.equal(alertLevel({ ...g, ev: ok({ sf: 1 }) }).lvl, 'a');
  assert.ok(alertLevel({ ...g, bl: ok({ m: [{ n: 'a', sl: 1 }, { n: 'b', sl: 1 }], al: 2 }), sd: ok({ arr: 'STOPPED' }), ev: down() }).why.length <= 3);
});

test('body stays under 4 KB with a worst-case realistic load', async () => {
  const disks = Array.from({ length: 14 }, (_, i) => ({ n: `disk${i + 1}`, r: 'd', u: 88, sp: 1, t: 34 }));
  const p = await buildPanel(fakeSources({
    sd: async () => ok({ tot: { s: 110000, u: 90000 }, d: disks, spin: 14, nd: 14, arr: 'STARTED', par: 1, pp: 55, pe: 0, na: 0, nwn: 0 }),
    bl: async () => ok({ m: [0, 1, 2, 3].map((i) => ({ n: `studio-machine-${i}`, on: 1, s: 'serving', w: 180, jobs: 2, td: 12345, tm: 456789, age: 120 })), al: 0 }),
    nw: async () => ok({ src: 'wan', l: [{ n: 'Cox', d: 912.3, u: 41.2 }, { n: 'Starlink', d: 210.5, u: 18.9 }] }),
    ev: async () => ok({ plug: 1, soc: 55, lim: 80, amps: 32, kwh: 21.4, h: 7.5, tgt: 80, sf: 0, wk: 1 }),
  }), { nowMs: NOW });
  assert.ok(JSON.stringify(p).length < PANEL_MAX_BYTES, String(JSON.stringify(p).length));
});

test('cache: serves one body for 15 s, shares an in-flight build, rebuilds after the ttl', async () => {
  let calls = 0;
  let clock = NOW;
  const get = makePanelCache(fakeSources({ ev: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return ok({ plug: 1 }); } }), 15_000, () => clock);
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  clock += 14_000;
  await get();
  assert.equal(calls, 1);
  clock += 2_000;
  await get();
  assert.equal(calls, 2);
});
