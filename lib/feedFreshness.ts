// Single source of truth for the dashboard "API ERROR" pill debounce.
// A single transient /api/dashboard blip must not paint the scary flag —
// match the backend, which only alerts after 3 consecutive failures
// (lib/rivian.ts API_ERROR_ALERT_THRESHOLD).

export const FEED_ERROR_THRESHOLD = 3;

export function shouldShowFeedError(
  consecutiveFailures: number,
  threshold: number = FEED_ERROR_THRESHOLD,
): boolean {
  return consecutiveFailures >= threshold;
}
