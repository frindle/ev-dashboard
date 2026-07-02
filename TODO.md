# TODO

## Active — session 2026-07-01

### Rivian — expand GraphQL query with new fields
Add to `lib/rivian.ts` `GetVehicleState` query: `gnssLocation`, `gnssSpeed`, `gnssAltitude`, `wiperFluidState`, `brakeFluidLow`, `tirePressureStatusFrontLeft`, `tirePressureStatusFrontRight`, `tirePressureStatusRearLeft`, `tirePressureStatusRearRight`, `otaCurrentVersionNumber`, `otaAvailableVersionNumber`, `otaStatus`, `otaCurrentStatus`, `batteryHvThermalEvent`, `batteryHvThermalEventPropagation`. Expose in the returned `RivianVehicleState` shape.

### Rivian — log all new fields incl. thermal + derate
Append to the `[rivian]` diagnostic log line: `chargerDerateStatus`, `batteryHvThermalEvent`, `batteryHvThermalEventPropagation`, `wiperFluidState`, `brakeFluidLow`, `tirePressureStatus*`, `gnssError`. Goal: capture the exact strings when charging is derated / handle-temp warning fires.

### Rivian — GNSS-based home detection
Use `gnssLocation` when the timestamp is <15 min old and `gnssError` is low; fall back to the last-known cached coord otherwise. Reuse the 150 m home radius from the Tesla path. Log the same `[home] rivian: lat=… home=… dist=…m radius=…m → atHome=…` line as Tesla so both cars appear side-by-side in the log.

### Rivian — 90-day proactive re-auth scheduler
Rivian tokens are session-based (no documented refresh mutation). Track `rivian_tokens_issued_at`; when we hit day 83, set a `rivian_reauth_due_soon` flag; at day 90, set `rivian_reauth_required` flag. Dashboard banner (design incoming). Pushover push at day 83.

### Rivian — session-expiry detection on 401
Catch 401 responses from the GraphQL gateway → set `rivian_reauth_required` → banner + Pushover.

### Rivian — exponential backoff on API errors
Per community guidance: retry cadence 15 → 30 → 60 → 120 → 240 min on consecutive failures. Reset on first success. Applies to state-poll only; not to interactive command calls.

### Rivian — OTA update-available badge + Pushover
Small badge on the Rivian card when `otaAvailableVersionNumber != otaCurrentVersionNumber` (design incoming). Pushover push the first time we see a new available version (dedupe by version number so we don't spam every poll).

### Rivian — wire warning card for derate + thermal events (design incoming)
User will import the card design. Data source: any non-empty `chargerDerateStatus` OR `batteryHvThermalEvent` non-empty. Once real values captured in log, refine copy per specific string.

### Rivian — update api-docs/Rivian/api.md
Append the full field list from RivDocs (`https://rivian-api.kaedenb.org/app/vehicle-info/vehicle-state/`) including WS subscription endpoint, rate-limit backoff strategy, 90-day session assumption.

### Tesla — log refresh failure reason (not silent catch)
In `lib/tesla.ts` `refreshAccessToken`: replace silent `catch {}` with `console.warn('[tesla] refresh failed:', status, body.slice(0,200))`. Also log successful refresh at info level.

### Tesla — "reauth needed" dashboard banner
When `refreshAccessToken` returns null OR we get a 401 from a Fleet API call, set a `tesla_reauth_required` flag surfaced on the dashboard. Pushover push once per lapse (not per call).

### Tesla — redo OAuth with `vehicle_location`
Not code — user action. Current `scp` is `openid vehicle_device_data energy_device_data offline_access`. Need to re-run authorize flow with the enlarged scope list so token grants `vehicle_location`. Virtual key skipped for now (commands still work through legacy path; only GPS blocked).

### Tesla — scope-editable authorize starter (if needed)
Confirm whether current admin bootstrap hard-codes the scope list. If so, add editable input so user can request the enlarged scope set from the dashboard without touching env.

---

## Tesla Fleet Telemetry — virtual key pairing (at the car)

**Status:** Telemetry config registration is failing with `missing_key`. The
infrastructure (proxy, scripts, mTLS-skipping pivot, Cloudflare tunnel route)
is all built and deployed; the last step is a one-time BLE pairing that has
to happen physically at the vehicle.

### Why this is needed

Tesla requires the vehicle to have our partner public key enrolled before
it will accept signed commands or push telemetry. This is a one-time pair
operation done over Bluetooth — the same way you'd add a phone key. Without
it, the `fleet_telemetry_config` endpoint returns:

```json
"skipped_vehicles": { "missing_key": ["5YJ3E1EA3PF609276"] }
```

### Pairing steps (do this when next at the Tesla)

Requirements:
- Phone with the Tesla mobile app installed
- Signed in as the vehicle owner
- Within Bluetooth range of the Tesla (~30 ft)

1. On the phone, open this URL in a browser:

   ```
   https://tesla.com/_ak/ev-dashboard.penndalton.com
   ```

2. It should deep-link into the Tesla app and show an "Add Virtual Key"
   prompt for "Home EV Dashboard".
3. Approve the prompt — walk closer to the car if BLE doesn't connect
   immediately. The car will confirm with a soft chime / dashboard
   notification when the key is paired.
4. If the link doesn't deep-link, open the Tesla app manually:
   **Security → Locks → Add Key → Other** and paste the URL when prompted.

### After pairing — finish telemetry setup

```bash
docker exec -e TESLA_VIN=5YJ3E1EA3PF609276 \
            -e TELEMETRY_HOST=tesla-telemetry.penndalton.com \
            ev-dashboard-ev-dashboard-1 \
            sh scripts/register-telemetry.sh
```

Expected response: `updated_vehicles: 1` listing your VIN. Then watch
for incoming push data:

```bash
docker logs -f ev-dashboard-ev-dashboard-1 2>&1 | grep telemetry
```

You'll see `[telemetry] connection from ...` once the car wakes and starts
streaming. The dashboard's smart-poll will automatically prefer telemetry
data over API polls when fresh (`source: 'telemetry'`).

### Bonus: this also fixes future commands

This same virtual-key pairing enables our existing direct commands
(lock/unlock, charge_start/stop, climate, set_charge_limit) to keep
working as Tesla deprecates the legacy unsigned command endpoints.
Tesla's vehicle-command HTTP proxy (running as a sidecar in our
container) will sign commands with our paired key once enrolled.

---

## Tesla `vehicle_location` scope — blocked by Tesla

**Status:** Tesla refuses to grant `vehicle_location` despite the scope being
enabled on the developer.tesla.com app. Token-level scope inspection (`scp`
claim in the JWT) consistently shows only the legacy four scopes regardless
of OAuth flow attempts (re-auth, incognito, scope toggle on/off, app revoke).

The dashboard's home-detection still works via the polling path
(`drive_state` in `vehicle_data` — covered by our existing `vehicle_device_data`
scope). Telemetry registration excludes `Location` until this is resolved.

### When you want to fix it

1. File a Tesla developer support ticket asking why `vehicle_location` is
   not being granted on app client ID `b4a07679-8597-452d-a7c0-8a6a6b632c42`
   despite being enabled in the scope settings.
2. When resolved, add `Location` back to `scripts/register-telemetry.sh`:

   ```sh
   Location: { interval_seconds: 60 },
   ```

3. Re-register telemetry.

---

## Display hardware decision

iPad works fine if it's healthy (Guided Access + Safari fullscreen, kiosk mode).
If/when it needs replacing:

- [ ] **Recommended:** Raspberry Pi 4 (4 GB) + 10.1" touch display kit (GeeekPi
  or ELECROW, ~$180-220 on Amazon). Install FullPageOS — boots straight into
  a fullscreen Chromium tab pointing at the dashboard. Zero-touch after setup.
- [ ] Pi Zero / Zero 2 W is **not** powerful enough — Chromium chokes on the
  dashboard's animated SVGs and gradients with 512 MB RAM
- [ ] Pi 5 works too but is overkill; Pi 4 is the sweet spot

## Storage layout (optional, when convenient)

- [ ] Mount `CHARGE_HISTORY_DIR` to an Unraid array path so the
  charge-history.jsonl + charge-sessions.json files live on the array, not
  the cache pool. Add to docker-compose:
  ```yaml
  environment:
    - CHARGE_HISTORY_DIR=/charge-history
  volumes:
    - /mnt/user/<your-array-path>:/charge-history
  ```
  Without this, history files default to KEYS_DIR (currently appdata/keys).

## Future / nice-to-have

- [ ] **ratgdo** integration when the hardware is installed (replaces MyQ).
  See [project_ev_dashboard](../README.md) — server-side stubs are intact
  so the dashboard re-enables the garage button automatically once a working
  source is wired up.
- [ ] **Camera stream URL** in admin once camera is set up — dashboard already
  reads `data.streamUrl` from config and renders it in the modal
- [ ] **Rivian commands** (lock/unlock/climate) — requires BLE-paired phone
  key pair, similar to Tesla's pairing requirement
- [ ] **Refine Rivian throttle reasons** once we see real `chargerDerateStatus`
  values in production — currently displayed verbatim with underscores
  replaced by spaces. May want to map specific reason codes to friendly text
  (e.g. `battery_too_cold` → `Battery cold`)
- [ ] **Wall connector "in use" detection** — currently uses
  `state===1 || power>100W`. If we see false positives/negatives once Tesla
  is also charging, refine the heuristic
