// Run: node --experimental-strip-types --test lib/chargeSessionInflux.test.ts
// (Node >= 22.6; no node_modules needed, the module under test only has
// type imports.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_LINES, influxTarget, mirrorSessionToInflux, sessionLine, sessionLines, vehicleIdResolver, writeLines,
} from './chargeSessionInflux.ts';

const CFG = {
  vehicles: {
    rivian: { name: 'R1S', model: 'R1S', chargerSide: 'LEFT', email: '', password: '' },
    tesla: { name: 'Model Y', model: 'Y', chargerSide: 'RIGHT', vin: '', pollingEnabled: true },
  },
} as any;

const ENV = { INFLUX_URL: 'http://influx:8086/', INFLUX_TOKEN: 'tok', INFLUX_ORG: 'home org', INFLUX_BUCKET: 'ev&b' };

function row(over: Record<string, unknown> = {}): any {
  return {
    side: 'LEFT', vehicleName: 'R1S', startedAt: '2026-11-01T06:00:00.000Z', endedAt: '2026-11-01T10:30:00.000Z',
    durationMin: 270, energyKwh: 42.5, ...over,
  };
}

function fakeFetch(statuses: number[] = []) {
  const calls: { url: string; init: any }[] = [];
  const impl = async (url: string, init: any) => {
    calls.push({ url, init });
    const status = statuses[calls.length - 1] ?? 204;
    return { ok: status < 300, status, text: async () => 'x'.repeat(400) };
  };
  return { calls, impl };
}

test('sessionLine: measurement, tags, float fields, ms timestamp', () => {
  assert.equal(
    sessionLine(row(), 'rivian'),
    'ev_charge_session,side=LEFT,vehicle=rivian energy_kwh=42.5,duration_min=270 1793512800000',
  );
  // Integer values stay floats in line protocol (no `i` suffix).
  assert.match(sessionLine(row({ energyKwh: 40, durationMin: 1 }), 'tesla')!, / energy_kwh=40,duration_min=1 /);
});

test('sessionLine: skips unplaceable rows, falls back for duration', () => {
  assert.equal(sessionLine(row({ startedAt: 'nope' }), 'rivian'), null);
  assert.equal(sessionLine(row({ side: 'MIDDLE' }), 'rivian'), null);
  assert.equal(sessionLine(row({ energyKwh: null }), 'rivian'), null);
  assert.equal(sessionLine(row({ energyKwh: -1 }), 'rivian'), null);
  assert.equal(sessionLine(row({ energyKwh: 'abc' }), 'rivian'), null);
  assert.equal(sessionLine(null as any, 'rivian'), null);
  assert.match(sessionLine(row({ energyKwh: '12.25' }), 'rivian')!, / energy_kwh=12.25,/);
  assert.match(sessionLine(row({ durationMin: undefined }), 'rivian')!, / energy_kwh=42.5,duration_min=270 /);
  assert.match(sessionLine(row({ durationMin: NaN, endedAt: 'bad' }), 'rivian')!, / energy_kwh=42.5 1793512800000$/);
});

test('vehicleIdResolver: name, then side, then unknown', () => {
  const idFor = vehicleIdResolver(CFG);
  assert.equal(idFor({ vehicleName: 'R1S', side: 'RIGHT' }), 'rivian');
  assert.equal(idFor({ vehicleName: 'Model Y', side: 'LEFT' }), 'tesla');
  assert.equal(idFor({ vehicleName: 'Renamed', side: 'RIGHT' }), 'tesla');
  assert.equal(idFor({ vehicleName: 'Renamed', side: 'LEFT' }), 'rivian');
  assert.equal(vehicleIdResolver(null)({ vehicleName: 'R1S', side: 'LEFT' }), 'unknown');
});

test('sessionLines: counts, skips, first/last', () => {
  const rows = [
    row({ startedAt: '2026-10-02T01:00:00Z' }),
    row({ side: 'RIGHT', vehicleName: 'Model Y', startedAt: '2026-09-01T01:00:00Z' }),
    row({ startedAt: 'garbage' }),
    null as any,
    row({ side: 'RIGHT', vehicleName: '?', startedAt: '2026-11-05T01:00:00Z' }),
  ];
  const out = sessionLines(rows, vehicleIdResolver(CFG));
  assert.equal(out.lines.length, 3);
  assert.equal(out.skipped, 2);
  assert.deepEqual(out.byVehicle, { rivian: 1, tesla: 2 });
  assert.equal(out.first, '2026-09-01T01:00:00.000Z');
  assert.equal(out.last, '2026-11-05T01:00:00.000Z');
  assert.deepEqual(sessionLines([], vehicleIdResolver(CFG)), { lines: [], skipped: 0, byVehicle: {}, first: null, last: null });
});

test('influxTarget: needs all four vars, trims one trailing slash, encodes org/bucket', () => {
  for (const k of Object.keys(ENV)) assert.equal(influxTarget({ ...ENV, [k]: '' }), null, k);
  const t = influxTarget(ENV)!;
  assert.equal(t.url, 'http://influx:8086/api/v2/write?org=home%20org&bucket=ev%26b&precision=ms');
  assert.equal(t.headers.Authorization, 'Token tok');
  assert.equal(t.headers['Content-Type'], 'text/plain; charset=utf-8');
});

test('writeLines: batches, and a failed batch throws status + truncated body', async () => {
  const target = influxTarget(ENV)!;
  const lines = Array.from({ length: BATCH_LINES * 2 + 1 }, (_, i) => `m v=${i} ${i}`);
  const ok = fakeFetch();
  assert.equal(await writeLines(lines, target, ok.impl), lines.length);
  assert.deepEqual(ok.calls.map((c) => c.init.body.split('\n').length), [BATCH_LINES, BATCH_LINES, 1]);
  assert.equal(ok.calls[0].init.method, 'POST');

  const bad = fakeFetch([204, 400]);
  await assert.rejects(writeLines(lines, target, bad.impl), (e: Error) => {
    assert.match(e.message, /HTTP 400 after 5000 lines: x{300}$/);
    assert.doesNotMatch(e.message, /tok/);
    return true;
  });
  assert.equal(bad.calls.length, 2);
});

test('mirrorSessionToInflux: never throws, false when unconfigured/unplaceable/failed', async () => {
  const idFor = vehicleIdResolver(CFG);
  const f = fakeFetch();
  assert.equal(await mirrorSessionToInflux(row(), idFor, ENV, f.impl), true);
  assert.equal(f.calls[0].init.body, 'ev_charge_session,side=LEFT,vehicle=rivian energy_kwh=42.5,duration_min=270 1793512800000');
  assert.equal(await mirrorSessionToInflux(row(), idFor, {}, f.impl), false);
  assert.equal(await mirrorSessionToInflux(row({ startedAt: 'x' }), idFor, ENV, f.impl), false);
  assert.equal(f.calls.length, 1);
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(await mirrorSessionToInflux(row(), idFor, ENV, fakeFetch([500]).impl), false);
    assert.equal(await mirrorSessionToInflux(row(), idFor, ENV, async () => { throw new Error('ECONNREFUSED'); }), false);
  } finally {
    console.error = origError;
  }
});
