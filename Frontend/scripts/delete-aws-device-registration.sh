#!/usr/bin/env bash
# Delete Atomo Forge device registration on AWS (Atomic Center) only.
# Does not touch the local device.
#
# Usage:
#   ./scripts/delete-aws-device-registration.sh list
#   ./scripts/delete-aws-device-registration.sh APU-2026-E6B5-04EF
#   ./scripts/delete-aws-device-registration.sh --sqlite APU-2026-E6B5-04EF
#
# Environment (optional):
#   MESHCENTRAL_URL=https://3.108.185.253:4434
#   ATOMOFORGE_API_KEY=atomo-dev-key-change-in-production
#   AWS_HOST=ubuntu@3.108.185.253
#   AWS_SSH_KEY=/path/to/atomo_web.pem
#   AWS_MESH_DIR=new/atomic/MeshCentral-master

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MESHCENTRAL_URL="${MESHCENTRAL_URL:-https://3.108.185.253:4434}"
ATOMOFORGE_API_KEY="${ATOMOFORGE_API_KEY:-atomo-dev-key-change-in-production}"
AWS_HOST="${AWS_HOST:-ubuntu@3.108.185.253}"
AWS_MESH_DIR="${AWS_MESH_DIR:-new/atomic/MeshCentral-master}"
AWS_SSH_KEY="${AWS_SSH_KEY:-$ROOT/atomo_web.pem}"
DB_REL="meshcentral-data/atomic-center.sqlite"

SSH=(ssh -o StrictHostKeyChecking=accept-new)
if [[ -f "$AWS_SSH_KEY" ]]; then
  SSH+=( -i "$AWS_SSH_KEY" )
fi

usage() {
  echo "Usage:"
  echo "  $0 list"
  echo "  $0 <device-serial>              # delete via REST API"
  echo "  $0 --sqlite <device-serial>     # delete via SSH + sqlite3 on AWS"
  exit 1
}

serial_to_record_id() {
  local serial="${1,,}"
  echo "atomoforge_device//${serial}"
}

list_on_aws() {
  "${SSH[@]}" "$AWS_HOST" "sqlite3 ~/$AWS_MESH_DIR/$DB_REL \"
SELECT id,
       json_extract(doc,'\\\$.username') AS username,
       json_extract(doc,'\\\$.email') AS email,
       json_extract(doc,'\\\$.deviceSerial') AS device_serial
FROM main
WHERE json_extract(doc,'\\\$.type')='atomoforge_device';
\""
}

delete_via_api() {
  local serial="$1"
  echo "Deleting via API: $serial"
  curl -sk -X POST "$MESHCENTRAL_URL/api/atomoforge/devices/delete" \
    -H "Content-Type: application/json" \
    -H "X-AtomoForge-Key: $ATOMOFORGE_API_KEY" \
    -d "{\"deviceSerial\":\"$serial\",\"adminDelete\":true}"
  echo
}

delete_via_sqlite() {
  local serial="$1"
  local record_id
  record_id="$(serial_to_record_id "$serial")"
  echo "Deleting on AWS via sqlite3: $record_id"
  "${SSH[@]}" "$AWS_HOST" "sqlite3 ~/$AWS_MESH_DIR/$DB_REL \"DELETE FROM main WHERE id='$record_id'; SELECT changes();\""
}

[[ $# -ge 1 ]] || usage

if [[ "$1" == "list" ]]; then
  list_on_aws
  exit 0
fi

if [[ "$1" == "--sqlite" ]]; then
  [[ $# -eq 2 ]] || usage
  delete_via_sqlite "$2"
  exit 0
fi

delete_via_api "$1"
