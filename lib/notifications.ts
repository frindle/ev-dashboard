import { sendPush } from './pushover';
import {
  shouldPushOncePerLapse, shouldPushDueSoonOnce, shouldPushOtaOnce,
  shouldPushThrottleOnce, clearRivianThrottleDedup,
} from './sessionFlags';

// Fired from the dashboard poll after flags are computed. Each event is
// deduped through a persisted stamp in session-flags.json, so a flag that
// stays raised across many poll cycles produces exactly one push.
export interface NotifyInput {
  teslaReauthRequired: boolean;
  teslaReauthReason: string | null;
  rivianReauthRequired: boolean;
  rivianReauthReason: string | null;
  rivianReauthDueSoon: boolean;
  rivianReauthDaysLeft: number | null;
  rivianOtaUpdateAvailable: boolean;
  rivianOtaAvailableVersion: string;
  teslaOtaUpdateAvailable: boolean;
  teslaOtaAvailableVersion: string;
  rivianThrottled: boolean;
  rivianThrottleReason: string | null;
}

export function notifyFlagChanges(n: NotifyInput): void {
  if (n.teslaReauthRequired && shouldPushOncePerLapse('tesla')) {
    void sendPush(
      'EV Dashboard — Tesla re-auth needed',
      `Tesla token refresh is failing (${n.teslaReauthReason ?? 'unknown reason'}). ` +
      'Open the admin panel and re-run the Tesla OAuth flow.',
      1,
    );
  }

  if (n.rivianReauthRequired && shouldPushOncePerLapse('rivian')) {
    void sendPush(
      'EV Dashboard — Rivian re-auth needed',
      `Rivian session is no longer valid (${n.rivianReauthReason ?? 'unknown reason'}). ` +
      'Open the admin panel and log in to Rivian again.',
      1,
    );
  } else if (n.rivianReauthDueSoon && shouldPushDueSoonOnce()) {
    void sendPush(
      'EV Dashboard — Rivian session expiring soon',
      `The Rivian session is ~${n.rivianReauthDaysLeft ?? '?'} day(s) from its 90-day limit. ` +
      'Re-login from the admin panel soon to avoid a gap in vehicle data.',
    );
  }

  if (n.rivianOtaUpdateAvailable && n.rivianOtaAvailableVersion &&
      shouldPushOtaOnce('rivian', n.rivianOtaAvailableVersion)) {
    void sendPush(
      'EV Dashboard — Rivian software update available',
      `Version ${n.rivianOtaAvailableVersion} is available for the Rivian.`,
    );
  }

  if (n.teslaOtaUpdateAvailable && n.teslaOtaAvailableVersion &&
      shouldPushOtaOnce('tesla', n.teslaOtaAvailableVersion)) {
    void sendPush(
      'EV Dashboard — Tesla software update available',
      `Version ${n.teslaOtaAvailableVersion} is available for the Tesla.`,
    );
  }

  if (n.rivianThrottled) {
    if (shouldPushThrottleOnce()) {
      void sendPush(
        'EV Dashboard — Rivian charging throttled',
        `Charge rate is being reduced (${n.rivianThrottleReason || 'reason unknown'}).`,
      );
    }
  } else {
    // Not throttled right now — clear the dedup stamp so the next
    // throttle event (a new lapse, not a continuation) pushes again.
    clearRivianThrottleDedup();
  }
}
