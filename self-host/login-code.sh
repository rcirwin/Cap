#!/usr/bin/env bash
# Prints the most recent sign-in code. Without an email provider configured,
# Cap writes one-time login codes to the cap-web container log instead.
set -euo pipefail
cd "$(dirname "$0")"
code=$(docker compose logs --no-log-prefix --since 30m cap-web 2>/dev/null | grep -E "Code: [0-9A-Za-z]+" | tail -n 1 | sed -E 's/.*Code: ([0-9A-Za-z]+).*/\1/')
if [ -z "$code" ]; then
	echo "No sign-in code in the last 30 minutes. Request one on the login page first, then rerun this."
	exit 1
fi
echo "$code"
