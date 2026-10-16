#!/usr/bin/env bash
# Turns on email (comment notifications, sign-in codes) via SMTP and sends a
# test sign-in code to the owner's address.
#
#   sudo /opt/cap/configure-email.sh
#
# Gmail: enable 2-Step Verification, then create an app password at
# https://myaccount.google.com/apppasswords and paste it when asked.
# Any other SMTP provider: run with SMTP_URL=smtps://user:pass@host:465 set.
set -euo pipefail

CAP_DIR=${CAP_DIR:-/opt/cap}
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
cd "$CAP_DIR"

current() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true; }

upsert_env() {
	local key=$1 value=$2 tmp
	tmp=$(mktemp)
	grep -v "^${key}=" .env >"$tmp" || true
	printf '%s=%s\n' "$key" "$value" >>"$tmp"
	install -m 600 "$tmp" .env
	rm -f "$tmp"
}

urlencode() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

owner=$(current CAP_ALLOWED_SIGNUP_DOMAINS | cut -d, -f1)
smtp_url=${SMTP_URL:-}
email_from=${EMAIL_FROM:-}

if [ -z "$smtp_url" ]; then
	read -r -p "Gmail address to send from [$owner]: " gmail </dev/tty || true
	gmail=${gmail:-$owner}
	read -r -s -p "Gmail app password (16 letters): " app_password </dev/tty || true
	printf '\n'
	app_password=${app_password// /}
	[ -n "$gmail" ] && [ -n "$app_password" ] || { echo "address and app password are required" >&2; exit 1; }
	smtp_url="smtps://$(urlencode "$gmail"):$(urlencode "$app_password")@smtp.gmail.com:465"
	email_from=${email_from:-"Cap <$gmail>"}
fi

upsert_env SMTP_URL "$smtp_url"
[ -n "$email_from" ] && upsert_env EMAIL_FROM "$email_from"

echo "Restarting Cap with email enabled..."
docker compose up -d cap-web >/dev/null
for _ in $(seq 1 30); do
	status=$(docker inspect cap-web --format '{{.State.Health.Status}}' 2>/dev/null || true)
	[ "$status" = "healthy" ] && break
	sleep 5
done

domain=$(current CAP_DOMAIN)
if [ -z "$owner" ] || [ -z "$domain" ]; then
	echo "Email is configured. (Skipping the test: owner email or domain unknown.)"
	exit 0
fi

echo "Sending a test sign-in code to $owner..."
jar=$(mktemp)
since=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
csrf=$(curl -fsS -c "$jar" "https://$domain/api/auth/csrf" | python3 -c 'import json, sys; print(json.load(sys.stdin)["csrfToken"])')
curl -fsS -o /dev/null -b "$jar" -X POST "https://$domain/api/auth/signin/email" \
	--data-urlencode "email=$owner" \
	--data-urlencode "csrfToken=$csrf" \
	--data-urlencode "callbackUrl=https://$domain/dashboard" || true
rm -f "$jar"
sleep 8

if docker compose logs --since "$since" cap-web 2>/dev/null | grep -q "SMTP delivery"; then
	echo "Sending failed:"
	docker compose logs --since "$since" cap-web 2>/dev/null | grep "SMTP delivery" | tail -n 1
	echo "Check the address and app password, then run this script again."
	exit 1
fi

echo "Done. Check $owner for an email titled \"Your Cap Verification Code\"."
echo "Comment notifications will now be emailed too."
