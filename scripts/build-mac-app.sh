#!/bin/zsh
# Build and sign the Mac app with a stable local identity so the Keychain device key
# stays readable across rebuilds (an ad-hoc signature changes every build).
#
#   scripts/build-mac-app.sh [--install]
#
# First run: creates a self-signed "Aelys Local Signing" code-signing identity in the
# login keychain. Override with AELYS_SIGNING_IDENTITY, or the API with VITE_API_BASE_URL.
set -euo pipefail

IDENTITY="${AELYS_SIGNING_IDENTITY:-Aelys Local Signing}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export APPLE_SIGNING_IDENTITY="$IDENTITY"
export VITE_API_BASE_URL="${VITE_API_BASE_URL:-https://api-production-1cea.up.railway.app/api/v1}"

if ! security find-identity -p codesigning | grep -q "\"$IDENTITY\""; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -days 3650 \
    -subj "/CN=$IDENTITY" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1
  openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -out "$tmp/id.p12" -name "$IDENTITY" \
    -passout pass:aelys-local -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
  security import "$tmp/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P aelys-local -T /usr/bin/codesign
fi

cd "$ROOT/apps/desktop"
pnpm tauri:build --bundles app
APP="src-tauri/target/release/bundle/macos/Aelys.app"
codesign --verify --deep --strict "$APP"
codesign -d -r- "$APP" 2>&1 | tail -1

if [[ "${1:-}" == "--install" ]]; then
  osascript -e 'tell application "Aelys" to quit' 2>/dev/null || true
  sleep 2
  rm -rf "$HOME/Applications/Aelys.app"
  cp -R "$APP" "$HOME/Applications/Aelys.app"
  open "$HOME/Applications/Aelys.app"
fi
