#!/bin/bash
# The same kind of change through DecMan itself: the script only creates the LendingParamsAction
# proposal (member p1); P2 and P3 confirm with POST /governance/confirm, P1 executes with
# POST /governance/execute. Then reads the config on P2's ledger.
#   05-decman-vote.sh <run-prefix of a finished 04-demo.sh> <factor>
set -eu
cd "$(dirname "$0")"; . ./lib.sh
LENDING_DAML="${LENDING_DAML:-$(cd "$(dirname "$0")/../../daml" && pwd)}"
. "$LENDING_DAML/../scripts/env.sh"
PREFIX="${1:-run1-}"; FACTOR="${2:-0.4}"
DP=$(jq -r .decParty state-input.json); RULES=$(jq -r .rulesCid state-input.json)
OP=$(jq -r .operator "result-$PREFIX.json")
jq -n --arg dp "$DP" --arg m1 "$(jq -r '.members[0]' state-input.json)" --arg op "$OP" --arg f "$FACTOR" --arg id "${PREFIX}cbtc-$FACTOR" \
  '{decParty:$dp, proposer:$m1, operator:$op, market:"CBTC", factor:$f, proposalId:$id}' > "propose-$PREFIX.json"
dpm script --dar "$LENDING_DAML/lending-tests/.daml/dist/lending-tests-$(sed -n 's/^version: *//p' "$LENDING_DAML/lending-tests/daml.yaml").dar" \
  --script-name Test.Lending.DecManLocalNet:proposeOnExisting \
  --participant-config state-participants.json --input-file "propose-$PREFIX.json" --output-file "proposal-$PREFIX.json" \
  > "propose-$PREFIX.log" 2>&1 || { sed 's/\x1b\[[0-9;]*m//g' "propose-$PREFIX.log" | tail -20 >&2; exit 1; }
PC=$(jq -r . "proposal-$PREFIX.json")
echo "== proposal ${PC:0:16}… (LendingParamsAction, CBTC borrowCollateralFactor -> $FACTOR)"
pending() { curl -sf "localhost:$1/governance/confirmations?party_id=$DP" | jq --arg pc "$PC" '.domain_actions[] | select(.proposal_cid == $pc)'; }
for port in $P1 $P2 $P3; do
  echo "  DecMan :$port lists it: $(pending $port | jq -c '{action_label, confirmation_count, can_execute}')"
done
# core_domain requests carry a placeholder action, as in DecMan's own e2e (tests/common/governance.rs)
body() { jq -n --arg dp "$DP" --arg r "$RULES" --arg pc "$PC" '{party_id:$dp, rules_contract_id:$r, action:{type:"governance_set_threshold", new_threshold:1}, governance_type:"core_domain", proposal_cid:$pc}'; }
for port in $P2 $P3; do echo "  confirm on :$port: $(post $port /governance/confirm "$(body)")"; done
for _ in $(seq 1 30); do [ "$(pending $P1 | jq -r .can_execute)" = true ] && break; sleep 1; done
st=$(pending $P1); echo "  P1 sees: $(echo "$st" | jq -c '{confirmation_count, can_execute, confirmers: [.confirmations[].confirming_party | split("::")[0]]}')"
echo "  execute on :$P1: $(post $P1 /governance/execute "$(body | jq --argjson c "$(echo "$st" | jq -c .executable_confirmation_cids)" '. + {confirmation_cids: $c}')")"
end=$(ledger $J2 GET /v2/state/ledger-end | jq .offset)
ledger $J2 POST /v2/state/active-contracts "{\"activeAtOffset\":$end,\"eventFormat\":{\"filtersByParty\":{\"$DP\":{\"cumulative\":[{\"identifierFilter\":{\"TemplateFilter\":{\"value\":{\"templateId\":\"#lending-core-v2:Lending.Config:ProtocolConfig\",\"includeCreatedEventBlob\":false}}}}]}},\"verbose\":true}}" \
  | jq -c --arg op "$OP" '.[] | .contractEntry.JsActiveContract.createdEvent.createArgument | select(.roles.operator == $op)
      | {seenOn: "P2 (app-user)", governors, cbtcBorrowCollateralFactor: (.marketParams[] | select(.[0] == "CBTC") | .[1].borrowCollateralFactor)}'
