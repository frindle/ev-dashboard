// EV dashboard -> full-fidelity raw metrics export for InfluxDB/Telegraf ingestion.
// The dispatched task implements buildMetricsRawPayload + GET in THIS file only.
export const dynamic = 'force-dynamic';

export interface MetricsRawOpts {
  vacationMode: boolean;
}

// TODO(dispatch): merge the provided raw source objects into one payload.
// When opts.vacationMode is true, recursively remove all location keys
// (lat, lon, latitude, longitude, gps, location). ALWAYS remove secret-named
// keys (token, secret, password) regardless of vacationMode. Do NOT mutate inputs.
export function buildMetricsRawPayload(
  sources: Record<string, unknown>,
  opts: MetricsRawOpts,
): Record<string, unknown> {
  return {};
}

export async function GET() {
  // TODO(dispatch): read the raw keys/*.json dumps (rivian-state-debug.json,
  // rivian-state.json, tesla-state.json, rivian-parallax.json, last-status.json),
  // call buildMetricsRawPayload(sources, { vacationMode: readConfig().vacationMode }),
  // and return it as JSON.
  return new Response(JSON.stringify({}), {
    headers: { 'content-type': 'application/json' },
  });
}
