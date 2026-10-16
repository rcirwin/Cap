#!/usr/bin/env bash
# Backs up Cap to any S3-compatible bucket (built for Cloudflare R2):
#   db/      gzipped MySQL dumps, pruned after BACKUP_RETENTION_DAYS
#   config/  .env + compose files (contains secrets: keep the bucket private)
#   videos/  incremental mirror of the MinIO bucket; files removed from Cap
#            are moved to deleted/<date>/ and pruned after 30 days
#
#   sudo /opt/cap/backup.sh
set -euo pipefail

CAP_DIR=${CAP_DIR:-/opt/cap}
WORK_DIR=${BACKUP_WORK_DIR:-/var/backups/cap}
RCLONE_IMAGE=${RCLONE_IMAGE:-rclone/rclone:1.69}

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "error: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
cd "$CAP_DIR"

env_value() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true; }

for var in BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY \
	BACKUP_S3_PROVIDER BACKUP_RETENTION_DAYS MINIO_ROOT_USER MINIO_ROOT_PASSWORD; do
	[ -n "${!var:-}" ] || printf -v "$var" '%s' "$(env_value "$var")"
done

for var in BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY; do
	[ -n "${!var}" ] || die "$var is not set in $CAP_DIR/.env (run configure-backups.sh)"
done

network=$(docker inspect cap-minio --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' 2>/dev/null) ||
	die "cap-minio is not running"

export RCLONE_CONFIG_MINIO_TYPE=s3
export RCLONE_CONFIG_MINIO_PROVIDER=Minio
export RCLONE_CONFIG_MINIO_ENDPOINT=http://minio:9000
export RCLONE_CONFIG_MINIO_ACCESS_KEY_ID=$MINIO_ROOT_USER
export RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD
export RCLONE_CONFIG_DEST_TYPE=s3
export RCLONE_CONFIG_DEST_PROVIDER=${BACKUP_S3_PROVIDER:-Cloudflare}
export RCLONE_CONFIG_DEST_ENDPOINT=$BACKUP_S3_ENDPOINT
export RCLONE_CONFIG_DEST_ACCESS_KEY_ID=$BACKUP_S3_ACCESS_KEY_ID
export RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY=$BACKUP_S3_SECRET_ACCESS_KEY
export RCLONE_CONFIG_DEST_REGION=auto
export RCLONE_CONFIG_DEST_NO_CHECK_BUCKET=true

rclone() {
	docker run --rm --network "$network" \
		-v "$WORK_DIR:/backup" \
		-e RCLONE_CONFIG_MINIO_TYPE -e RCLONE_CONFIG_MINIO_PROVIDER -e RCLONE_CONFIG_MINIO_ENDPOINT \
		-e RCLONE_CONFIG_MINIO_ACCESS_KEY_ID -e RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY \
		-e RCLONE_CONFIG_DEST_TYPE -e RCLONE_CONFIG_DEST_PROVIDER -e RCLONE_CONFIG_DEST_ENDPOINT \
		-e RCLONE_CONFIG_DEST_ACCESS_KEY_ID -e RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY \
		-e RCLONE_CONFIG_DEST_REGION -e RCLONE_CONFIG_DEST_NO_CHECK_BUCKET \
		"$RCLONE_IMAGE" "$@"
}

stamp=$(date -u '+%Y%m%dT%H%M%SZ')
day=$(date -u '+%Y-%m-%d')
dest="dest:$BACKUP_S3_BUCKET"
mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"
trap 'rm -f "$WORK_DIR"/db-*.sql.gz "$WORK_DIR"/config-*.tar.gz' EXIT

log "Dumping database"
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump --single-transaction --quick --routines --no-tablespaces -u"$MYSQL_USER" "$MYSQL_DATABASE"' |
	gzip -9 >"$WORK_DIR/db-$stamp.sql.gz"
[ -s "$WORK_DIR/db-$stamp.sql.gz" ] || die "database dump is empty"

log "Archiving configuration"
config_files=(.env docker-compose.yml Caddyfile)
[ -f extra.env ] && config_files+=(extra.env)
tar -czf "$WORK_DIR/config-$stamp.tar.gz" "${config_files[@]}"

log "Uploading database dump and configuration"
rclone copy "/backup/db-$stamp.sql.gz" "$dest/db/"
rclone copy "/backup/config-$stamp.tar.gz" "$dest/config/"

log "Mirroring videos"
rclone sync minio:cap "$dest/videos" --backup-dir "$dest/deleted/$day" --fast-list --transfers 8 --stats-one-line --stats 0

log "Pruning old backups"
retention=${BACKUP_RETENTION_DAYS:-14}
rclone delete "$dest/db" --min-age "${retention}d"
rclone delete "$dest/config" --min-age "${retention}d"
rclone delete "$dest/deleted" --min-age 30d --rmdirs

date -u '+%Y-%m-%dT%H:%M:%SZ' >"$WORK_DIR/last-success"
log "Backup complete ($stamp)"
