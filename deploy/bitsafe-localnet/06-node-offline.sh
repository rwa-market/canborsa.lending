#!/bin/bash
# Distributed hosting under a node outage. The Decentralized Party is hosted on P1, P2 and P3
# with confirmation threshold 2 (PartyToParticipant topology mapping). The script:
#   A. takes P3 offline: a 2-of-3 vote of members p1 and p2 through DecMan still passes, and a
#      user supply that reads the party-signed config is accepted;
#   B. takes P2 offline as well (one host left, below the threshold): the confirmation and the
#      user supply both fail with a mediator timeout, nothing changes on the ledger;
#   C. brings P2 and P3 back: P3 catches up with the change it missed, the pending vote and the
#      supply go through.
# "Offline" = the participant disconnects from the synchronizer through its Admin API
# (SynchronizerConnectivityService.DisconnectSynchronizer). Its process, Ledger API and DecMan node
# keep running, but it gets no transaction views and sends no confirmations: for the sequencer and
# the mediator it is gone, exactly like a stopped node. LocalNet runs all three participants in one
# JVM, so stopping one participant process is not possible here.
#   06-node-offline.sh <run-prefix of a finished 04-demo.sh>
set -eu
cd "$(dirname "$0")"; . ./lib.sh
LENDING_DAML="${LENDING_DAML:-$(cd "$(dirname "$0")/../../daml" && pwd)}"
. "$LENDING_DAML/../scripts/env.sh"
PREFIX="${1:-run1-}"
DP=$(jq -r .decParty state-input.json); RULES=$(jq -r .rulesCid state-input.json)
M1=$(jq -r '.members[0]' state-input.json)
OP=$(jq -r .operator "result-$PREFIX.json")
TESTS_DAR="$LENDING_DAML/lending-tests/.daml/dist/lending-tests-$(sed -n 's/^version: *//p' "$LENDING_DAML/lending-tests/daml.yaml").dar"
CORE_DAR="$LENDING_DAML/lending-core-v2/.daml/dist/lending-core-v2-$(sed -n 's/^version: *//p' "$LENDING_DAML/lending-core-v2/daml.yaml").dar"
short() { echo "${1%%::*}"; }
ts() { date +%H:%M:%S; }

# --- topology: who hosts the party and with which thresholds ---------------------------
SYN=$(admin $A1 $CONNECTIVITY/ListConnectedSynchronizers '{}' | jq -r '.connectedSynchronizers[0].synchronizerId')
q() { jq -n --arg s "$SYN" --arg k "$1" --arg v "$2" '{baseQuery: {store: {synchronizer: {id: $s}}, headState: {}}, ($k): $v}'; }
ptp=$(admin $A1 $TOPOLOGY/ListPartyToParticipant "$(q filterParty "$DP")" | jq '.results[0].item')
dns=$(admin $A1 $TOPOLOGY/ListDecentralizedNamespaceDefinition "$(q filterNamespace "${DP#*::}")" | jq '.results[0].item')
echo "== topology of $(short "$DP") on $(short "$SYN")"
echo "  namespace owners: $(echo "$dns" | jq -r '"\(.threshold) of \(.owners | length) owner keys"')"
echo "  hosting (PartyToParticipant): confirmation threshold $(echo "$ptp" | jq -r .threshold), hosts:"
echo "$ptp" | jq -r '.participants[] | "    \(.participantUid | split("::")[0])::\(.participantUid | split("::")[1][0:12])… \(.permission | sub("PARTICIPANT_PERMISSION_"; ""))"'
echo "  GovernanceRules: threshold $(jq -r .createArgument.threshold state-rules.json) of $(jq -r '.createArgument.members.map | length' state-rules.json 2>/dev/null || echo 3) members"

# --- helpers ------------------------------------------------------------------------------
# a user-level operation on the deployed protocol: Alice supplies USDCx. The supply fetches the
# ProtocolConfig, which the Decentralized Party signs, so the party's hosts must confirm it.
HELPER=nodes/offline-helper
if [ ! -f "$HELPER/.daml/dist/lending-node-offline-0.0.1.dar" ]; then
  mkdir -p "$HELPER/daml"
  printf 'sdk-version: 3.5.12\nname: lending-node-offline\nsource: daml\nversion: 0.0.1\ndependencies: [daml-prim, daml-stdlib, daml-script]\ndata-dependencies:\n  - %s\n  - %s\n' "$TESTS_DAR" "$CORE_DAR" > "$HELPER/daml.yaml"
  cat > "$HELPER/daml/NodeOffline.daml" <<'DAML'
module NodeOffline where

import DA.Map qualified as Map
import DA.Text qualified as T
import Daml.Script

import Lending.Config
import Test.Lending.Env
import Test.Lending.DecManLocalNet (because)

data SupplyInput = SupplyInput with
    operator : Party
    prefix : Text
    amount : Decimal
  deriving (Eq, Show)

-- | Alice (from runOnExisting with the same prefix) supplies USDCx; the result is "accepted" or
-- "REJECTED: <reason>".
supplyOnExisting : SupplyInput -> Script Text
supplyOnExisting input = do
  configs <- query @ProtocolConfig input.operator
  config <- case configs of
    [(_, c)] -> pure c
    _ -> abort "expected one ProtocolConfig"
  known <- listKnownParties
  let named n = case [d.party | d <- known, (input.prefix <> n <> "-") `T.isPrefixOf` partyToText d.party] of
        p :: _ -> pure p
        [] -> abort ("no party " <> input.prefix <> n)
      collateral m = case Map.lookup m config.marketParams of
        Some p -> pure p.collateralInstrument
        None -> abort ("no market " <> m)
  alice <- named "Alice"
  bob <- named "Bob"
  carol <- named "Carol"
  cc <- collateral "CC"
  cbtc <- collateral "CBTC"
  let r = config.roles
      env = Env with
        operator = r.operator; oracle = r.oracle; guardian = r.guardian; treasury = r.treasury
        backstop = r.backstop; liquidator = r.operator; alice; bob; carol
        testers = []; council = []; usdcx = config.params.debtInstrument; cc; cbtc
  cmd <- supplyCmd env alice input.amount
  ds <- disclosures env
  res <- trySubmit (actAs alice <> discloseMany ds) cmd
  pure (because res)
DAML
  (cd "$HELPER" && dpm build > build.log 2>&1) || { tail -20 "$HELPER/build.log" >&2; exit 1; }
fi
supply() {
  t0=$SECONDS
  jq -n --arg op "$OP" --arg p "$PREFIX" --arg a "$1" '{operator: $op, prefix: $p, amount: $a}' > nodes/supply-in.json
  dpm script --dar "$HELPER/.daml/dist/lending-node-offline-0.0.1.dar" --script-name NodeOffline:supplyOnExisting \
    --participant-config state-participants.json --input-file nodes/supply-in.json --output-file nodes/supply-out.json \
    > nodes/supply.log 2>&1 || { sed 's/\x1b\[[0-9;]*m//g' nodes/supply.log | tail -20 >&2; return 1; }
  echo "  user: Alice supplies $1 USDCx ($(ts), took $((SECONDS - t0)) s with the script's JVM start): $(jq -r . nodes/supply-out.json | sed 's/ category = .*//' | cut -c1-200)"
}
propose() {
  jq -n --arg dp "$DP" --arg m1 "$M1" --arg op "$OP" --arg f "$1" --arg id "${PREFIX}offline-$1" \
    '{decParty:$dp, proposer:$m1, operator:$op, market:"CBTC", factor:$f, proposalId:$id}' > nodes/propose-in.json
  dpm script --dar "$TESTS_DAR" --script-name Test.Lending.DecManLocalNet:proposeOnExisting \
    --participant-config state-participants.json --input-file nodes/propose-in.json --output-file nodes/propose-out.json \
    > nodes/propose.log 2>&1 || { sed 's/\x1b\[[0-9;]*m//g' nodes/propose.log | tail -20 >&2; return 1; }
  jq -r . nodes/propose-out.json
}
pending() { curl -sf "localhost:$1/governance/confirmations?party_id=$DP" | jq --arg pc "$2" '.domain_actions[] | select(.proposal_cid == $pc)'; }
body() { jq -n --arg dp "$DP" --arg r "$RULES" --arg pc "$1" '{party_id:$dp, rules_contract_id:$r, action:{type:"governance_set_threshold", new_threshold:1}, governance_type:"core_domain", proposal_cid:$pc}'; }
# keep the ledger's verdict from a DecMan error: the error code and the failed requirement
brief() {
  sed -E -e 's/.*(MEDIATOR_SAYS_TX_TIMED_OUT\([^)]*\)): ([^"\\]*)[^(]*(\(HTTP [0-9]+\))$/REJECTED \1: \2 \3/' \
    -e "s/.*(AssertionFailed).*(The requirement '[^']*' was not met)[^(]*(\(HTTP [0-9]+\))\$/REJECTED \1: \2 \3/" | cut -c1-260
}
confirm() {
  t0=$SECONDS; r=$(post_raw "$1" /governance/confirm "$(body "$3")" | brief)
  echo "  member $2 confirms on DecMan :$1 ($(ts), took $((SECONDS - t0)) s): $r"
}
execute() {  # execute PORT PROPOSAL CIDS-JSON
  echo "  execute on DecMan :$1 with $(echo "$3" | jq length) confirmation(s) ($(ts)): $(post_raw "$1" /governance/execute "$(body "$2" | jq --argjson c "$3" '. + {confirmation_cids: $c}')" | brief)"
}
card() {  # card PORT PROPOSAL: the notification text DecMan shows its operator for the action
  for _ in $(seq 1 30); do [ -n "$(pending "$1" "$2")" ] && break; sleep 1; done
  echo "  DecMan :$1 lists it as: $(pending "$1" "$2" | jq -c '{action_label, description, confirmation_count}' | cut -c1-240)"
}
wait_count() {  # wait_count PORT PROPOSAL N: until DecMan on PORT sees N confirmations
  for _ in $(seq 1 30); do [ "$(pending "$1" "$2" | jq -r .confirmation_count)" -ge "$3" ] 2>/dev/null && return 0; sleep 1; done
}
factor_on() {  # factor_on JSON_PORT NAME
  end=$(ledger "$1" GET /v2/state/ledger-end | jq .offset)
  f=$(ledger "$1" POST /v2/state/active-contracts "{\"activeAtOffset\":$end,\"eventFormat\":{\"filtersByParty\":{\"$DP\":{\"cumulative\":[{\"identifierFilter\":{\"TemplateFilter\":{\"value\":{\"templateId\":\"#lending-core-v2:Lending.Config:ProtocolConfig\",\"includeCreatedEventBlob\":false}}}}]}},\"verbose\":true}}" \
    | jq -r --arg op "$OP" '.[] | .contractEntry.JsActiveContract.createdEvent.createArgument | select(.roles.operator == $op) | .marketParams[] | select(.[0] == "CBTC") | .[1].borrowCollateralFactor')
  echo "$2 ${f%%000000000000*}"
}
factors() { echo "  CBTC borrowCollateralFactor on each host's ledger: $(factor_on $J1 P1), $(factor_on $J2 P2), $(factor_on $J3 P3)"; }
offline() {  # offline ADMIN_PORT NAME
  admin "$1" $CONNECTIVITY/DisconnectSynchronizer '{"synchronizerAlias":"global"}' >/dev/null
  echo "  $2 OFFLINE ($(ts)): DisconnectSynchronizer(global); connected synchronizers now: [$(connected "$1")]"
}
online() {
  admin "$1" $CONNECTIVITY/ReconnectSynchronizer '{"synchronizerAlias":"global","retry":false}' >/dev/null
  for _ in $(seq 1 60); do [ "$(connected "$1")" = global ] && break; sleep 1; done
  echo "  $2 back ONLINE ($(ts)): connected synchronizers: [$(connected "$1")]"
}
hosts_up() { n=0; for a in $A1 $A2 $A3; do [ "$(connected $a)" = global ] && n=$((n + 1)); done; echo "$n of 3 hosts connected, threshold $(echo "$ptp" | jq -r .threshold)"; }

# whatever happens below, leave P2 and P3 connected
trap 'for a in $A2 $A3; do admin $a $CONNECTIVITY/ReconnectSynchronizer "{\"synchronizerAlias\":\"global\",\"retry\":false}" >/dev/null 2>&1 || true; done' EXIT

echo; echo "== start ($(ts)): $(hosts_up)"
factors

echo; echo "== A. P3 (sv) offline"
offline $A3 P3
echo "  $(hosts_up)"
PA=$(propose 0.35); echo "  member p1 proposes CBTC borrowCollateralFactor -> 0.35 (LendingParamsAction ${PA:0:16}…)"
card $P2 "$PA"
confirm $P1 p1 "$PA"; wait_count $P1 "$PA" 1
execute $P1 "$PA" "$(pending $P1 "$PA" | jq -c '.executable_confirmation_cids // [.confirmations[].confirmation_cid]')"
confirm $P2 p2 "$PA"; wait_count $P1 "$PA" 2
st=$(pending $P1 "$PA"); echo "  DecMan :$P1 sees: $(echo "$st" | jq -c '{confirmation_count, can_execute}')"
execute $P1 "$PA" "$(echo "$st" | jq -c .executable_confirmation_cids)"
factors
supply 100.0

echo; echo "== B. P2 (app-user) offline too: one host left"
offline $A2 P2
echo "  $(hosts_up)"
PB=$(propose 0.30); echo "  member p1 proposes CBTC borrowCollateralFactor -> 0.30 (${PB:0:16}…): created, the party is only an observer"
confirm $P1 p1 "$PB"
echo "  DecMan :$P1 sees: $(pending $P1 "$PB" | jq -c '{confirmation_count, can_execute}')"
supply 100.0
factors

echo; echo "== C. P2 and P3 back"
online $A2 P2; online $A3 P3
echo "  $(hosts_up)"
for _ in $(seq 1 30); do [ "$(factor_on $J3 P3)" = "P3 0.35" ] && break; sleep 1; done
factors
confirm $P1 p1 "$PB"; confirm $P2 p2 "$PB"; wait_count $P1 "$PB" 2
st=$(pending $P1 "$PB"); echo "  DecMan :$P1 sees: $(echo "$st" | jq -c '{confirmation_count, can_execute}')"
execute $P1 "$PB" "$(echo "$st" | jq -c .executable_confirmation_cids)"
for _ in $(seq 1 30); do [ "$(factor_on $J3 P3)" = "P3 0.30" ] && break; sleep 1; done
factors
supply 100.0
