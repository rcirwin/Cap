#!/usr/bin/env bash
# Restores Cap from the latest backup made by backup.sh. Intended for a fresh
# server: run install.sh first, then this. It REPLACES the current database,
# configuration and videos.
#
#   sudo /opt/cap/restore.sh
#
# Credentials come from BACKUP_S3_* in /opt/cap/.env, or are asked for.
set -euo pipefail

CAP_DIR=${CAP_DIR:-/opt/cap}
RCLONE_IMAGE=${RCLONE_IMAGE:-rclone/rclone:1.69}
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
cd "$CAP_DIR"

current() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }
ask() { local reply; read -r -p "$1: " reply </dev/tty || true; printf '%s' "$reply"; }
ask_secret() { local reply; read -r -s -p "$1: " reply </dev/tty || true; printf '\n' >/dev/tty; printf '%s' "$reply"; }

endpoint=$(current BACKUP_S3_ENDPOINT); [ -n "$endpoint" ] || endpoint=$(ask "S3 endpoint")
bucket=$(current BACKUP_S3_BUCKET); [ -n "$bucket" ] || bucket=$(ask "Bucket name")
access_key=$(current BACKUP_S3_ACCESS_KEY_ID); [ -n "$access_key" ] || access_key=$(ask_secret "Access Key ID")
secret_key=$(current BACKUP_S3_SECRET_ACCESS_KEY); [ -n "$secret_key" ] || secret_key=$(ask_secret "Secret Access Key")

export RCLONE_CONFIG_DEST_TYPE=s3
export RCLONE_CONFIG_DEST_PROVIDER=${BACKUP_S3_PROVIDER:-Cloudflare}
export RCLONE_CONFIG_DEST_ENDPOINT=$endpoint
export RCLONE_CONFIG_DEST_ACCESS_KEY_ID=$access_key
export RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY=$secret_key
export RCLONE_CONFIG_DEST_REGION=auto

rclone() {
	docker run --rm --network "${RCLONE_NETWORK:-bridge}" -v "$WORK_DIR:/restore" \
		-e RCLONE_CONFIG_DEST_TYPE -e RCLONE_CONFIG_DEST_PROVIDER -e RCLONE_CONFIG_DEST_ENDPOINT \
		-e RCLONE_CONFIG_DEST_ACCESS_KEY_ID -e RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY -e RCLONE_CONFIG_DEST_REGION \
		-e RCLONE_CONFIG_MINIO_TYPE -e RCLONE_CONFIG_MINIO_PROVIDER -e RCLONE_CONFIG_MINIO_ENDPOINT \
		-e RCLONE_CONFIG_MINIO_ACCESS_KEY_ID -e RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY \
		"$RCLONE_IMAGE" "$@"
}

latest() { rclone lsf "dest:$bucket/$1" --files-only | sort | tail -n 1; }

config=$(latest config)
dump=$(latest db)
[ -n "$config" ] && [ -n "$dump" ] || { echo "no backups found in $bucket" >&2; exit 1; }

echo "This replaces Cap's configuration, database and videos with:"
echo "  config/$config"
echo "  db/$dump"
[ "$(ask "Type RESTORE to continue")" = "RESTORE" ] || { echo "aborted"; exit 1; }

rclone copy "dest:$bucket/config/$config" /restore/
rclone copy "dest:$bucket/db/$dump" /restore/

docker compose down
tar -xzf "$WORK_DIR/$config" -C "$CAP_DIR"
chmod 600 .env

docker compose up -d mysql minio minio-setup
echo "Waiting for MySQL..."
until docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqladmin ping -u"$MYSQL_USER" --silent' 2>/dev/null; do sleep 3; done

echo "Restoring database"
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "DROP DATABASE IF EXISTS \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON \`$MYSQL_DATABASE\`.* TO \`$MYSQL_USER\`@\`%\`;"'
gunzip -c "$WORK_DIR/$dump" | docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE"'

echo "Restoring videos"
export RCLONE_CONFIG_MINIO_TYPE=s3 RCLONE_CONFIG_MINIO_PROVIDER=Minio RCLONE_CONFIG_MINIO_ENDPOINT=http://minio:9000
RCLONE_CONFIG_MINIO_ACCESS_KEY_ID=$(current MINIO_ROOT_USER)
RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY=$(current MINIO_ROOT_PASSWORD)
export RCLONE_CONFIG_MINIO_ACCESS_KEY_ID RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY
RCLONE_NETWORK=$(docker inspect cap-minio --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}')
rclone sync "dest:$bucket/videos" minio:cap --fast-list --transfers 8 --stats-one-line --stats 30s

docker compose up -d
echo "Restore complete."
