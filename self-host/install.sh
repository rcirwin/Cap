#!/usr/bin/env bash
# Installs or updates a self-hosted Cap on a fresh Ubuntu/Debian server
# (built for Oracle Cloud Always Free Ampere/ARM, works on any x86/ARM VPS).
#
#   curl -fsSL https://raw.githubusercontent.com/rcirwin/Cap/self-host/self-host/install.sh -o install.sh
#   sudo bash install.sh
#
# Non-interactive: pre-set CAP_DOMAIN, OWNER_EMAIL, GROQ_API_KEY, DUCKDNS_TOKEN.
set -euo pipefail

CAP_DIR=${CAP_DIR:-/opt/cap}
CAP_REPO_RAW=${CAP_REPO_RAW:-https://raw.githubusercontent.com/rcirwin/Cap/self-host/self-host}
DEFAULT_EXTENSION_ID=fonfkofcnfolpcfekellfjedolghophf

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo bash install.sh"
command -v apt-get >/dev/null || die "this installer supports Ubuntu/Debian only"

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
	local key=$1 value=$2 file=$CAP_DIR/.env tmp
	tmp=$(mktemp)
	if [ -f "$file" ]; then grep -v "^${key}=" "$file" >"$tmp" || true; fi
	printf '%s=%s\n' "$key" "$value" >>"$tmp"
	install -m 600 "$tmp" "$file"
	rm -f "$tmp"
}

env_value() {
	[ -f "$CAP_DIR/.env" ] || return 0
	grep -E "^$1=" "$CAP_DIR/.env" | tail -n 1 | cut -d= -f2- || true
}

public_ip() {
	curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me || true
}

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl openssl dnsutils iptables >/dev/null

if ! command -v docker >/dev/null; then
	log "Installing Docker"
	curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
	usermod -aG docker "$SUDO_USER" || true
fi

log "Opening ports 80 and 443 in the OS firewall"
open_port() {
	local proto=$1 port=$2
	if ! iptables -C INPUT -p "$proto" --dport "$port" -j ACCEPT 2>/dev/null; then
		iptables -I INPUT 1 -p "$proto" --dport "$port" -j ACCEPT
	fi
}
open_port tcp 80
open_port tcp 443
open_port udp 443
if command -v netfilter-persistent >/dev/null; then
	netfilter-persistent save >/dev/null 2>&1 || true
elif [ -d /etc/iptables ]; then
	iptables-save >/etc/iptables/rules.v4
fi

mkdir -p "$CAP_DIR"
log "Fetching deployment files into $CAP_DIR"
for file in docker-compose.yml Caddyfile login-code.sh set-env.sh; do
	curl -fsSL "$CAP_REPO_RAW/$file" -o "$CAP_DIR/$file"
done
chmod +x "$CAP_DIR/login-code.sh" "$CAP_DIR/set-env.sh"

IP=$(public_ip)

if [ -z "$(env_value CAP_DOMAIN)" ]; then
	log "First-time configuration"
	echo "Share links will live at https://<domain>/s/<video-id>."
	echo "Free option: claim a name at https://www.duckdns.org pointing at ${IP:-the public IP of this server}."
	domain=${CAP_DOMAIN:-$(ask "Domain for Cap (e.g. ryan-videos.duckdns.org)")}
	[ -n "$domain" ] || die "a domain is required"
	owner=${OWNER_EMAIL:-$(ask "Your email (the only account allowed to sign up)")}
	[ -n "$owner" ] || die "an owner email is required"
	groq=${GROQ_API_KEY-$(ask_secret "Groq API key for free transcripts + AI summaries (Enter to skip)")}

	upsert_env CAP_DOMAIN "$domain"
	upsert_env CAP_S3_DOMAIN "s3.$domain"
	upsert_env CAP_ALLOWED_SIGNUP_DOMAINS "$owner"
	upsert_env CAP_CHROME_EXTENSION_ID "$DEFAULT_EXTENSION_ID"
	upsert_env GROQ_API_KEY "$groq"
	upsert_env MINIO_ROOT_USER capadmin
	for key in DATABASE_ENCRYPTION_KEY NEXTAUTH_SECRET MEDIA_SERVER_WEBHOOK_SECRET CRON_SECRET; do
		upsert_env "$key" "$(openssl rand -hex 32)"
	done
	for key in MYSQL_PASSWORD MYSQL_ROOT_PASSWORD MINIO_ROOT_PASSWORD; do
		upsert_env "$key" "$(openssl rand -hex 24)"
	done
fi

DOMAIN=$(env_value CAP_DOMAIN)
S3_DOMAIN=$(env_value CAP_S3_DOMAIN)

duckdns_token=${DUCKDNS_TOKEN:-}
if [[ "$DOMAIN" == *.duckdns.org ]] && [ ! -f "$CAP_DIR/.duckdns" ]; then
	if [ -z "$duckdns_token" ]; then
		duckdns_token=$(ask_secret "DuckDNS token to keep the IP updated automatically (Enter to skip)")
	fi
	if [ -n "$duckdns_token" ]; then
		subdomain=${DOMAIN%.duckdns.org}
		subdomain=${subdomain##*.}
		install -m 600 /dev/null "$CAP_DIR/.duckdns"
		printf 'https://www.duckdns.org/update?domains=%s&token=%s&ip=\n' "$subdomain" "$duckdns_token" >"$CAP_DIR/.duckdns"
		printf '*/5 * * * * root curl -fsS --max-time 20 "$(cat %s/.duckdns)" >/dev/null 2>&1\n' "$CAP_DIR" >/etc/cron.d/cap-duckdns
		curl -fsS --max-time 20 "$(cat "$CAP_DIR/.duckdns")" >/dev/null || warn "DuckDNS update failed; check the token"
	fi
fi

for host in "$DOMAIN" "$S3_DOMAIN"; do
	resolved=$(dig +short "$host" A | tail -n 1)
	if [ -n "$IP" ] && [ "$resolved" != "$IP" ]; then
		warn "$host resolves to '${resolved:-nothing}', expected $IP. HTTPS certificates will fail until DNS points here."
	fi
done

log "Pulling images"
cd "$CAP_DIR"
if ! docker compose pull --quiet; then
	die "image pull failed. If the GitHub packages are private, run: docker login ghcr.io -u <github-user> (password: a token with read:packages)"
fi

log "Starting Cap"
docker compose up -d --remove-orphans

log "Waiting for https://$DOMAIN (first boot runs database migrations and requests certificates)"
for _ in $(seq 1 60); do
	if curl -fsS -o /dev/null --max-time 10 "https://$DOMAIN/"; then
		ready=1
		break
	fi
	sleep 10
done

if [ "${ready:-0}" != 1 ]; then
	warn "Cap is not answering on https://$DOMAIN yet. Check: cd $CAP_DIR && docker compose ps && docker compose logs --tail 100 caddy cap-web"
	warn "On Oracle Cloud, also allow TCP 80/443 and UDP 443 in the VCN security list."
	exit 1
fi

cat <<EOF

Cap is running at https://$DOMAIN

Sign in:
  1. Open https://$DOMAIN/login and enter $(env_value CAP_ALLOWED_SIGNUP_DOMAINS)
  2. Get the one-time code:  sudo $CAP_DIR/login-code.sh

Add or change a key later (e.g. Groq):  sudo $CAP_DIR/set-env.sh GROQ_API_KEY
Update to the newest build:            cd $CAP_DIR && sudo docker compose pull && sudo docker compose up -d
EOF
