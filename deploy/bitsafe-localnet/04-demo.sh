#!/bin/bash
# Deploys the lending protocol and runs the parameter change through the Decentralized Party:
# Test.Lending.DecManLocalNet:runOnExisting with the party and rules from state-input.json.
#   04-demo.sh <run-prefix>     (a new prefix per run: party hints must be new on the ledger)
set -eu
cd "$(dirname "$0")"; . ./lib.sh
LENDING_DAML="${LENDING_DAML:-$(cd "$(dirname "$0")/../../daml" && pwd)}"
. "$LENDING_DAML/../scripts/env.sh"
PREFIX="${1:-run1-}"
jq --arg p "$PREFIX" '.prefix = $p | .ledgerUser = "ledger-api-user"' state-input.json > "input-$PREFIX.json"
dpm script --dar "$LENDING_DAML/lending-tests/.daml/dist/lending-tests-$(sed -n 's/^version: *//p' "$LENDING_DAML/lending-tests/daml.yaml").dar" \
  --script-name Test.Lending.DecManLocalNet:runOnExisting \
  --participant-config state-participants.json --input-file "input-$PREFIX.json" --output-file "result-$PREFIX.json" \
  > "demo-$PREFIX.log" 2>&1 || { sed 's/\x1b\[[0-9;]*m//g' "demo-$PREFIX.log" | tail -20 >&2; exit 1; }
sed 's/\x1b\[[0-9;]*m//g' "demo-$PREFIX.log" | grep 'Prelude:' | sed 's/.*Prelude:[0-9]*\]: \\"\(.*\)\\"$/\1/' | cut -c1-200
jq . "result-$PREFIX.json"
