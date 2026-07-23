#!/bin/sh
# Register a Tesla Fleet Telemetry config with Tesla's Fleet API.
# This tells Tesla "send these signals to my server."
#
# Run AFTER you've:
#   1. Generated certs (gen-telemetry-certs.sh)
#   2. Created a Cloudflare Tunnel public hostname for tesla-telemetry.<domain>
#      pointing to http://<host>:50051 (no Access mTLS — Plan A)
#   3. Paired the partner virtual key to the vehicle via BLE:
#      open https://tesla.com/_ak/<your-domain> on a phone near the car
#      and approve in the Tesla mobile app
#
# Usage:
#   TESLA_VIN=5YJ... TELEMETRY_HOST=tesla-telemetry.penndalton.com \
#     sh scripts/register-telemetry.sh
set -eu

KEYS_DIR="${KEYS_DIR:-$(pwd)/keys}"
VIN="${TESLA_VIN:?Set TESLA_VIN to your vehicle VIN}"
HOST="${TELEMETRY_HOST:?Set TELEMETRY_HOST to e.g. tesla-telemetry.penndalton.com}"
TOKENS_FILE="$KEYS_DIR/tokens.json"
CLIENT_CRT="$KEYS_DIR/tesla-client.crt"
CLIENT_KEY="$KEYS_DIR/tesla-client.key"
CA_CRT="$KEYS_DIR/tesla-ca.crt"

for f in "$TOKENS_FILE" "$CLIENT_CRT" "$CLIENT_KEY" "$CA_CRT"; do
  [ -f "$f" ] || { echo "Missing: $f"; exit 1; }
done

ACCESS_TOKEN=$(jq -r '.access_token' "$TOKENS_FILE")
if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
  echo "No access_token in $TOKENS_FILE"; exit 1
fi

# Build the telemetry config payload. The fields below mirror what
# server/telemetry-server.js knows how to decode — add more as needed.
# interval_seconds: 30 means "send updates at most every 30s when changing"
# `ca` is the CA chain Tesla uses to validate OUR server's TLS cert during the
# data push. We go through Cloudflare Tunnel, which presents a publicly-issued
# cert (not our self-signed CA) — an empty string here used to be accepted as
# "fall back to Tesla's default public trust store", but Tesla's API now
# rejects "" with "ca is not a valid PEM". Fetch the actual chain Cloudflare
# presents for $HOST and pass the intermediate+root (everything but the leaf)
# as the CA bundle instead.
CA_CHAIN=$(echo | openssl s_client -connect "$HOST:443" -servername "$HOST" -showcerts 2>/dev/null \
  | awk '/-----BEGIN CERTIFICATE-----/{n++} n>1' )
if [ -z "$CA_CHAIN" ]; then
  echo "Could not fetch TLS chain for $HOST:443 — check the tunnel is up and reachable from this container"
  exit 1
fi

# `client_cert` is the cert Tesla would PRESENT to us for mTLS — without
# Cloudflare Access mTLS in Plan A we don't validate it, but the field is
# required by the API so we still send it.
PAYLOAD=$(jq -n \
  --arg vin "$VIN" \
  --arg host "$HOST" \
  --arg ca "$CA_CHAIN" \
  --rawfile client_cert "$CLIENT_CRT" \
  '{
    vins: [$vin],
    config: {
      hostname: $host,
      port: 443,
      ca: $ca,
      client_cert: $client_cert,
      fields: {
        Soc:                 { interval_seconds: 60 },
        ChargeLimitSoc:      { interval_seconds: 300 },
        DetailedChargeState: { interval_seconds: 30 },
        TimeToFullCharge:    { interval_seconds: 60 },
        RatedRange:          { interval_seconds: 300 },
        Odometer:            { interval_seconds: 600 },
        Locked:              { interval_seconds: 60 },
        Gear:                { interval_seconds: 30 }
      }
    }
  }')

echo "→ Registering telemetry config for $VIN → $HOST"
echo "$PAYLOAD" | jq '.config.fields | keys' >/dev/null  # sanity

# Route through the tesla-http-proxy running locally. The proxy signs the
# request with our partner private key and forwards to Tesla's Fleet API.
# -k because the proxy uses a self-signed cert (localhost only — safe).
PROXY_URL="${PROXY_URL:-https://localhost:4443}"

RESPONSE=$(curl -sS -k -X POST \
  "$PROXY_URL/api/1/vehicles/fleet_telemetry_config" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

echo "→ Response:"
echo "$RESPONSE" | jq . || echo "$RESPONSE"

echo ""
echo "If the response shows updated_vehicles including your VIN, telemetry is active."
echo "Watch for incoming data:  docker logs ev-dashboard-ev-dashboard-1 2>&1 | grep telemetry"
