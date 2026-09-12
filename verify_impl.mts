// Adversarial behavioural fixture for: ev-influx-write-request
//
// >>> THE ONE THING THE GENERATOR CANNOT WRITE FOR YOU <<<
//
// The case list is EMPTY and this verify FAILS (SCAFFOLD_INCOMPLETE) until you author >= 3
// real cases below. Deliberate: a generator can emit a verify that
// DISCRIMINATES (red at baseline, green on a fix); it cannot decide whether the
// verify is RELEVANT -- whether it tests the property the task asked for. A
// benign case (flag=true, count=99) passes broken work.
//
// This harness imports the REAL exported buildInfluxWriteRequest from ./server/telemetry-influx.js and drives
// it. RUN IT UNDER `tsx` (verify.sh does): tsx strips the types and resolves
// the extensionless / `.ts` import that bare `node` CANNOT type-strip through
// a dynamic or static import. A linked git worktree also has no node_modules of
// its own -- verify.sh symlinks the source repo's in; if that is missing, tsx
// will not resolve and the import throws.
//
// Author inputs that separate "did the job" from "made the test go green":
//   - the boundary, and one input on each side of it;
//   - the degenerate inputs (null / missing key / wrong type) that must NOT throw;
//   - at least one input a plausible WRONG fix would get wrong; and
//   - >>> an OVER-TRIGGER GUARD <<< : a case proving the change does NOT fire
//     when it must not -- the real-charging input that must STAY charging, the
//     valid record that must NOT be rejected. A one-directional fix that breaks
//     the opposite direction is the single most common wrong fix; pin it.

// Guarded dynamic import: this is a CREATION task, so at baseline the export
// does not exist. A static named import would throw SyntaxError at module
// instantiation (crash) before any case runs; the dynamic form lets the fixture
// FAIL BY REPORTING instead, which is what the gate's both-ways proof needs.
const __mod: any = await import('./server/telemetry-influx.js');
const fn: any = __mod.buildInfluxWriteRequest;
if (typeof fn !== 'function') {
  console.log('FAIL - buildInfluxWriteRequest not exported (baseline / unimplemented)');
  console.log('--- 1 failed ---');
  process.exit(1);
}

let fails = 0;
let checks = 0;
const chk = (name: string, cond: boolean) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

// --- fixture helpers -------------------------------------------------------
// buildInfluxWriteRequest(state, opts) -> {url,method,headers,body} | null.
// Valid opts need influxUrl + influxToken; body is produced by
// pointsToLineProtocol(buildTelemetryPoints(state,{vacationMode,ts})).
const validOpts = (o: Record<string, unknown> = {}) => ({
  influxUrl: 'http://influx.local',
  influxToken: 'tok-123',
  influxOrg: 'ev',
  influxBucket: 'telemetry',
  ...o,
} as any);

// --- adversarial cases -----------------------------------------------------

// 1. POSITIVE -- the thing the fix must start doing: compose a full write request.
{
  const r = fn({ batterySoc: 80 }, validOpts());
  chk('positive -> returns an object (not null)', r !== null);
  chk('positive -> method is POST', !!r && r.method === 'POST');
  chk('positive -> url path + org/bucket/precision query',
    !!r && r.url === 'http://influx.local/api/v2/write?org=ev&bucket=telemetry&precision=ms');
  chk('positive -> Authorization "Token <token>" header',
    !!r && r.headers['Authorization'] === 'Token tok-123');
  chk('positive -> Content-Type text/plain; charset=utf-8',
    !!r && r.headers['Content-Type'] === 'text/plain; charset=utf-8');
  chk('positive -> body is line protocol with measurement + field',
    !!r && typeof r.body === 'string' && r.body.includes('ev_telemetry') && r.body.includes('batterySoc=80'));
}

// 2. BOUNDARY -- "trims ONE trailing slash": one side and the other side of it.
{
  const one = fn({ a: 1 }, validOpts({ influxUrl: 'http://x/' }));
  chk('boundary -> single trailing slash trimmed',
    !!one && one.url === 'http://x/api/v2/write?org=ev&bucket=telemetry&precision=ms');
  const two = fn({ a: 1 }, validOpts({ influxUrl: 'http://x//' }));
  chk('boundary -> only ONE of two trailing slashes trimmed (not greedy)',
    !!two && two.url === 'http://x//api/v2/write?org=ev&bucket=telemetry&precision=ms');
}

// 3. SAFETY / NO-EVIDENCE -- missing url or token: must return null, not guess/throw.
{
  chk('no influxUrl -> null', fn({ a: 1 }, { influxToken: 't' }) === null);
  chk('no influxToken -> null', fn({ a: 1 }, { influxUrl: 'http://x' }) === null);
}

// 4. EMPTY BODY -- valid url+token but nothing serializable -> null (not an empty POST).
{
  chk('empty state object -> null body -> null request', fn({}, validOpts()) === null);
}

// 5. DEGENERATE INPUTS -- must NOT throw; all resolve to null.
{
  chk('null state -> null, no throw', fn(null, validOpts()) === null);
  chk('undefined opts -> null, no throw', fn({ a: 1 }, undefined) === null);
  chk('non-object (string) state -> null, no throw', fn('junk', validOpts()) === null);
}

// 6. OVER-TRIGGER GUARD -- vacationMode must drop location leaves; without it they stay.
{
  const vac = fn({ soc: 50, lat: 12.3, lon: 45.6 }, validOpts({ vacationMode: true }));
  chk('vacationMode -> lat/lon dropped from body',
    !!vac && !vac.body.includes('lat') && !vac.body.includes('lon'));
  const noVac = fn({ soc: 50, lat: 12.3, lon: 45.6 }, validOpts());
  chk('no vacationMode -> lat/lon kept in body',
    !!noVac && noVac.body.includes('lat=12.3') && noVac.body.includes('lon=45.6'));
}

// 7. REGRESSION -- secret-named keys are scrubbed from the body (buildTelemetryPoints intact).
{
  const r = fn({ soc: 42, apiToken: 'leak' }, validOpts());
  chk('secret key scrubbed from body', !!r && !r.body.includes('apiToken') && !r.body.includes('leak'));
}

// 8. REGRESSION -- ts is threaded through to the point timestamp in the body.
{
  const r = fn({ soc: 10 }, validOpts({ ts: 1700000000000 }));
  chk('ts threaded -> body ends with the ms timestamp', !!r && r.body.endsWith(' 1700000000000'));
}

// 9. REGRESSION -- org/bucket are URL-encoded (encodeURIComponent), not raw-concatenated.
{
  const r = fn({ a: 1 }, validOpts({ influxOrg: 'my org', influxBucket: 'b&c' }));
  chk('org/bucket URL-encoded in query string',
    !!r && r.url.includes('org=my%20org') && r.url.includes('bucket=b%26c'));
}

// Structural floor -- matches the Python/Swift `>= 3` discipline. Deleting the
// guard above with zero chk() calls would otherwise leave fails=0 and go green
// (a vacuous verify). Nothing enforces a case count for us, so count here.
if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
