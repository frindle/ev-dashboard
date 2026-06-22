#!/bin/sh
# Generate the self-signed TLS cert the Tesla vehicle-command HTTP proxy needs
# for its own HTTPS listener. This is local-only (clients connect via localhost)
# so a self-signed cert is fine — nothing on the internet sees this cert.
set -eu

KEYS_DIR="${KEYS_DIR:-/app/keys}"
CERT="$KEYS_DIR/proxy-server.crt"
KEY="$KEYS_DIR/proxy-server.key"

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  exit 0
fi

echo "[ensure-proxy-cert] generating self-signed cert for tesla-http-proxy"
openssl req -x509 -newkey ec \
  -pkeyopt ec_paramgen_curve:prime256v1 \
  -nodes -days 3650 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$KEY" -out "$CERT" 2>&1 | tail -3
echo "[ensure-proxy-cert] done"
