// Why a schedule write failed, in a form safe to log, store, push and put in Influx. Pure.
//
// Rivian's error text can echo the request variables, and the schedule's variables carry the
// home location, so every number next to a latitude/longitude key is scrubbed before the text
// goes anywhere.
const COORD_KEY = /\b(latitude|longitude|lat|lon|lng)([\\"']*\s*[:=]\s*[\\"']*)-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;
// Belt and braces: any bare decimal with 3+ places (a coordinate without its key).
const FINE_DECIMAL = /-?\b\d{1,3}\.\d{3,}\b/g;

export function scrubCoords(text: string): string {
  return text.replace(COORD_KEY, '$1$2[redacted]').replace(FINE_DECIMAL, '[redacted]');
}

export const REASON_MAX = 200;

// An Error from lib/rivian.ts gql() holds the first GraphQL error as JSON
// ({message, extensions: {code, reason}}); anything else is used as plain text.
export function writeFailureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let text = raw;
  try {
    const j = JSON.parse(raw) as { message?: unknown; extensions?: { code?: unknown; reason?: unknown } };
    if (j && typeof j === 'object') {
      const parts = [j.extensions?.code, j.extensions?.reason, j.message]
        .filter((x): x is string => typeof x === 'string' && x.length > 0);
      if (parts.length) text = [...new Set(parts)].join(': ');
    }
  } catch { /* not JSON */ }
  return scrubCoords(text).replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
}

export type WriteResult = { ok: true } | { ok: false; error: string };
