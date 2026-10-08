# curl/jq helpers for the DecMan HTTP API (localhost:8081..8083) and the
# LocalNet JSON Ledger API (P1 :3975, P2 :2975, P3 :4975).
P1=8081; P2=8082; P3=8083
J1=3975; J2=2975; J3=4975
# LocalNet's own development token (subject ledger-api-user, the LocalNet test secret): public in the
# Splice LocalNet docs, valid only against a local LocalNet
export TOKEN="eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJodHRwczovL2NhbnRvbi5uZXR3b3JrLmdsb2JhbCIsImlhdCI6MTc2Mzc0ODcwMiwic3ViIjoibGVkZ2VyLWFwaS11c2VyIn0.vpkfH4SoM9AZqbE38W4hrvl3xxy69jYs4u8gveskw9k"
pid_of() { curl -sf "localhost:$1/node-config" | jq -r .node.participant_id; }
post() { curl -sf -X POST "localhost:$1$2" -H 'Content-Type: application/json' -d "$3"; }
put() { curl -sf -X PUT "localhost:$1$2" -H 'Content-Type: application/json' -d "$3"; }
ledger() { curl -sf -X "$2" "localhost:$1$3" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' ${4:+-d "$4"}; }
# accept_invitation PORT TYPE: wait for a pending invitation of TYPE and accept it
accept_invitation() {
  for _ in $(seq 1 60); do
    id=$(curl -sf "localhost:$1/invitations" | jq -r --arg t "$2" '.invitations[] | select(.invitation_type == $t) | .id' | head -1)
    if [ -n "$id" ]; then post "$1" /invitations/accept "{\"id\":\"$id\"}" >/dev/null; echo "  node :$1 accepted $2 invitation $id"; return 0; fi
    sleep 1
  done
  echo "no $2 invitation on :$1" >&2; return 1
}
# wait_status PATH: poll the coordinator's workflow status until completed
wait_status() {
  for _ in $(seq 1 240); do
    s=$(curl -sf "localhost:$P1$1" | jq -r '.status // empty')
    case "$s" in
      completed|Completed) echo "  $1: completed"; return 0 ;;
      failed|Failed) echo "  $1: FAILED $(curl -sf localhost:$P1$1)" >&2; return 1 ;;
    esac
    sleep 2
  done
  echo "$1 timed out" >&2; return 1
}
# Canton Admin API of the participants (gRPC with server reflection), through `buf curl`.
A1=3902; A2=2902; A3=4902
CONNECTIVITY=admin.participant.v30.SynchronizerConnectivityService
TOPOLOGY=topology.admin.v30.TopologyManagerReadService
admin() {
  command -v buf >/dev/null || { echo "admin API calls need buf (brew install bufbuild/buf/buf)" >&2; return 1; }
  buf curl --protocol grpc --http2-prior-knowledge --data "$3" "http://localhost:$1/com.digitalasset.canton.$2"
}
# connected ADMIN_PORT: the synchronizer aliases this participant is connected to ("" when offline)
connected() { admin "$1" $CONNECTIVITY/ListConnectedSynchronizers '{}' | jq -r '[.connectedSynchronizers[]? | .synchronizerAlias] | join(",")'; }
# post_raw PORT PATH BODY: like post, but prints the response body and the HTTP status on failure too
post_raw() { curl -s -m "${POST_TIMEOUT:-120}" -X POST "localhost:$1$2" -H 'Content-Type: application/json' -d "$3" -w ' (HTTP %{http_code})'; }
