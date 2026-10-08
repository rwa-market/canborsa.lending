#!/bin/bash
# Creates the Decentralized Party "lending-council" hosted on P1, P2 and P3 (threshold 2 of 3).
set -eu
cd "$(dirname "$0")"; . ./lib.sh
PREFIX="${DECPARTY_PREFIX:-lending-council}"
echo "== onboarding: $PREFIX on 3 participants, threshold 2"
post $P1 /onboarding "{\"party_id_prefix\":\"$PREFIX\",\"peer_ids\":[\"$(pid_of $P2)\",\"$(pid_of $P3)\"],\"threshold\":2}"; echo
accept_invitation $P2 Onboarding & accept_invitation $P3 Onboarding & wait
wait_status /onboarding/status
# /onboarding/status can report completed a moment before GET /decentralized-parties lists the
# party: retry until it is listed instead of writing an empty state-decparty.json
for _ in $(seq 1 30); do
  curl -sf localhost:$P1/decentralized-parties | jq --arg p "$PREFIX" \
    '.parties[] | select(.party_id | startswith($p + "::"))' > state-decparty.json
  [ -s state-decparty.json ] && break
  sleep 2
done
[ -s state-decparty.json ] || { echo "the Decentralized Party did not show up in DecMan" >&2; exit 1; }
cat state-decparty.json
