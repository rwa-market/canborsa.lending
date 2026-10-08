#!/bin/bash
# Release of the backend and frontend to the server. Run by the Deploy workflow on a self-hosted runner
# as the deploy user (not as the lending service user). Root only via
# `sudo lending-ctl <exact command>` (deploy/server/sudoers.lending).
#
# Input: sources in GITHUB_WORKSPACE; backend (BACKEND_DIST) and frontend (FRONTEND_DIST)
# built in CI; GitHub environment variables and secrets in env.
# ROLLBACK_SHA=<sha>: rollback, switch the slot to the existing /opt/lending/releases/<sha>
# without a build and without the ledger (DARs are not rolled back, see deploy/TESTNET.md "Rollback").
#
# Host profile: /etc/lending/profile (setup.sh), only one: testnet, an external ledger (DevNet,
# TestNet, MainNet). release.sh never touches the ledger or DARs: packages are released separately
# (upgrade-check in CI, upload via the DevNet node console or scripts/deploy-testnet.sh).
#
# Zero-downtime, without Traefik:
#   1. the release is unpacked into /opt/lending/releases/<sha>, prod dependencies are installed there;
#   2. the free backend slot (blue/green) starts next to the live one and passes health;
#   3. lending-ctl switch switches the nginx upstream (+ CSP) and reloads;
#   4. the frontend switches by an atomic symlink swap, the old slot stops.
# Server journals are not printed to the Actions log (audit I-18): only an error code and a hint.
set -euo pipefail

ROOT=/opt/lending
PROFILE=$(cat /etc/lending/profile 2>/dev/null || true)
LEDGER_NETWORK=${LEDGER_NETWORK:-devnet}
: "${PUBLIC_HOST:?PUBLIC_HOST variable is required}"
: "${AUTH_SECRET:?AUTH_SECRET secret is required}"

die() {
  echo "::error::$*" >&2
  exit 1
}
step() { echo "::group::$*"; }
done_step() { echo "::endgroup::"; }
port_of() { [ "$1" = blue ] && echo 3001 || echo 3002; }
ctl() { sudo -n /usr/local/sbin/lending-ctl "$@"; }
is_true() { [[ ${1:-} =~ ^(true|1)$ ]]; }
# Value for backend.env: one line without control characters (audit I-15). lending-ctl checks it again.
env_line() {
  [[ $2 =~ ^[^[:cntrl:]]*$ ]] || die "$1 contains control characters or a newline"
  printf '%s=%s\n' "$1" "$2"
}

case "$PROFILE:$LEDGER_NETWORK" in
  testnet:devnet | testnet:testnet | testnet:mainnet) ;;
  *) die "host profile '${PROFILE:-none}' does not accept LEDGER_NETWORK=$LEDGER_NETWORK" ;;
esac
[[ $PUBLIC_HOST =~ ^[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "PUBLIC_HOST must be a host name or IP"
: "${LEDGER_API_URL:?LEDGER_API_URL variable is required}"
# The scheme is set by setup.sh: https with TLS_DOMAIN (audit I-3)
SCHEME=$(cat /etc/lending/public-scheme 2>/dev/null || echo http)
[ "$SCHEME" = https ] || die "a $LEDGER_NETWORK host must serve HTTPS (audit I-3)"

if [ -n "${ROLLBACK_SHA:-}" ]; then
  [[ $ROLLBACK_SHA =~ ^[0-9a-f]{40}$ ]] || die "ROLLBACK_SHA must be a full commit SHA"
  SHA=$ROLLBACK_SHA
  REL=$ROOT/releases/$SHA
  [ -f "$REL/backend/dist/server.js" ] || die "release $SHA is not on the server (kept: last 5)"
else
  WORKSPACE=${GITHUB_WORKSPACE:?}
  # the commit is the one in the working copy (in workflow_run GITHUB_SHA points to HEAD of main, not to the one CI checked)
  SHA=$(git -C "$WORKSPACE" rev-parse HEAD)
  [[ $SHA =~ ^[0-9a-f]{40}$ ]] || die "bad commit SHA"
  REL=$ROOT/releases/$SHA
  BACKEND_DIST=${BACKEND_DIST:?}
  FRONTEND_DIST=${FRONTEND_DIST:?}

  step "release $SHA"
  install -d "$REL"
  rsync -a --delete --exclude .git --exclude node_modules --exclude 'frontend/dist' --exclude 'backend/dist' \
    --exclude 'backend/data' --exclude '.local' --exclude '.env' --exclude '.env.*' "$WORKSPACE/" "$REL/"
  install -d "$REL/backend/dist" "$REL/frontend/dist"
  rsync -a --delete "$BACKEND_DIST/" "$REL/backend/dist/"
  rsync -a --delete "$FRONTEND_DIST/" "$REL/frontend/dist/"
  [ -f "$REL/backend/dist/server.js" ] || die "backend build has no dist/server.js"
  # prod dependencies: no tsx, vitest or other devDependencies on the server (audit I-13, I-14)
  (cd "$REL" && pnpm install --frozen-lockfile --prod --filter '@lending/backend...' --reporter=append-only)
  # release code is read-only for the services
  chmod -R go-w "$REL"
  done_step
fi

step "environment"
# Build it in full first (a value check error aborts the release before writing), then hand it to root
backend_env=$({
  # Settings from the GitHub environment: BACKEND_ENV (variable) and BACKEND_ENV_SECRETS (secret),
  # multi-line KEY=VALUE: everything that depends on the network (TOKEN_REGISTRY*, ORACLE_*, NETWORK_ID…).
  # Per-role ledger credentials never reach CI: /etc/lending/ledger-credentials.env on the server.
  if [ -n "${BACKEND_ENV:-}" ]; then printf '%s\n' "$BACKEND_ENV"; fi
  if [ -n "${BACKEND_ENV_SECRETS:-}" ]; then printf '%s\n' "$BACKEND_ENV_SECRETS"; fi
  env_line LOG_LEVEL "${LOG_LEVEL:-info}"
  env_line BOTS "${BOTS:-oracle,accounts,absorber,liquidator,backstop,merge,logins,indexer}"
  env_line ORACLE_MODE "${ORACLE_MODE:-live}"
  env_line RATE_LIMIT_PER_MINUTE "${RATE_LIMIT_PER_MINUTE:-600}"
  if [ -n "${NETWORK_ID:-}" ]; then env_line NETWORK_ID "$NETWORK_ID"; fi
  env_line LEDGER_API_URL "$LEDGER_API_URL"
  if [ -n "${LEDGER_USER_ID:-}" ]; then env_line LEDGER_USER_ID "$LEDGER_USER_ID"; fi
  # Immutable values last: in an EnvironmentFile the last assignment wins
  env_line LEDGER_NETWORK "$LEDGER_NETWORK"
  env_line HOST 127.0.0.1
  env_line DEPLOYMENT_PATH "$ROOT/shared/deployment.json"
  env_line DATABASE_PATH "$ROOT/shared/data/lending.db"
  env_line BOTS_LEASE_FILE "$ROOT/run/bots.lease"
  # behind nginx: X-Forwarded-For is trusted only from 127.0.0.1 (§9, audit I-5)
  env_line TRUST_PROXY true
  env_line TRUSTED_PROXIES 127.0.0.1
  env_line ALLOWED_HOSTS "$PUBLIC_HOST"
  env_line CORS_ORIGIN "$SCHEME://$PUBLIC_HOST"
  env_line AUTH_SECRET "$AUTH_SECRET"
  env_line RELEASE_SHA "$SHA"
  env_line LOG_FORMAT json
})
printf '%s\n' "$backend_env" | ctl install-env
unset backend_env

# Basic auth: the password goes to htpasswd via stdin, not argv (audit I-15). Without a password, access is open.
if [ -n "${BASIC_AUTH_PASSWORD:-}" ]; then
  [[ ${BASIC_AUTH_USER:-} =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "BASIC_AUTH_USER is required with BASIC_AUTH_PASSWORD"
  auth_line=$(printf '%s' "$BASIC_AUTH_PASSWORD" | htpasswd -niB "$BASIC_AUTH_USER" | head -1)
  [ -n "$auth_line" ] || die "htpasswd failed"
  printf '%s\n' "$auth_line" | ctl install-auth
else
  printf '' | ctl install-auth
fi
# External monitor token for /healthz/ready (MONITOR_TOKEN secret, the same one in the repository Actions secrets)
printf '%s' "${MONITOR_TOKEN:-}" | ctl install-monitor-token
done_step

step "backend blue/green"
active=$(cat "$ROOT/run/active-slot" 2>/dev/null || echo none)
next=$([ "$active" = blue ] && echo green || echo blue)
port=$(port_of "$next")
ln -sfn "$REL" "$ROOT/slots/$next"
ctl slot restart "$next"
healthy=
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$port/health" | jq -e '.ledger == "connected"' >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
if [ -z "$healthy" ]; then
  ctl slot stop "$next"
  die "slot $next is not healthy, $active keeps serving; on the server: journalctl -u lending-backend@$next -n 100"
fi
# CSP: extra sources (node, Keycloak, Loop API) are GitHub environment variables, lending-ctl validates them
{
  echo "CSP_MODE=${CSP_MODE:-enforce}"
  if [ -n "${CSP_CONNECT_SRC:-}" ]; then echo "CSP_CONNECT_SRC=$CSP_CONNECT_SRC"; fi
  if [ -n "${CSP_IMG_SRC:-}" ]; then echo "CSP_IMG_SRC=$CSP_IMG_SRC"; fi
  if [ -n "${CSP_FRAME_SRC:-}" ]; then echo "CSP_FRAME_SRC=$CSP_FRAME_SRC"; fi
} | ctl switch "$next"
ln -sfn "$REL/frontend/dist" "$ROOT/frontend/.current.tmp"
mv -Tf "$ROOT/frontend/.current.tmp" "$ROOT/frontend/current"
ctl slot enable "$next" >/dev/null 2>&1
if [ "$active" != none ]; then
  sleep 5 # nginx finishes requests on the old slot
  ctl slot stop "$active"
  ctl slot disable "$active" >/dev/null 2>&1
fi
echo "$next" >"$ROOT/run/active-slot"
echo "active slot: $next (:$port)"
done_step

step "smoke"
host=${PUBLIC_HOST%%:*}
if [ "$SCHEME" = https ]; then
  base="https://$host"
  resolve=(--resolve "$host:443:127.0.0.1")
else
  base="http://127.0.0.1"
  resolve=(-H "Host: $PUBLIC_HOST")
fi
curl -sf "${resolve[@]}" "$base/healthz" | jq -c '{status, ledger}'
# basic auth via a config on stdin, not argv (audit I-15)
curl_auth() {
  if [ -n "${BASIC_AUTH_PASSWORD:-}" ]; then
    local u=${BASIC_AUTH_USER//\\/\\\\} p=${BASIC_AUTH_PASSWORD//\\/\\\\}
    u=${u//\"/\\\"}
    p=${p//\"/\\\"}
    printf 'user = "%s:%s"\n' "$u" "$p" | curl -K - "$@"
  else
    curl "$@"
  fi
}
curl_auth -sf "${resolve[@]}" "$base/api/pool" | jq -c '{supplied: .totalSupplied, governed}'
curl_auth -sf -o /dev/null "${resolve[@]}" "$base/"
done_step

step "cleanup"
keep="$(readlink -f "$ROOT/slots/blue" 2>/dev/null || true) $(readlink -f "$ROOT/slots/green" 2>/dev/null || true)"
# the last five releases are kept for rollback (ROLLBACK_SHA)
find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d' ' -f2- |
  while read -r dir; do
    case " $keep " in *" $dir "*) continue ;; esac
    rm -rf "$dir"
  done
done_step
echo "deployed $SHA to $SCHEME://$PUBLIC_HOST"
