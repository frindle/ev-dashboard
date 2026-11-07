// Run: node --experimental-strip-types --test lib/vehicleStateInflux.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVehicleStateRecorder, STATE_INTERVAL_MS, vehicleStateLine } from './vehicleStateInflux.ts';

const ENV = { INFLUX_URL: 'http://influx:8086', INFLUX_TOKEN: 'tok', INFLUX_ORG: 'home', INFLUX_BUCKET: 'metrics' };
const T0 = 1793512800000;

function riv(over: Record<string, unknown> = {}, atHome: boolean | null = true): any {
  return {
    id: 'rivian', atHome, lat: 1, lon: 2,
    state: { chargePercent: 48.6, chargeLimit: 70, odometer: 31829, rangeMi: 140, isPluggedIn: true, isCharging: false, online: true, lat: 1, lon: 2, ...over },
  };
}

function fakeFetch(statuses: number[] = []) {
  const calls: { url: string; init: any }[] = [];
  const impl = async (url: string, init: any) => {
    calls.push({ url, init });
    const status = statuses[calls.length - 1] ?? 204;
    return { ok: status < 300, status, text: async () => 'err' };
  };
  return { calls, impl };
}

test('vehicleStateLine: float fields, booleans as 0/1, no coordinates', () => {
  assert.equal(
    vehicleStateLine(riv(), T0),
    'ev_vehicle_state,vehicle=rivian soc=48.6,charge_limit=70,odometer=31829,range_mi=140,plugged_in=1,charging=0,online=1,at_home=1 1793512800000',
  );
  assert.doesNotMatch(vehicleStateLine(riv(), T0)!, /lat|lon/);
});

test('vehicleStateLine: skips unknown cars, null state, zero/non-finite values', () => {
  assert.equal(vehicleStateLine({ ...riv(), id: 'other' }, T0), null);
  assert.equal(vehicleStateLine({ id: 'tesla', state: null }, T0), null);
  assert.equal(vehicleStateLine({ id: 'tesla', state: {} }, T0), null);
  assert.equal(
    vehicleStateLine(riv({ chargePercent: 0, chargeLimit: NaN, odometer: undefined, rangeMi: -1, isCharging: 'yes' }, null), T0),
    'ev_vehicle_state,vehicle=rivian plugged_in=1,online=1 1793512800000',
  );
});

test('recorder: one batch for both cars, then throttled until interval or plug/charge change', async () => {
  const record = createVehicleStateRecorder();
  const f = fakeFetch();
  const tesla = { id: 'tesla', atHome: true, state: { chargePercent: 99.6, chargeLimit: 100, isPluggedIn: true, isCharging: false } };
  assert.equal(await record([riv(), tesla], T0, ENV, f.impl), 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.body.split('\n').length, 2);
  assert.match(f.calls[0].url, /bucket=metrics&precision=ms$/);
  assert.equal(await record([riv(), tesla], T0 + 60_000, ENV, f.impl), 0);
  assert.equal(await record([riv({ isCharging: true }), tesla], T0 + 120_000, ENV, f.impl), 1);
  assert.match(f.calls[1].init.body, /^ev_vehicle_state,vehicle=rivian .*charging=1/);
  assert.equal(await record([riv({ isCharging: true }), tesla], T0 + STATE_INTERVAL_MS, ENV, f.impl), 1); // tesla due
  assert.equal(f.calls.length, 3);
});

test('recorder: never throws; unconfigured writes nothing; a failed write is retried next poll', async () => {
  const record = createVehicleStateRecorder();
  const f = fakeFetch([500]);
  assert.equal(await record([riv()], T0, {}, f.impl), 0);
  assert.equal(f.calls.length, 0);
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(await record([riv()], T0, ENV, f.impl), 0);
    assert.equal(await record([riv()], T0 + 1000, ENV, async () => { throw new Error('ECONNREFUSED'); }), 0);
  } finally {
    console.error = origError;
  }
  assert.equal(await record([riv()], T0 + 2000, ENV, f.impl), 1);
  assert.equal(await record(null as any, T0 + 3000, ENV, f.impl), 0);
});

test('recorder: overlapping polls do not double-write', async () => {
  const record = createVehicleStateRecorder();
  let release!: () => void;
  const calls: string[] = [];
  const slow = async (_url: string, init: any) => {
    calls.push(init.body);
    await new Promise<void>((r) => { release = r; });
    return { ok: true, status: 204, text: async () => '' };
  };
  const first = record([riv()], T0, ENV, slow);
  assert.equal(await record([riv()], T0, ENV, slow), 0);
  release();
  assert.equal(await first, 1);
  assert.equal(calls.length, 1);
});
