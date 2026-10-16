#!/usr/bin/env bash
# Sets one value in /opt/cap/.env without echoing it, then restarts Cap.
#   sudo ./set-env.sh GROQ_API_KEY
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
key=${1:?usage: set-env.sh KEY}
cd "$(dirname "$0")"
read -r -s -p "Value for $key: " value </dev/tty
printf '\n'
tmp=$(mktemp)
grep -v "^${key}=" .env >"$tmp" || true
printf '%s=%s\n' "$key" "$value" >>"$tmp"
install -m 600 "$tmp" .env
rm -f "$tmp"
docker compose up -d
echo "$key updated and Cap restarted."
