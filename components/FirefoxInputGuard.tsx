'use client';

import { useEffect } from 'react';

// Defensive Firefox-only guard for password-manager/autofill interference,
// ported from resell-tracker (same "typing a digit replaces the last one"
// bug in Firefox). No site login exists here, so unlike resell-tracker's
// guard, every input/textarea is tagged including the Rivian email/password
// fields on /admin — those are third-party creds we don't want Firefox's
// own autofill heuristics grabbing mid-keystroke either.
export default function FirefoxInputGuard() {
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!/Firefox/i.test(navigator.userAgent)) return;

    function tagInput(el: HTMLInputElement | HTMLTextAreaElement) {
      if (el.dataset.allowPasswordManager === 'true') return;
      if (el.dataset.pmGuarded === '1') return;

      el.dataset.pmGuarded = '1';
      if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
      el.setAttribute('data-1p-ignore', 'true');
      el.setAttribute('data-lpignore', 'true');
      if (!el.getAttribute('data-form-type')) el.setAttribute('data-form-type', 'other');
    }

    function scan() {
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach(tagInput);
    }

    scan();

    const observer = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of Array.from(m.addedNodes)) {
          if (node instanceof HTMLElement && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.querySelector?.('input, textarea'))) {
            scan();
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
