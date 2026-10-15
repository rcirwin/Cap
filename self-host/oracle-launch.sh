#!/usr/bin/env bash
# Keeps requesting an Always Free Ampere (ARM) server until Oracle has
# capacity, trying the larger size first. Needs the OCI CLI configured
# (~/.oci/config) and a VCN created with the console's VCN wizard.
#
#   ./oracle-launch.sh
#
# Overrides: INSTANCE_NAME, SUBNET_NAME, SSH_PUBLIC_KEY, BOOT_VOLUME_GB,
# RETRY_SECONDS, COMPARTMENT_ID, OCI_CLI_PROFILE.
set -euo pipefail

NAME=${INSTANCE_NAME:-cap-server}
SUBNET_NAME=${SUBNET_NAME:-public subnet-cap-vcn}
SSH_KEY=${SSH_PUBLIC_KEY:-$HOME/.ssh/cap_oracle.pub}
BOOT_GB=${BOOT_VOLUME_GB:-150}
INTERVAL=${RETRY_SECONDS:-300}
SIZES=("2 12" "1 6")

log() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*"; }

[ -f "$SSH_KEY" ] || { echo "missing SSH public key: $SSH_KEY" >&2; exit 1; }

compartment=${COMPARTMENT_ID:-$(awk -F= -v profile="[${OCI_CLI_PROFILE:-DEFAULT}]" '
	$0 == profile { found = 1; next }
	/^\[/ { found = 0 }
	found && $1 ~ /^tenancy/ { gsub(/[[:space:]]/, "", $2); print $2 }
' "$HOME/.oci/config")}
[ -n "$compartment" ] || { echo "could not read tenancy from ~/.oci/config" >&2; exit 1; }

log "Looking up availability domain, subnet and Ubuntu image"
ad=$(oci iam availability-domain list -c "$compartment" --query 'data[0].name' --raw-output)
subnet=$(oci network subnet list -c "$compartment" --display-name "$SUBNET_NAME" --query 'data[0].id' --raw-output)
image=$(oci compute image list -c "$compartment" \
	--operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
	--shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC \
	--query 'data[0].id' --raw-output)
for value in ad subnet image; do
	[ -n "${!value}" ] && [ "${!value}" != "null" ] || { echo "lookup failed: $value" >&2; exit 1; }
done

existing=$(oci compute instance list -c "$compartment" --display-name "$NAME" \
	--query "data[?\"lifecycle-state\"!='TERMINATED'] | [0].id" --raw-output 2>/dev/null || true)
if [ -n "$existing" ] && [ "$existing" != "null" ]; then
	log "$NAME already exists ($existing); nothing to do"
	exit 0
fi

attempt=0
while true; do
	attempt=$((attempt + 1))
	for size in "${SIZES[@]}"; do
		read -r ocpus memory <<<"$size"
		log "Attempt $attempt: ${ocpus} OCPU / ${memory} GB"
		if output=$(oci compute instance launch \
			--compartment-id "$compartment" \
			--availability-domain "$ad" \
			--display-name "$NAME" \
			--shape VM.Standard.A1.Flex \
			--shape-config "{\"ocpus\": $ocpus, \"memoryInGBs\": $memory}" \
			--image-id "$image" \
			--boot-volume-size-in-gbs "$BOOT_GB" \
			--subnet-id "$subnet" \
			--assign-public-ip true \
			--ssh-authorized-keys-file "$SSH_KEY" \
			--wait-for-state RUNNING \
			--query 'data.id' --raw-output 2>&1); then
			instance_id=$(printf '%s\n' "$output" | grep -o 'ocid1\.instance[^"[:space:]]*' | tail -n 1)
			ip=$(oci compute instance list-vnics --instance-id "$instance_id" --query 'data[0]."public-ip"' --raw-output)
			log "Created $NAME (${ocpus} OCPU / ${memory} GB) at $ip"
			printf '%s\n' "$ip" >"$HOME/.oci/cap-server-ip"
			osascript -e "display notification \"$NAME is running at $ip\" with title \"Oracle server ready\" sound name \"Glass\"" 2>/dev/null || true
			exit 0
		fi
		if grep -qiE 'out of (host )?capacity' <<<"$output"; then
			log "  out of capacity"
		elif grep -qiE 'TooManyRequests|429' <<<"$output"; then
			log "  rate limited; backing off"
			sleep 120
		else
			log "  unexpected error:"
			printf '%s\n' "$output" | tail -n 20
			exit 1
		fi
	done
	sleep "$INTERVAL"
done
