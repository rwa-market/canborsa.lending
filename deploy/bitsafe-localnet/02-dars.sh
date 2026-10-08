#!/bin/bash
# Distributes the BitSafe governance DARs and the lending DARs to all three
# participants through DecMan's DARs workflow (P1 coordinates, P2/P3 accept).
# LENDING_DAML: the daml/ directory with built packages (sh scripts/daml.sh build).
set -eu
cd "$(dirname "$0")"; . ./lib.sh
DECMAN_DIR="${DECMAN_DIR:-$(cd "$(dirname "$0")" && pwd)/../../.local/decman}"
LENDING_DAML="${LENDING_DAML:-$(cd "$(dirname "$0")/../../daml" && pwd)}"
v() { sed -n 's/^version: *//p' "$LENDING_DAML/$1/daml.yaml"; }
dars=(
  "$DECMAN_DIR/releases/v1/governance-action-v1-0.1.0.dar"
  "$DECMAN_DIR/releases/v1/governance-core-v1-0.1.0.dar"
  "$LENDING_DAML/lending-core-v2/.daml/dist/lending-core-v2-$(v lending-core-v2).dar"
  "$LENDING_DAML/lending-governance-v2/.daml/dist/lending-governance-v2-$(v lending-governance-v2).dar"
  "$LENDING_DAML/lending-decman/.daml/dist/lending-decman-$(v lending-decman).dar"
  "$LENDING_DAML/lending-mocks/.daml/dist/lending-mocks-$(v lending-mocks).dar"
  "$LENDING_DAML/lending-tests/.daml/dist/lending-tests-$(v lending-tests).dar"
)
tmp=$(mktemp -d)
i=0
for f in "${dars[@]}"; do
  i=$((i + 1)); base64 < "$f" | tr -d '\n' > "$tmp/$i.b64"
  jq -n --arg n "$(basename "$f")" --rawfile d "$tmp/$i.b64" '{filename:$n, data:$d}' > "$tmp/$i.json"
done
echo "== DARs: ${#dars[@]} files"; for f in "${dars[@]}"; do echo "  $(basename "$f")"; done
jq -s '{dar_files: .}' "$tmp"/*.json > "$tmp/upload.json"
jq --arg p2 "$(pid_of $P2)" --arg p3 "$(pid_of $P3)" '. + {peer_ids: [$p2, $p3]}' "$tmp/upload.json" > "$tmp/dist.json"
curl -sf -X POST localhost:$P1/dars/upload -H 'Content-Type: application/json' -d @"$tmp/upload.json" >/dev/null
curl -sf -X POST localhost:$P1/dars/distribute -H 'Content-Type: application/json' -d @"$tmp/dist.json"; echo
rm -rf "$tmp"
accept_invitation $P2 Dars & accept_invitation $P3 Dars & wait
wait_status /dars/distribute/status
for port in $P1 $P2 $P3; do
  echo "  vetted on :$port: $(curl -sf localhost:$port/packages/vetted | jq -r '[.[] | .package_name | select(startswith("lending") or startswith("governance-"))] | unique | join(" ")')"
done
