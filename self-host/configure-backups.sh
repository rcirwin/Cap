#!/usr/bin/env bash
# Saves backup bucket credentials, runs a first backup, and schedules a
# nightly one (08:00 UTC, about 4am Toronto).
#
#   sudo /opt/cap/configure-backups.sh
#
# For Cloudflare R2: create a bucket, then R2 -> Manage API tokens -> Create
# API token with "Object Read & Write" limited to that bucket. The token page
# shows the Access Key ID, Secret Access Key and the S3 endpoint
# (https://<account-id>.r2.cloudflarestorage.com).
set -euo pipefail

CAP_DIR=${CAP_DIR:-/opt/cap}
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
cd "$CAP_DIR"

ask() {
	local prompt=$1 default=${2:-} reply
	if [ -n "$default" ]; then prompt="$prompt [$default]"; fi
	read -r -p "$prompt: " reply </dev/tty || true
	printf '%s' "${reply:-$default}"
}

ask_secret() {
	local reply
	read -r -s -p "$1: " reply </dev/tty || true
	printf '\n' >/dev/tty
	printf '%s' "$reply"
}

upsert_env() {
	local key=$1 value=$2 tmp
	tmp=$(mktemp)
	grep -v "^${key}=" .env >"$tmp" || true
	printf '%s=%s\n' "$key" "$value" >>"$tmp"
	install -m 600 "$tmp" .env
	rm -f "$tmp"
}

current() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true; }

endpoint=${BACKUP_S3_ENDPOINT:-$(ask "S3 endpoint (e.g. https://<account-id>.r2.cloudflarestorage.com)" "$(current BACKUP_S3_ENDPOINT)")}
bucket=${BACKUP_S3_BUCKET:-$(ask "Bucket name" "$(current BACKUP_S3_BUCKET)")}
access_key=${BACKUP_S3_ACCESS_KEY_ID:-$(ask_secret "Access Key ID")}
secret_key=${BACKUP_S3_SECRET_ACCESS_KEY:-$(ask_secret "Secret Access Key")}

for value in endpoint bucket access_key secret_key; do
	[ -n "${!value}" ] || { echo "$value is required" >&2; exit 1; }
done

upsert_env BACKUP_S3_ENDPOINT "${endpoint%/}"
upsert_env BACKUP_S3_BUCKET "$bucket"
upsert_env BACKUP_S3_ACCESS_KEY_ID "$access_key"
upsert_env BACKUP_S3_SECRET_ACCESS_KEY "$secret_key"

cat >/etc/systemd/system/cap-backup.service <<EOF
[Unit]
Description=Back up Cap to object storage
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=$CAP_DIR/backup.sh
Nice=10
IOSchedulingClass=idle
EOF

cat >/etc/systemd/system/cap-backup.timer <<'EOF'
[Unit]
Description=Nightly Cap backup

[Timer]
OnCalendar=*-*-* 08:00:00 UTC
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
echo "Running the first backup (videos can take a while the first time)..."
"$CAP_DIR/backup.sh"
systemctl enable --now cap-backup.timer >/dev/null
echo
echo "Backups are configured. Next run: $(systemctl show cap-backup.timer -p NextElapseUSecRealtime --value)"
echo "Logs: journalctl -u cap-backup.service"
