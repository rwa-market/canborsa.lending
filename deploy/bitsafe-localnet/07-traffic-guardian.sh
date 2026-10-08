#!/bin/bash
# Two open questions of ADR-009 on LocalNet (needs only 00-localnet.sh up, no DecMan):
#   A. traffic: the sequencer cost of each pool operation, from Canton's counter
#      daml_sequencer_client_traffic_control_event_delivered_cost_total per participant and event
#      type, read before and after the step;
#   B. the guardian is an observer of PauseState: with the guardian's participant (P2) off the
#      synchronizer, pool operations that read PauseState still commit; back online, the guardian
#      pauses borrowing and lifts the pause.
# Every party except the guardian lives on P1 (app-provider). Steps: Test.Lending.LocalNetProbe.
#   07-traffic-guardian.sh [run-prefix]      (a new prefix per run: party hints must be new)
set -eu
cd "$(dirname "$0")"; . ./lib.sh
LENDING_DAML="${LENDING_DAML:-$(cd "$(dirname "$0")/../../daml" && pwd)}"
. "$LENDING_DAML/../scripts/env.sh"
PREFIX="${1:-probe1-}"
OUT="traffic-$PREFIX"; mkdir -p "$OUT"
TESTS_DAR="$LENDING_DAML/lending-tests/.daml/dist/lending-tests-$(sed -n 's/^version: *//p' "$LENDING_DAML/lending-tests/daml.yaml").dar"

# --- DARs on P1 and P2: the tests DAR carries lending-core-v2 and the test tokens -----------
for j in $J1 $J2; do
  curl -sf -X POST "localhost:$j/v2/packages" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/octet-stream' --data-binary @"$TESTS_DAR" >/dev/null \
    || { echo "DAR upload to JSON API :$j failed" >&2; exit 1; }
done
echo "== $(basename "$TESTS_DAR") uploaded to P1 and P2"

jq -n '{default_participant: {host: "localhost", port: 3901, access_token: $ENV.TOKEN},
  participants: {p2: {host: "localhost", port: 2901, access_token: $ENV.TOKEN}}, party_participants: {}}' \
  > "$OUT/participants.json"

# cost NODE TYPE-REGEX: sum of the delivered-cost counter of a participant (app-provider = P1,
# app-user = P2) over the event types that match
metrics() { docker exec canton wget -qO- localhost:10013/metrics; }
cost() {
  echo "$1" | grep '^daml_sequencer_client_traffic_control_event_delivered_cost_total{' \
    | grep "node=\"$2\"" | grep -E "type=\"($3)\"" | awk '{s += $NF} END {printf "%d", s}'
}

# run STEP: one dpm script run; the state goes from one run to the next
run() {
  jq -n --arg p "$PREFIX" --arg s "$1" --slurpfile st "$OUT/state.json" \
    '{prefix: $p, ledgerUser: "ledger-api-user", stepName: $s, state: ($st[0] // null)}' > "$OUT/in.json" 2>/dev/null \
    || jq -n --arg p "$PREFIX" --arg s "$1" '{prefix: $p, ledgerUser: "ledger-api-user", stepName: $s, state: null}' > "$OUT/in.json"
  dpm script --dar "$TESTS_DAR" --script-name Test.Lending.LocalNetProbe:step \
    --participant-config "$OUT/participants.json" --input-file "$OUT/in.json" --output-file "$OUT/out.json" \
    > "$OUT/$1.log" 2>&1 || { sed 's/\x1b\[[0-9;]*m//g' "$OUT/$1.log" | tail -20 >&2; return 1; }
  mv "$OUT/out.json" "$OUT/state.json"
}

# Confirmation responses are free on the Global Synchronizer (freeConfirmationResponses), so
# an operation costs its confirmation request; P2 counts any event of the guardian's node
REQ='send-confirmation-request|send-confirmation-response'
# Splice price of extra traffic, USD per MB (10^6 bytes), from scan
scan() { docker exec splice wget -qO- --post-data="$2" --header=Content-Type:application/json "localhost:5012/api/scan/v0/$1"; }
PRICE=$(scan amulet-rules '{}' | jq -r '.amulet_rules_update.contract.payload.configSchedule.initialValue.decentralizedSynchronizer.fees.extraTrafficPrice')
# settled: the metrics once the delivered-cost counters stop moving (a delivery receipt arrives
# after the step's script has returned)
settled() {
  local a b
  a=$(metrics)
  for _ in $(seq 1 15); do
    sleep 2; b=$(metrics)
    [ "$(cost "$a" app-provider "$REQ")/$(cost "$a" app-user "$REQ")" = \
      "$(cost "$b" app-provider "$REQ")/$(cost "$b" app-user "$REQ")" ] && break
    a=$b
  done
  echo "$b"
}
# measure STEP: cost of the step on P1 (submitter, every signatory) and on P2 (guardian)
measure() {
  run refresh
  local before after p1 p2
  before=$(settled)
  run "$1"
  after=$(settled)
  p1=$(( $(cost "$after" app-provider "$REQ") - $(cost "$before" app-provider "$REQ") ))
  p2=$(( $(cost "$after" app-user "$REQ") - $(cost "$before" app-user "$REQ") ))
  printf '%-22s %8d %8d %8s   %s\n' "$1" "$p1" "$p2" "$(echo "scale=4; ($p1 + $p2) * $PRICE / 1000000" | bc)" \
    "$(jq -r .note "$OUT/state.json")" | tee -a "$OUT/traffic.txt"
}

rm -f "$OUT/state.json" "$OUT/traffic.txt"
echo "== setup: protocol deployed, guardian on P2"
run setup
GUARDIAN=$(jq -r .env.guardian "$OUT/state.json")
jq --arg g "$GUARDIAN" '.party_participants[$g] = "p2"' "$OUT/participants.json" > "$OUT/p.json" && mv "$OUT/p.json" "$OUT/participants.json"
echo "  guardian ${GUARDIAN%%::*} on P2, $(jq -r .note "$OUT/state.json")"

echo
echo "== A. traffic per operation, bytes; USD at the extra-traffic price of \$$PRICE per MB"
printf '%-22s %8s %8s %8s\n' step P1 P2 USD | tee "$OUT/traffic.txt"
for s in supplyBase supplyCollateral borrow1 withdrawCollateral1 supplyCollateralCbtc borrow2 \
         withdrawCollateral2 repay priceUpdate absorb buy pauseFlag unpauseFlag; do
  measure "$s"
done

echo
echo "== B. guardian's participant P2 off the synchronizer"
SYN=$(admin $A2 $CONNECTIVITY/ListConnectedSynchronizers '{}' | jq -r '.connectedSynchronizers[0].synchronizerId')
ALIAS=$(admin $A2 $CONNECTIVITY/ListConnectedSynchronizers '{}' | jq -r '.connectedSynchronizers[0].synchronizerAlias')
admin $A2 $CONNECTIVITY/DisconnectSynchronizer "{\"synchronizerAlias\":\"$ALIAS\"}" >/dev/null
echo "  P2 connected to: '$(connected $A2)'"
run refresh
run offline
echo "  $(jq -r .note "$OUT/state.json")"
admin $A2 $CONNECTIVITY/ReconnectSynchronizer "{\"synchronizerAlias\":\"$ALIAS\"}" >/dev/null
for _ in $(seq 1 30); do [ -n "$(connected $A2)" ] && break; sleep 1; done
echo "  P2 back on: $(connected $A2) (${SYN%%::*})"
run refresh
run online
echo "  $(jq -r .note "$OUT/state.json")"
