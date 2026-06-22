#!/bin/sh
# Register a Tesla Fleet Telemetry config with Tesla's Fleet API.
# This tells Tesla "send these signals to my server."
#
# Run AFTER you've:
#   1. Generated certs (gen-telemetry-certs.sh)
#   2. Uploaded tesla-ca.crt to Cloudflare → Zero Trust → Access → Service Auth → Mutual TLS
#   3. Created a Cloudflare Access app for tesla-telemetry.<your-domain>
#   4. Verified the tunnel routes that hostname to the dashboard container :50051
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
PAYLOAD=$(jq -n \
  --arg vin "$VIN" \
  --arg host "$HOST" \
  --rawfile client_cert "$CLIENT_CRT" \
  --rawfile ca_cert "$CA_CRT" \
  '{
    vins: [$vin],
    config: {
      hostname: $host,
      port: 443,
      ca: $ca_cert,
      client_cert: $client_cert,
      fields: {
        Soc:                  { interval_seconds: 60 },
        Location:             { interval_seconds: 60 },
        ChargingState:        { interval_seconds: 30 },
        DetailedChargeState:  { interval_seconds: 30 },
        ChargeLimitSoc:       { interval_seconds: 300 },
        ChargeRateMilePerHour:{ interval_seconds: 30 },
        TimeToFullCharge:     { interval_seconds: 30 },
        ChargerActualCurrent: { interval_seconds: 30 },
        ChargerVoltage:       { interval_seconds: 30 },
        RatedRange:           { interval_seconds: 300 },
        Odometer:             { interval_seconds: 600 },
        Locked:               { interval_seconds: 30 },
        HvacACEnabled:        { interval_seconds: 30 },
        Gear:                 { interval_seconds: 30 }
      }
    }
  }')

echo "→ Registering telemetry config for $VIN → $HOST"
echo "$PAYLOAD" | jq '.config.fields | keys' >/dev/null  # sanity

RESPONSE=$(curl -sS -X POST \
  "https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles/fleet_telemetry_config" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

echo "→ Response:"
echo "$RESPONSE" | jq . || echo "$RESPONSE"

echo ""
echo "If the response shows updated_vehicles including your VIN, telemetry is active."
echo "Watch for incoming data:  docker logs ev-dashboard-ev-dashboard-1 2>&1 | grep telemetry"
