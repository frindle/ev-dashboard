#!/usr/bin/env bash
# One-time setup: generate the CA + client cert used for Tesla Fleet Telemetry mTLS.
#
# Output files in keys/:
#   tesla-ca.key      — CA private key (KEEP PRIVATE, never share)
#   tesla-ca.crt      — CA public cert (upload to Cloudflare → Zero Trust → Access → Service Auth → Mutual TLS)
#   tesla-client.key  — Client private key (uploaded to Tesla via Fleet API)
#   tesla-client.crt  — Client cert (uploaded to Tesla via Fleet API)
#
# Run from the project root:
#   bash scripts/gen-telemetry-certs.sh
set -euo pipefail

KEYS_DIR="${KEYS_DIR:-$(pwd)/keys}"
mkdir -p "$KEYS_DIR"
cd "$KEYS_DIR"

if [[ -f tesla-ca.crt ]]; then
  echo "tesla-ca.crt already exists in $KEYS_DIR"
  echo "Delete the existing cert files first if you really want to regenerate."
  exit 1
fi

echo "→ Generating CA private key..."
openssl genrsa -out tesla-ca.key 4096

echo "→ Generating self-signed CA certificate (10-year validity)..."
openssl req -x509 -new -nodes -key tesla-ca.key -sha256 -days 3650 \
  -subj "/CN=EV Dashboard Telemetry CA" \
  -out tesla-ca.crt

echo "→ Generating client private key..."
openssl genrsa -out tesla-client.key 4096

echo "→ Generating client CSR..."
openssl req -new -key tesla-client.key \
  -subj "/CN=tesla-telemetry-client" \
  -out tesla-client.csr

echo "→ Signing client cert with CA (10-year validity)..."
openssl x509 -req -in tesla-client.csr -CA tesla-ca.crt -CAkey tesla-ca.key \
  -CAcreateserial -days 3650 -sha256 \
  -out tesla-client.crt

rm -f tesla-client.csr tesla-ca.srl

echo ""
echo "✓ Cert generation complete. Files in $KEYS_DIR:"
ls -la "$KEYS_DIR"/tesla-*.{crt,key} 2>/dev/null

cat <<'EOF'

Next steps:
  1. Upload tesla-ca.crt to Cloudflare Zero Trust:
       Access → Service Auth → Mutual TLS → Add mTLS Certificate
       (paste the contents of tesla-ca.crt)
  2. Create Cloudflare Access application for tesla-telemetry.<your-domain>
  3. In the dashboard admin page, click "Register Telemetry" to upload
     tesla-client.crt + tesla-client.key to Tesla's Fleet API
  4. Tesla will start pushing data to your tunnel.
EOF
