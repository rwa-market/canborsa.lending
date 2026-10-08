#!/bin/bash
# Release of the protocol to the persistent TestNet ledger (audit I-7, I-8, I-9; agreement §5).
# Run by the operator from their own machine or an admin host, NOT CI: the participant admin token
# (package upload) is not stored in GitHub. Order and context: deploy/TESTNET.md.
#
#   bash scripts/deploy-testnet.sh check     build, SCU upgrade-check against daml/released, package-id,
#                                            DAR check on the participant (POST /v2/dars/validate)
#   bash scripts/deploy-testnet.sh upload    upload only lending-core-v2, lending-governance-v2 and lending-decman
#                                            (no mocks, tests or test token); VET=false: no vetting
#   bash scripts/deploy-testnet.sh deploy    Lending.Deploy.Prod:deployProd once: input DEPLOY_INPUT,
#                                            output DEPLOYMENT_OUT in the same shape as backend/deployment.json
#   bash scripts/deploy-testnet.sh status    API version, whether the protocol packages are uploaded
#
# Setup: cp deploy/testnet.env.example deploy/testnet.env (in .gitignore), or TESTNET_ENV=<path>.
# Tokens are files only (0600), never in argv or in the output (audit I-15).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
. "$ROOT/scripts/env.sh"
ENV_FILE=${TESTNET_ENV:-$ROOT/deploy/testnet.env}
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE: cp deploy/testnet.env.example deploy/testnet.env" >&2; exit 2; }
# shellcheck source=/dev/null
. "$ENV_FILE"

die() {
  echo "deploy-testnet: $*" >&2
  exit 1
}
: "${LEDGER_NETWORK:?}" "${LEDGER_JSON_API:?}" "${LEDGER_GRPC_HOST:?}"
[[ $LEDGER_NETWORK =~ ^(devnet|testnet|mainnet)$ ]] || die "LEDGER_NETWORK must be devnet, testnet or mainnet"
[[ $LEDGER_JSON_API =~ ^https:// ]] || die "LEDGER_JSON_API must be https:// (audit I-17: TLS to the participant)"
LEDGER_GRPC_PORT=${LEDGER_GRPC_PORT:-443}
DEPLOY_INPUT=${DEPLOY_INPUT:-$ROOT/deploy/testnet.deploy-input.json}
DEPLOYMENT_OUT=${DEPLOYMENT_OUT:-$ROOT/deploy/testnet.deployment.json}
# Packages that go to the ledger. Mocks, tests and splice-test-token are never included (I-8).
UPLOAD_PACKAGES=(lending-core-v2 lending-governance-v2 lending-decman)

token_file() { # name of the variable holding the path → checked path
  local path=${!1:-}
  [ -n "$path" ] || die "$1 is not set in $ENV_FILE"
  [ -f "$path" ] || die "$1: $path does not exist"
  if [ "$(uname)" = Darwin ]; then mode=$(stat -f %Lp "$path"); else mode=$(stat -c %a "$path"); fi
  [[ $mode =~ ^[0-7]00$ ]] || die "$1: $path must be readable by the owner only (chmod 600)"
  echo "$path"
}
# Authorization header in a temp file 0600: curl reads it via -H @file, the token is not in argv
auth_header() {
  local tok hdr
  tok=$(token_file "$1")
  hdr=$(mktemp)
  chmod 600 "$hdr"
  printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' <"$tok")" >"$hdr"
  echo "$hdr"
}
api() { # token-var method path [curl args…]
  local hdr code
  hdr=$(auth_header "$1")
  shift
  code=$(curl -sS -o "$WORK/body" -w '%{http_code}' -H @"$hdr" -X "$1" "$LEDGER_JSON_API$2" "${@:3}") || code=000
  rm -f "$hdr"
  echo "$code"
}
package_id() { dpm damlc inspect-dar --json "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["main_package_id"])'; }
dar_path() {
  local p
  p=$(lending_dar "$1")
  [ -f "$p" ] || die "$p is not built: sh scripts/daml.sh build"
  echo "$p"
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cmd_check() {
  sh "$ROOT/scripts/daml.sh" upgrade-check
  for pkg in "${UPLOAD_PACKAGES[@]}"; do
    dar=$(dar_path "$pkg")
    echo "$pkg $(basename "$dar") package-id $(package_id "$dar")"
    code=$(api ADMIN_TOKEN_FILE POST /v2/dars/validate -H 'content-type: application/octet-stream' --data-binary @"$dar")
    [ "$code" = 200 ] || die "validate $pkg: HTTP $code $(head -c 400 "$WORK/body")"
    echo "  validate on participant: ok"
  done
  echo "record these package-ids in the release note (deploy/TESTNET.md, \"Releasing a package\")"
}

cmd_upload() {
  local vet=${VET:-true}
  [[ $vet =~ ^(true|false)$ ]] || die "VET must be true or false"
  for pkg in "${UPLOAD_PACKAGES[@]}"; do
    dar=$(dar_path "$pkg")
    case "$(basename "$dar")" in *mock* | *test*) die "refusing to upload $dar" ;; esac
    code=$(api ADMIN_TOKEN_FILE POST "/v2/dars?vetAllPackages=$vet" \
      -H 'content-type: application/octet-stream' --data-binary @"$dar")
    [ "$code" = 200 ] || die "upload $pkg: HTTP $code $(head -c 400 "$WORK/body")"
    echo "uploaded $(basename "$dar") ($(package_id "$dar")), vetAllPackages=$vet"
  done
  [ "$vet" = true ] || echo "packages are NOT vetted: vet them at the switch-over date (deploy/TESTNET.md)"
}

cmd_deploy() {
  [ -f "$DEPLOY_INPUT" ] || die "no $DEPLOY_INPUT: cp deploy/testnet.deploy-input.example.json and fill in parties and InstrumentIds"
  if [ -e "$DEPLOYMENT_OUT" ] && [ "${FORCE:-}" != 1 ]; then
    die "$DEPLOYMENT_OUT exists: the protocol is already deployed on this ledger (FORCE=1 to deploy a second instance)"
  fi
  grep -q '"Alice"\|"Tester\|DemoDSO\|__FILL' "$DEPLOY_INPUT" && die "$DEPLOY_INPUT has demo parties or unfilled placeholders"
  deploy_dar=$(dar_path lending-deploy)
  tok=$(token_file DEPLOYER_TOKEN_FILE)
  tls=(--tls)
  if [ -n "${LEDGER_GRPC_CA:-}" ]; then tls+=(--cacrt "$LEDGER_GRPC_CA"); fi
  # dpm script does not upload lending-deploy to the ledger: the script runs on the client
  (cd "$ROOT/daml" && dpm script \
    --ledger-host "$LEDGER_GRPC_HOST" --ledger-port "$LEDGER_GRPC_PORT" "${tls[@]}" \
    --access-token-file "$tok" \
    --dar "$deploy_dar" \
    --script-name Lending.Deploy.Prod:deployProd \
    --input-file "$DEPLOY_INPUT" \
    --output-file "$WORK/deployment.json")
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$WORK/deployment.json"
  install -m 600 "$WORK/deployment.json" "$DEPLOYMENT_OUT"
  echo "deployment written to $DEPLOYMENT_OUT; copy it to the backend host: /opt/lending/shared/deployment.json (owner lending, 0640)"
}

cmd_status() {
  code=$(api READ_TOKEN_FILE GET /v2/version)
  echo "participant API: HTTP $code $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version",""))' "$WORK/body" 2>/dev/null || true)"
  code=$(api READ_TOKEN_FILE GET /v2/packages)
  [ "$code" = 200 ] || die "packages: HTTP $code"
  for pkg in "${UPLOAD_PACKAGES[@]}"; do
    dar=$(dar_path "$pkg")
    pid=$(package_id "$dar")
    if grep -q "$pid" "$WORK/body"; then echo "  uploaded  $(basename "$dar") $pid"; else echo "  MISSING   $(basename "$dar") $pid"; fi
  done
}

case "${1:-}" in
  check) cmd_check ;;
  upload) cmd_upload ;;
  deploy) cmd_deploy ;;
  status) cmd_status ;;
  *)
    sed -n '2,16p' "$0"
    exit 2
    ;;
esac
