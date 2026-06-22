# TODO

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

## Future / nice-to-have

- **ratgdo** integration when the hardware is installed (replaces MyQ)
- **Camera stream URL** in admin once camera is set up — dashboard already
  reads `data.streamUrl` from config and renders it in the modal
- **Rivian commands** (lock/unlock/climate) — requires BLE-paired phone
  key pair, similar to Tesla
