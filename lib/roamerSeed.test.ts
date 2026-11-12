// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/roamerSeed.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from './csv.ts';
import { pacificToMs, parseTimestamp } from './pacificTime.ts';
import { seedFromRoamer } from './roamerSeed.ts';

const DRIVE_HEADER = 'Started At (Pacific Time (US & Canada)),Ended At (Pacific Time (US & Canada)),Distance (mi),Avg Speed (mph),Max Speed (mph),RMS Speed (mph),Energy (kWh),Efficiency (mi/kWh),Estimated Cost ($),Price per kWh ($),Gas Equivalent Cost ($),Fuel Savings ($),Start Battery (%),End Battery (%),Start Odometer (mi),End Odometer (mi),Elevation Gain (ft),Elevation Loss (ft),Max Altitude (ft),Min Altitude (ft),Drive Mode,Driver Profile,Towing,Estimated Combined Mass (kg),Wheel/Tire Config,Start Location,End Location,Start Weather,Start Temperature (F),End Weather,End Temperature (F),Tags,Source,Corrupted';
const CHARGE_HEADER = 'Started At (Pacific Time (US & Canada)),Ended At (Pacific Time (US & Canada)),Energy (kWh),Pack (kWh),Thermal (kWh),Outlets (kWh),Systems (kWh),Charging Efficiency (%),Avg Power (kW),Peak Power (kW),Range Added (mi),Estimated Cost ($),Price per kWh ($),Gas Equivalent Cost ($),Fuel Savings ($),Start Battery (%),End Battery (%),Location,Charging Site,Network,Tags,Source,Corrupted';

// Made-up values; locations are quoted and contain commas on purpose.
function drive(start: string, end: string, miles: number, sb: number, eb: number, temp: string, bad = 'false'): string {
  return `${start},${end},${miles},30,55,32,5,2.5,0.5,0.1,3,2.5,${sb},${eb},9000,9010,10,12,2100,2000,Everyday,Penn,false,3000,Std,"123 Fake St, Springfield, ST","9 Test Ave, Shelbyville, ST",Sunny,${temp},Cloudy,60,"tag a, tag b",API,${bad}`;
}
function charge(start: string, end: string, kwh: number, sb: number, eb: number, bad = 'false'): string {
  return `${start},${end},${kwh},${kwh - 1},0,0,0,90,9.6,11.5,40,2,0.1,5,3,${sb},${eb},"Home, Garage",Home,None,,API,${bad}`;
}

const DRIVES = [
  DRIVE_HEADER,
  drive('2026-05-10 08:00:00', '2026-05-10 08:30:00', 12.4, 80, 74, '61'),
  drive('2026-05-11 17:00:00', '2026-05-11 17:45:00', 20, 74, 64, ''),
  drive('2026-05-11 18:00:00', '2026-05-11 18:05:00', 0.3, 64, 64, '60'),            // short
  drive('2026-05-11 19:00:00', '2026-05-11 19:30:00', 15, 64, 50, '60', 'true'),     // corrupted
  drive('2026-04-01 08:00:00', '2026-04-01 08:30:00', 10, 90, 85, '50'),             // before --since
].join('\n');
const CHARGES = [
  CHARGE_HEADER,
  charge('2026-05-09 01:00:00', '2026-05-09 06:00:00', 40, 40, 80),
  charge('2026-05-12 01:00:00', '2026-05-12 05:00:00', 30, 60, 80),
].join('\r\n');

test('parseCsv: quoted fields with commas, doubled quotes, CRLF, trailing empty column', () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3,\r\n'), [['a', 'b, c', 'say "hi"'], ['1', '2', '3', '']]);
  assert.deepEqual(parseCsv('a,b\n\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.throws(() => parseCsv('a,"open'), /unterminated/);
});

test('parseTimestamp: accepted forms and DST', () => {
  const ref = Date.parse('2026-05-06T21:03:22Z');                     // 14:03:22 PDT
  assert.equal(parseTimestamp('2026-05-06 14:03:22'), ref);
  assert.equal(parseTimestamp('2026-05-06T14:03:22'), ref);
  assert.equal(parseTimestamp('2026-05-06T21:03:22Z'), ref);
  assert.equal(parseTimestamp('2026-05-06T14:03:22-07:00'), ref);
  assert.equal(parseTimestamp('5/6/2026 2:03:22 PM'), ref);
  assert.equal(parseTimestamp('5/6/2026 2:03 PM'), ref - 22_000);
  assert.equal(parseTimestamp('5/6/2026 12:05 AM'), Date.parse('2026-05-06T07:05:00Z'));
  assert.equal(parseTimestamp('5/6/2026 12:05 PM'), Date.parse('2026-05-06T19:05:00Z'));
  assert.equal(parseTimestamp('2026-01-06 14:03'), Date.parse('2026-01-06T22:03:00Z'));   // PST
  for (const bad of ['', 'yesterday', '2026-05-06', '06.05.2026 14:03', '13/40/2026 1:00 PM', '5/6/2026 13:00 PM']) {
    assert.throws(() => parseTimestamp(bad), /unparseable/, bad);
  }
  assert.throws(() => parseTimestamp('2026-03-08 02:30:00'), /unparseable/);   // spring-forward gap
  assert.equal(pacificToMs(2025, 11, 2, 1, 15, 0, 0), Date.parse('2025-11-02T08:15:00Z'));  // PDT
  assert.equal(pacificToMs(2025, 11, 2, 1, 15, 0, 1), Date.parse('2025-11-02T09:15:00Z'));  // PST
});

test('seedFromRoamer: rows, filters, temp kept, nothing location-ish', () => {
  const r = seedFromRoamer(DRIVES, CHARGES, '2026-05-06');
  assert.equal(r.drives.length, 2);
  assert.deepEqual(r.skipped, { corrupted: 1, short: 1, incomplete: 0 });
  const d = r.drives[0];
  assert.equal(d.start, '2026-05-10T15:00:00.000Z');
  assert.equal(d.miles, 12.4);
  assert.equal(d.start_soc, 80);
  assert.equal(d.temp_f, 61);
  assert.equal(r.drives[1].temp_f, null);
  assert.equal(d.at_home, null);
  assert.equal(d.start_cell, null);
  const text = JSON.stringify(r.drives) + JSON.stringify(r.daily);
  assert.ok(!/Springfield|Shelbyville|Fake|Sunny|Cloudy|tag a|9000|9010|Penn|lat|lon|odometer|altitude/i.test(text), text);
});

test('seedFromRoamer: same daily-use split as the live log', () => {
  const r = seedFromRoamer(DRIVES, CHARGES, '2026-05-06');
  // charge ends May 9 06:00 at 80%, next starts May 12 01:00 at 60%: total 20; drives 6 + 10 = 16; parked 4 over May 9..12
  assert.deepEqual(r.daily.map((x) => x.date), ['2026-05-09', '2026-05-10', '2026-05-11', '2026-05-12']);
  assert.equal(r.daily[1].drive_pct, 6);
  assert.equal(r.daily[2].drive_pct, 10);
  assert.ok(r.daily.every((x) => x.parked_pct === 1 && !x.unknown));
  assert.equal(r.daily[2].used_pct, 11);
});

test('seedFromRoamer: no --since keeps older rows; bad timestamps and headers fail loudly', () => {
  assert.equal(seedFromRoamer(DRIVES, CHARGES, null).drives.length, 3);
  assert.throws(() => seedFromRoamer(DRIVE_HEADER + '\n' + drive('not a time', '2026-05-10 08:30:00', 5, 80, 70, '60'), CHARGES), /unparseable/);
  assert.throws(() => seedFromRoamer('Foo,Bar\n1,2', CHARGES), /missing column/);
});
