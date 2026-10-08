#!/bin/bash
# Allocates one governance member party per participant, grants ledger-api-user
# act/read rights on it and on the Decentralized Party, registers the party in
# each DecMan node, and deploys 2-of-3 GovernanceRules on the Decentralized
# Party through DecMan's contracts workflow (multi-signed by the owner keys).
# Writes state-input.json for the Daml script.
set -eu
cd "$(dirname "$0")"; . ./lib.sh
DP=$(jq -r .party_id state-decparty.json)
alloc() { ledger $1 POST /v2/parties "{\"partyIdHint\":\"$2\",\"identityProviderId\":\"\"}" | jq -r .partyDetails.party; }
grant() { ledger $1 POST /v2/users/ledger-api-user/rights "{\"userId\":\"ledger-api-user\",\"identityProviderId\":\"\",\"rights\":[{\"kind\":{\"CanActAs\":{\"value\":{\"party\":\"$2\"}}}},{\"kind\":{\"CanReadAs\":{\"value\":{\"party\":\"$2\"}}}}]}" >/dev/null; }
M=()
i=0
for j in $J1 $J2 $J3; do
  i=$((i + 1))
  m=$(alloc $j "lending-member-p$i"); M+=("$m")
  grant $j "$m"; grant $j "$DP"
  echo "  member p$i: $m (JSON API :$j)"
done
k=0
for port in $P1 $P2 $P3; do
  put $port /party-config "{\"dec_party_id\":\"$DP\",\"member_party_id\":\"${M[$k]}\",\"user_id\":\"ledger-api-user\",\"keycloak_url\":\"\",\"keycloak_realm\":\"\",\"keycloak_client_id\":\"\",\"packages\":{\"governance_action\":\"#governance-action-v1\",\"governance_core\":\"#governance-core-v1\"}}" >/dev/null
  k=$((k + 1))
done
uids=$(jq -c '[.participants[].participant_uid]' state-decparty.json)
req=$(jq -n --arg dp "$DP" --argjson uids "$uids" --arg m1 "${M[0]}" --arg m2 "${M[1]}" --arg m3 "${M[2]}" '{
  decentralized_party_id: $dp, participant_ids: $uids, participant_parties: [$m1, $m2, $m3], operator_party: $m1,
  contracts: [{id: "governance-rules", name: "GovernanceRules", package_id: "#governance-core-v1",
    module_name: "Governance.Rules", entity_name: "GovernanceRules",
    fields: [{type: "decentralized_party"}, {type: "party_set", parties: [$m1, $m2, $m3]},
             {type: "int64", value: 2}, {type: "rel_time", microseconds: 3600000000}, {type: "none"}]}]}')
echo "== GovernanceRules on $DP: members p1 p2 p3, threshold 2"
post $P1 /contracts "$req"; echo
accept_invitation $P2 Contracts & accept_invitation $P3 Contracts & wait
wait_status /contracts/status
# the rules contract as the Decentralized Party sees it on P1
end=$(ledger $J1 GET /v2/state/ledger-end | jq .offset)
acs=$(ledger $J1 POST /v2/state/active-contracts "{\"activeAtOffset\":$end,\"eventFormat\":{\"filtersByParty\":{\"$DP\":{\"cumulative\":[{\"identifierFilter\":{\"TemplateFilter\":{\"value\":{\"templateId\":\"#governance-core-v1:Governance.Rules:GovernanceRules\",\"includeCreatedEventBlob\":false}}}}]}},\"verbose\":true}}")
RULES=$(echo "$acs" | jq -r '[.[] | .contractEntry.JsActiveContract.createdEvent.contractId] | first')
echo "$acs" | jq '[.[] | .contractEntry.JsActiveContract.createdEvent | {contractId, signatories, createArgument}] | first' > state-rules.json
echo "  GovernanceRules: $RULES"
jq -n --arg dp "$DP" --arg r "$RULES" --arg m1 "${M[0]}" --arg m2 "${M[1]}" --arg m3 "${M[2]}" --arg prefix "run1-" \
  '{decParty: $dp, rulesCid: $r, members: [$m1, $m2, $m3], prefix: $prefix}' > state-input.json
jq -n --arg m1 "${M[0]}" --arg m2 "${M[1]}" --arg m3 "${M[2]}" '{
  default_participant: {host: "localhost", port: 3901, access_token: $ENV.TOKEN},
  participants: {p2: {host: "localhost", port: 2901, access_token: $ENV.TOKEN}, p3: {host: "localhost", port: 4901, access_token: $ENV.TOKEN}},
  party_participants: {($m2): "p2", ($m3): "p3"}}' > state-participants.json
cat state-input.json
