// Runs once when the Next.js server boots (standalone server.js included —
// confirmed supported since this container's Next 15). Keeps Rivian/Tesla
// state polling even with zero browser tabs open, which is the whole point
// of running this in an always-on container instead of relying on a client
// tab to drive it. Self-calls the existing /api/dashboard route so all of
// its smart-poll caching, throttle backoff, and api-calls.jsonl logging
// stays untouched — this just triggers it on a timer instead of on a
// client's 30s interval.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const port = process.env.PORT || '3000';
  const url = `http://127.0.0.1:${port}/api/dashboard`;
  const POLL_MS = 30_000;

  const poll = () => { fetch(url, { cache: 'no-store' }).catch(() => {}); };

  // Give the HTTP server a moment to finish binding before the first self-call.
  setTimeout(() => {
    poll();
    setInterval(poll, POLL_MS);
  }, 5000);
}
