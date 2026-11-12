// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/nveImport.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccumulator, createNveFileParser, dailyPeakLines, dailyPeaks, evKwDuring, intervalLines,
  intervalMinutes, sessionSpans, sortedIntervals, summarize,
} from './nveImport.ts';

const IH = 'Name,Address,Account #,CUSTOMER CODE,PREMISE CODE,MeterID,ServiceType,channelNumber,powerFlow,unit,intervalLength,TimeZone,startTime,endTime,Startdate,Start Time,End Date,End Time,TIME OF USE,Read Type,Usage,Day of the week,Hour of the day,Cost';
const DH = 'Name,Address,Account #,MeterID,Premise ID,ServiceType,channelNumber,powerFlow,unit,intervalLength,TimeZone,startTime,endTime,Startdate,Start Time,End Date,End Time,TIME OF USE,readingStatusCode,value,';
const PII = '"Test Person","123 Fake St, Apt 4, Springfield, ST 00000",9990001,CUST42,PREM77,METER55';

function irow(ch: number, flow: string, unit: string, start: string, status: string, usage: number) {
  const d = start.slice(0, 10), t = start.slice(11);
  return `${PII},Electric,${ch},${flow},${unit},PT15M,PacificUS,${start},${d} 00:00:00,${d},${t},${d},${t},WINTER,${status},${usage},Wed,00,`;
}
function drow(start: string, status: string, value: number) {
  return `"Test Person","123 Fake St, Apt 4, Springfield, ST 00000",9990001,METER55,PREM77,Electric,5,Delivered,KW,PT15M,PacificUS,${start},${start},${start.slice(0, 10)},${start.slice(11)},${start.slice(0, 10)},${start.slice(11)},WINTER,${status},${value},`;
}

function parse(files: string[], chunk = 1000) {
  const acc = createAccumulator();
  for (const text of files) {
    const p = createNveFileParser(acc);
    for (let i = 0; i < text.length; i += chunk) p.push(text.slice(i, i + chunk));   // odd chunk size on purpose
    p.end();
  }
  return acc;
}

const iso = (s: string) => Date.parse(s);

test('interval file: channels 1 and 3, estimated flag, quoted address, PII never in output', () => {
  const csv = [IH,
    irow(1, 'Delivered', 'KWH_DEL', '2025-01-01 00:00:00', 'Actual', 3.5),
    irow(1, 'Delivered', 'KWH_DEL', '2025-01-01 00:15:00', 'Calculated', 2),
    irow(3, 'Received', 'KWH_REC', '2025-01-01 00:15:00', 'Actual', 0.25),
  ].join('\r\n') + '\r\n';
  const acc = parse([csv], 37);
  const list = sortedIntervals(acc);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { startMs: iso('2025-01-01T08:00:00Z'), importKwh: 3.5, exportKwh: null, importKw: null, estimated: false });
  assert.deepEqual(list[1], { startMs: iso('2025-01-01T08:15:00Z'), importKwh: 2, exportKwh: 0.25, importKw: null, estimated: true });
  assert.equal(intervalMinutes(acc), 15);
  const all = JSON.stringify([list, summarize(acc), intervalLines(list), dailyPeakLines(dailyPeaks(list, 15, []))]);
  assert.ok(!/Test Person|Fake|Springfield|9990001|CUST42|PREM77|METER55|Apt/.test(all), all);
  for (const r of list) assert.deepEqual(Object.keys(r).sort(), ['estimated', 'exportKwh', 'importKw', 'importKwh', 'startMs']);
});

test('demand file: channel 5 kW with trailing empty column; merges onto the interval rows', () => {
  const i = [IH, irow(1, 'Delivered', 'KWH_DEL', '2025-01-01 00:00:00', 'Actual', 3)].join('\n');
  const d = [DH, drow('2025-01-01 00:00:00', 'Calculated', 12.5)].join('\n');
  const acc = parse([i, d]);
  const [r] = sortedIntervals(acc);
  assert.equal(r.importKw, 12.5);
  assert.equal(r.importKwh, 3);
  assert.equal(r.estimated, true);
  assert.deepEqual(acc.files, { interval: 1, demand: 1 });
});

test('DST: fall-back repeats by row order; spring-forward is not a gap', () => {
  const rows = [IH];
  for (const t of ['00:45:00', '01:00:00', '01:15:00', '01:30:00', '01:45:00']) rows.push(irow(1, 'Delivered', 'KWH_DEL', '2025-11-02 ' + t, 'Actual', 1));
  for (const t of ['01:00:00', '01:15:00', '01:30:00', '01:45:00', '02:00:00']) rows.push(irow(1, 'Delivered', 'KWH_DEL', '2025-11-02 ' + t, 'Actual', 2));
  const list = sortedIntervals(parse([rows.join('\n')]));
  assert.equal(list.length, 10);                                   // nothing collapsed
  assert.equal(list[0].startMs, iso('2025-11-02T07:45:00Z'));      // 00:45 PDT
  assert.equal(list[1].startMs, iso('2025-11-02T08:00:00Z'));      // first 01:00 PDT
  assert.equal(list[5].startMs, iso('2025-11-02T09:00:00Z'));      // second 01:00 PST
  assert.equal(list[9].startMs, iso('2025-11-02T10:00:00Z'));      // 02:00 PST
  assert.equal(list[5].importKwh, 2);

  const spring = [IH,
    irow(1, 'Delivered', 'KWH_DEL', '2025-03-09 01:45:00', 'Actual', 1),
    irow(1, 'Delivered', 'KWH_DEL', '2025-03-09 03:00:00', 'Actual', 1)].join('\n');
  const s = parse([spring]);
  const l = sortedIntervals(s);
  assert.equal(l[1].startMs - l[0].startMs, 15 * 60_000);          // 01:45 PST -> 03:00 PDT
  assert.equal(summarize(s).missingDayCount, 0);
  const noSkip = [IH, irow(1, 'Delivered', 'KWH_DEL', '2025-03-09 02:30:00', 'Actual', 1)].join('\n');
  assert.throws(() => parse([noSkip]), /unparseable/);             // such a time cannot exist
});

test('summary: range, estimated, missing whole day, highest kW; bad files fail loudly', () => {
  const csv = [IH,
    irow(1, 'Delivered', 'KWH_DEL', '2025-01-01 18:00:00', 'Actual', 1),
    irow(1, 'Delivered', 'KWH_DEL', '2025-01-01 18:15:00', 'Calculated', 5),   // 20 kW
    irow(1, 'Delivered', 'KWH_DEL', '2025-01-04 09:00:00', 'Actual', 2),
  ].join('\n');
  const s = summarize(parse([csv]));
  assert.equal(s.from, '2025-01-01');
  assert.equal(s.to, '2025-01-04');
  assert.equal(s.intervals, 3);
  assert.equal(s.estimated, 1);
  assert.deepEqual(s.missingDays, ['2025-01-02', '2025-01-03']);
  assert.deepEqual(s.peak, { kw: 20, at: '2025-01-01 18:15' });
  assert.throws(() => parse(['a,b\n1,2']), /not an NV Energy/);
  assert.throws(() => parse(['']), /empty|not an NV/);
  assert.throws(() => parse([[IH, irow(1, 'Delivered', 'KWH_DEL', 'garbage', 'Actual', 1)].join('\n')]), /unparseable/);
});

test('re-upload gives identical lines; estimated is a 0/1 field, timestamp is UTC ms', () => {
  const csv = [IH, irow(1, 'Delivered', 'KWH_DEL', '2025-01-01 00:00:00', 'Calculated', 3.246), irow(3, 'Received', 'KWH_REC', '2025-01-01 00:00:00', 'Actual', 0.5)].join('\n');
  const a = intervalLines(sortedIntervals(parse([csv])));
  const b = intervalLines(sortedIntervals(parse([csv + '\n'], 5)));
  assert.deepEqual(a, b);
  assert.deepEqual(a, [`nve_interval import_kwh=3.246,export_kwh=0.5,estimated=1 ${iso('2025-01-01T08:00:00Z')}`]);
});

test('daily peaks: whole day, 08-24, 00-08, EV subtraction at the night peak', () => {
  // kWh per 15 min -> kW x4
  const rows = [IH];
  const put = (t: string, kwh: number) => rows.push(irow(1, 'Delivered', 'KWH_DEL', '2025-01-10 ' + t, 'Actual', kwh));
  put('01:00:00', 3);     // 12 kW
  put('02:00:00', 4);     // 16 kW  night peak
  put('07:45:00', 2);
  put('08:00:00', 1);
  put('19:00:00', 6);     // 24 kW  day + overall peak
  const list = sortedIntervals(parse([rows.join('\n')]));
  // EV: 11 kW charging 01:30-03:00 local covers the 02:00 interval fully
  const spans = sessionSpans([{ startedAt: '2025-01-10T09:30:00Z', endedAt: '2025-01-10T11:00:00Z', durationMin: 90, energyKwh: 16.5 }]);
  assert.equal(Math.round(spans[0].kw * 100) / 100, 11);
  const [p] = dailyPeaks(list, 15, spans);
  assert.equal(p.date, '2025-01-10');
  assert.equal(p.peakKw, 24); assert.equal(p.peakTime, '19:00');
  assert.equal(p.dayKw, 24);
  assert.equal(p.nightKw, 16); assert.equal(p.nightTime, '02:00');
  assert.equal(p.evKwAtNightPeak, 11);
  assert.equal(p.houseNightKw, 5);
  const [line] = dailyPeakLines([p]);
  assert.ok(line.startsWith('nve_daily_peak peak_kw=24,peak_time="19:00",intervals=5,day_peak_kw=24,day_peak_time="19:00",night_peak_kw=16,night_peak_time="02:00",ev_kw_at_night_peak=11,house_night_kw=5 '), line);
  assert.ok(line.endsWith(' ' + iso('2025-01-10T20:00:00Z')));     // local noon PST
});

test('evKwDuring weights partial overlap; demand kW wins over kWh-derived kW', () => {
  const start = iso('2025-01-10T10:00:00Z');
  assert.equal(evKwDuring(start, 15, [{ startMs: start - 3_600_000, endMs: start + 7.5 * 60_000, kw: 10 }]), 5);
  assert.equal(evKwDuring(start, 15, []), 0);
  const i = [IH, irow(1, 'Delivered', 'KWH_DEL', '2025-01-10 02:00:00', 'Actual', 1)].join('\n');
  const d = [DH, drow('2025-01-10 02:00:00', 'Actual', 7)].join('\n');
  const [p] = dailyPeaks(sortedIntervals(parse([i, d])), 15, []);
  assert.equal(p.peakKw, 7);
});

test('house night load never goes negative when the EV figure overshoots the meter', () => {
  const i = [IH, irow(1, 'Delivered', 'KWH_DEL', '2025-01-10 02:00:00', 'Actual', 2)].join('\n');  // 8 kW
  const spans = [{ startMs: iso('2025-01-10T09:00:00Z'), endMs: iso('2025-01-10T11:00:00Z'), kw: 11 }];
  const [p] = dailyPeaks(sortedIntervals(parse([i])), 15, spans);
  assert.equal(p.evKwAtNightPeak, 11);
  assert.equal(p.houseNightKw, 0);
});
