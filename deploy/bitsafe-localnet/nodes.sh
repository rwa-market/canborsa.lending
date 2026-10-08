#!/bin/bash
# Starts three dec-party-manager nodes against the LocalNet participants
# (P1 app-provider, P2 app-user, P3 sv) and wires them as Noise peers,
# with the upstream integration-tests helpers.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
export SCRIPT_DIR="${DECMAN_DIR:-$HERE/../../.local/decman}"
source "$SCRIPT_DIR/integration-tests/env.sh"
DEV_DIR="${DECPM_NODES_DIR:-$HERE/nodes}"
BINARY="$SCRIPT_DIR/target/release-ci/dec-party-manager"
export DECPM_INSECURE=true
export DECPM_LOG_FORMAT=text
check_decman_ports_free
setup_directories
start_nodes
configure_peers
printf '%s\n' "${PIDS[@]}" > "$DEV_DIR/pids"
echo "P1 $P1_PARTICIPANT_ID"; echo "P2 $P2_PARTICIPANT_ID"; echo "P3 $P3_PARTICIPANT_ID"
