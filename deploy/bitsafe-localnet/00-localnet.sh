#!/bin/bash
# LocalNet (Splice 0.6.12, the version DecMan's integration tests pin): only canton, splice and
# postgres; one canton container runs three participants: app-provider (P1), app-user (P2), sv (P3).
#   00-localnet.sh up | down
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
DECMAN_DIR="${DECMAN_DIR:-$HERE/../../.local/decman}"
L="$DECMAN_DIR/.localnet/splice-node/docker-compose/localnet"
export IMAGE_TAG=0.6.12
export DB_PORT="${DB_PORT:-15432}"   # host port of the LocalNet postgres; 5432 is often taken
compose() {
  docker compose --env-file "$L/compose.env" --env-file "$L/env/common.env" \
    -f "$L/compose.yaml" -f "$L/resource-constraints.yaml" -f "$HERE/low-memory.yaml" \
    --profile sv --profile app-provider --profile app-user "$@"
}
case "${1:-up}" in
  up)
    if [ ! -d "$L" ]; then
      mkdir -p "$DECMAN_DIR/.localnet"
      curl -fSL "https://github.com/digital-asset/decentralized-canton-sync/releases/download/v0.6.12/0.6.12_splice-node.tar.gz" \
        -o "$DECMAN_DIR/.localnet/splice-node.tar.gz"
      tar xzf "$DECMAN_DIR/.localnet/splice-node.tar.gz" -C "$DECMAN_DIR/.localnet"
      rm -f "$DECMAN_DIR/.localnet/splice-node.tar.gz"
    fi
    compose up -d --wait canton splice postgres ;;
  down) compose down -v ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
