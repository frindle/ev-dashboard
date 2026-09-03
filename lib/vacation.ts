// Vacation Mode — privacy switch that force-hides all vehicle location data.
//
// When config.vacationMode is on, no viewer of the dashboard (kiosk, phone,
// anyone who can reach the page) should be able to tell where the vehicles
// are — OR even that location is being intentionally hidden, since that alone
// would reveal that the owner is away.
//
// This module is the single server-side redaction chokepoint: it strips every
// location-bearing field out of the assembled DashboardData BEFORE it leaves
// the server, so coordinates never sit in the network payload or in the
// persisted keys/last-status.json cache (which /api/dashboard/cached serves
// verbatim on page load). Because the redacted payload is byte-for-byte the
// same shape the app already produces when GPS is genuinely unavailable
// (coords null, atHome null, no extra flag), the existing client renders its
// ordinary "location unavailable" state with NO changes and NO vacation-
// specific UI — which is exactly the point: indistinguishable from a normal
// no-GPS reading.
//
// atHome is nulled too: whether a vehicle is home vs away is itself location
// information ("nobody's home") and is exactly what this switch must conceal —
// nulling it (rather than leaving "away") makes cards render the neutral
// home/idle state instead of an "away" status.

// State fields that reveal position, heading, or motion. Nulled on every
// vehicle's mapped state (TeslaVehicleState / RivianVehicleState). Kept as a
// plain list so both the live route and the cached route redact identically.
export const VACATION_LOCATION_STATE_KEYS = [
  'lat',
  'lon',
  'speedMph',        // Tesla — shown on the away/driving tile
  'gpsHeadingDeg',   // Tesla — heading arrow on the away tile
  'gnssTimeStamp',   // Rivian — "last GPS fix at"
  'gnssSpeedMph',    // Rivian
  'gnssAltitudeM',   // Rivian
  'gnssErrorM',      // Rivian
  'gnssBearingDeg',  // Rivian — heading arrow on the away tile
  '_locationUpdatedAt', // internal freshness stamp for Location telemetry
  '_gpsFresh',          // internal GPS-fresh flag
] as const;

// Loose internal view of the dashboard payload. The generic is unconstrained
// so this accepts both the typed DashboardData (live route) and a
// JSON.parse'd object (cached route) without either file importing the
// other's concrete types or tripping index-signature assignability.
type LooseState = Record<string, unknown>;
type LooseVehicle = { state?: LooseState | null; atHome?: unknown } & Record<string, unknown>;
type LooseDashboard = { vehicles?: LooseVehicle[]; flags?: Record<string, unknown> } & Record<string, unknown>;

// Returns a copy of the dashboard payload with all vehicle location data
// removed. Pure — does not mutate input.
//
// Crucially, the result is INDISTINGUISHABLE from an ordinary "no GPS fix"
// payload: coordinates are nulled and atHome is set to null (the same value
// the app produces when a vehicle's position is genuinely unknown). Nothing
// is added to mark the payload as redacted — no flag, no field — so a viewer
// inspecting the page or the network response cannot tell that location is
// being intentionally hidden (which would itself reveal that the owner is
// away). atHome is nulled rather than left as-is specifically so the UI does
// NOT show an "away" status, which would leak presence.
export function redactDashboardLocation<T>(data: T): T {
  const d = data as unknown as LooseDashboard;
  const vehicles = (d.vehicles ?? []).map((v) => {
    let state = v.state;
    if (state) {
      state = { ...state };
      for (const key of VACATION_LOCATION_STATE_KEYS) {
        if (key in state) state[key] = null;
      }
    }
    return { ...v, state, atHome: null };
  });
  return { ...d, vehicles } as unknown as T;
}

// Recursively null any object key whose name looks like location/position
// data. Used for the raw provider dumps at /api/admin/raw-state, whose shape
// is arbitrary (decoded Rivian FlatBuffer state, raw Tesla response bodies)
// so a key-name scrub is the only practical redaction there.
const RAW_LOCATION_KEY = /(^|_)(lat|latitude|lon|lng|longitude|gps|gnss|geo|coord|coordinate|location|position|bearing|heading|altitude|address)($|_|[A-Z])/;
export function scrubRawLocation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubRawLocation);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = RAW_LOCATION_KEY.test(k) ? null : scrubRawLocation(v);
    }
    return out;
  }
  return value;
}
