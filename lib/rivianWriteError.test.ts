// Run: TZ=America/Los_Angeles node --experimental-strip-types --test lib/rivianWriteError.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubCoords, writeFailureReason } from './rivianWriteError.ts';

test('scrubCoords: latitude/longitude numbers go, other numbers stay', () => {
  const s = scrubCoords('bad {"latitude":36.123456,"longitude":-115.5,"amperage":8}');
  assert.ok(!/36\.12|115\.5/.test(s));
  assert.ok(s.includes('"amperage":8'));
  assert.ok(!/36\.12|115\.5/.test(scrubCoords('latitude: 36.1, lon=-115.2 lng : 3e1')));
});

test('scrubCoords: escaped quotes inside a stringified message', () => {
  const inner = JSON.stringify({ message: 'invalid {"latitude":36.987,"longitude":-115.123}' });
  const s = scrubCoords(inner);
  assert.ok(!s.includes('36.987') && !s.includes('115.123'));
});

test('writeFailureReason: GraphQL code, reason and message; scrubbed; capped at 200', () => {
  const e = new Error(JSON.stringify({
    message: 'Variable "$x" got {"latitude":36.5,"longitude":-115.5}', extensions: { code: 'BAD_REQUEST_ERROR', reason: 'INVALID_INPUT' },
  }));
  const r = writeFailureReason(e);
  assert.ok(r.startsWith('BAD_REQUEST_ERROR: INVALID_INPUT: '));
  assert.ok(!r.includes('36.5') && !r.includes('115.5'));
  assert.equal(writeFailureReason(new Error('x'.repeat(500))).length, 200);
  assert.equal(writeFailureReason(new Error('HTTP 502')), 'HTTP 502');
  assert.equal(writeFailureReason('plain'), 'plain');
});
