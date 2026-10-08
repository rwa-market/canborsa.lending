#!/bin/sh
# Login to the shared HackCanton DevNet node (NODERS hackcanton-01) with an Authfactory account.
# Asks for login and password, gets an offline refresh token and puts it in
# .local/devnet/tokens.json (in .gitignore). The password and token are not printed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REALM=${DEVNET_REALM:-https://keycloak.naas.noders.services/realms/noders-appsfactory}
CLIENT=${DEVNET_CLIENT_ID:-web-app-ui-hackcanton-01-devnet}
OUT="$ROOT/.local/devnet/tokens.json"

printf 'Authfactory login (email): '
read -r USERNAME
printf 'Password: '
stty -echo
read -r PASSWORD
stty echo
printf '\n'

mkdir -p "$(dirname "$OUT")"
umask 077
# the password goes to curl via stdin (printf is a builtin), not argv: it is not visible in ps (audit I-15)
printf '%s' "$PASSWORD" | curl -sf -X POST "$REALM/protocol/openid-connect/token" \
  --data-urlencode "client_id=$CLIENT" \
  --data-urlencode grant_type=password \
  --data-urlencode "scope=openid offline_access" \
  --data-urlencode "username=$USERNAME" \
  --data-urlencode password@- >"$OUT.tmp" || {
  rm -f "$OUT.tmp"
  echo 'login failed: check the login and password, or ask the organizers whether password login is enabled' >&2
  exit 1
}
unset PASSWORD
mv "$OUT.tmp" "$OUT"
python3 - "$OUT" <<'PY'
import base64, json, sys
t = json.load(open(sys.argv[1]))
claims = json.loads(base64.urlsafe_b64decode(t["access_token"].split(".")[1] + "=="))
print("saved", sys.argv[1])
print("user:", claims.get("preferred_username"), "| sub:", claims.get("sub"))
print("refresh token type:", t.get("refresh_token") and json.loads(base64.urlsafe_b64decode(t["refresh_token"].split(".")[1] + "==")).get("typ"))
PY
