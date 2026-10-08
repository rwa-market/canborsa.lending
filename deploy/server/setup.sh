#!/bin/bash
# Prepares the server for deploys from GitHub Actions. Idempotent, as root. From a workstation:
#   rsync -aR deploy master@HOST:/tmp/lending-deploy/
#   ssh master@HOST 'sudo TLS_DOMAIN=lend.example CERTBOT_EMAIL=none REPO_DIR=/tmp/lending-deploy bash /tmp/lending-deploy/deploy/server/setup.sh'
#
# Parameters (env):
#   PROFILE=testnet           the only profile: backend and frontend, the ledger is an external participant
#                             (DevNet, TestNet, MainNet)
#   TLS_DOMAIN=lend.example   domain: nginx with TLS (Let's Encrypt, certbot --webroot), HSTS, 80 -> 443.
#                             Required (audit I-3).
#   CERTBOT_EMAIL=ops@…       email for Let's Encrypt (required together with TLS_DOMAIN);
#                             none: register without an email (no expiry emails)
#   CLOUDFLARE=full|flexible  the domain is behind the Cloudflare proxy: client IP from CF-Connecting-IP;
#                             flexible — the zone SSL mode is Flexible, Cloudflare edges get the app on :80
#   NODESOURCE_KEY_FPR=…      fingerprint of the NodeSource apt repository key; if set, it is verified
#
# Users (audit I-2, I-14):
#   deploy  - GitHub runner: unpacks releases, sudo only for the exact lending-ctl commands;
#   lending - services (backend): no sudo, no login, release code is read-only for it.
# Backend secrets: /etc/lending/backend.env (root, 0600), only systemd reads them.
set -euo pipefail
REPO_DIR=${REPO_DIR:-/tmp/lending-deploy}
PROFILE=${PROFILE:-testnet}
TLS_DOMAIN=${TLS_DOMAIN:-}
CLOUDFLARE=${CLOUDFLARE:-}
NODE_MAJOR=24
PNPM_VERSION=10.33.0
SRV=$REPO_DIR/deploy

[[ $CLOUDFLARE =~ ^(|full|flexible)$ ]] || { echo "CLOUDFLARE must be full or flexible" >&2; exit 1; }
[[ $PROFILE == testnet ]] || { echo "PROFILE must be testnet (the sandbox profile is gone)" >&2; exit 1; }
if [ -n "$TLS_DOMAIN" ]; then
  [[ $TLS_DOMAIN =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "bad TLS_DOMAIN" >&2; exit 1; }
  : "${CERTBOT_EMAIL:?CERTBOT_EMAIL is required with TLS_DOMAIN}"
else
  echo "TLS_DOMAIN is required: no public launch over plain HTTP (audit I-3)" >&2
  exit 1
fi
echo 'vm.swappiness=20' >/etc/sysctl.d/99-lending.conf
sysctl -q -p /etc/sysctl.d/99-lending.conf

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# build-essential is only a fallback for building better-sqlite3 when there is no prebuilt binary
pkgs=(nginx curl git jq rsync build-essential python3 apache2-utils ufw ca-certificates gnupg age)
[ -n "$TLS_DOMAIN" ] && pkgs+=(certbot)
apt-get install -y -qq "${pkgs[@]}" >/dev/null

# Node from the NodeSource apt repository with the key in a keyring, no `curl | bash` (audit I-13)
if ! node -v 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  key=$(mktemp)
  curl -fsSL --proto '=https' -o "$key" https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key
  fpr=$(gpg --show-keys --with-colons "$key" | awk -F: '/^fpr:/ {print $10; exit}')
  if [ -n "${NODESOURCE_KEY_FPR:-}" ] && [ "$fpr" != "$NODESOURCE_KEY_FPR" ]; then
    echo "NodeSource key fingerprint $fpr != pinned $NODESOURCE_KEY_FPR" >&2
    exit 1
  fi
  echo "NodeSource key fingerprint: $fpr"
  gpg --dearmor <"$key" >/usr/share/keyrings/nodesource.gpg
  chmod 644 /usr/share/keyrings/nodesource.gpg
  rm -f "$key"
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
npm install -g "pnpm@${PNPM_VERSION}" >/dev/null 2>&1

# Users: deploy (runner) and lending (services). Neither needs password login or ssh.
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
passwd -l deploy >/dev/null
# deploy used to read service journals and print them to the public Actions log (audit I-18)
gpasswd -d deploy systemd-journal >/dev/null 2>&1 || true
id lending >/dev/null 2>&1 || useradd --system --home-dir /var/lib/lending --create-home --shell /usr/sbin/nologin lending
passwd -l lending >/dev/null
chmod 750 /var/lib/lending

# Directories: code belongs to deploy (lending only reads), state to lending, config and secrets to root
install -d -m 0755 -o root -g root /opt/lending /opt/lending/bin
install -d -m 0755 -o deploy -g deploy /opt/lending/releases /opt/lending/slots /opt/lending/frontend
install -d -m 0750 -o deploy -g deploy /opt/lending/stage /opt/lending/stage/dars
install -d -m 2770 -o deploy -g lending /opt/lending/run
install -d -m 2750 -o lending -g www-data /opt/lending/status
install -d -m 0750 -o lending -g lending /opt/lending/shared
install -d -m 0700 -o lending -g lending /opt/lending/shared/data /opt/lending/shared/tokens
install -d -m 0755 -o root -g root /etc/lending
# secrets of the role OIDC clients (LEDGER_<ROLE>_CLIENT_SECRET_FILE): only the service reads them
install -d -m 0750 -o root -g lending /etc/lending/credentials
install -d -m 0700 -o root -g root /var/backups/lending
echo "$PROFILE" >/etc/lending/profile
if [ -n "$TLS_DOMAIN" ]; then echo https; else echo http; fi >/etc/lending/public-scheme
chmod 644 /etc/lending/profile /etc/lending/public-scheme
for slot in blue green; do
  port=$([ "$slot" = blue ] && echo 3001 || echo 3002)
  echo "PORT=$port" >"/etc/lending/slot-$slot.env"
  chmod 644 "/etc/lending/slot-$slot.env"
done
[ -f /etc/lending/backup.env ] || install -m 0600 /dev/null /etc/lending/backup.env

# Migration from the old layout: secrets and data used to belong to deploy
if [ -f /opt/lending/shared/backend.env ]; then
  [ -f /etc/lending/backend.env ] || install -m 0600 /opt/lending/shared/backend.env /etc/lending/backend.env
  shred -u /opt/lending/shared/backend.env 2>/dev/null || rm -f /opt/lending/shared/backend.env
fi
rm -f /opt/lending/shared/slot-*.env /opt/lending/ledger/run-sandbox.sh /opt/lending/ledger/ledger-init.sh
rm -f /etc/sudoers.d/91-deploy
chown -R lending:lending /opt/lending/shared
[ -f /opt/lending/run/bots.lease ] && chown lending:lending /opt/lending/run/bots.lease

# Scripts run by root or lending: owned by root, deploy cannot change them
install -m 0755 -o root -g root "$SRV/server/lending-ctl" /usr/local/sbin/lending-ctl
for f in backup.sh hostcheck.sh; do install -m 0755 -o root -g root "$SRV/server/$f" /opt/lending/bin/; done

# systemd
units=(lending-backend@.service lending-backup.service lending-backup.timer lending-hostcheck.service lending-hostcheck.timer)
for u in "${units[@]}"; do install -m 644 "$SRV/systemd/$u" /etc/systemd/system/; done
# Host with the old sandbox profile: remove the in-memory ledger and its watchdogs
for u in lending-sandbox.service lending-ledger-init.service lending-loguard.service; do
  systemctl disable --now "$u" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$u"
done
rm -f /opt/lending/bin/run-sandbox.sh /opt/lending/bin/ledger-init.sh /opt/lending/bin/loguard.sh
systemctl daemon-reload
systemctl enable --now lending-backup.timer lending-hostcheck.timer >/dev/null 2>&1

# sudo for deploy: only the exact lending-ctl command lines (audit I-2)
install -m 0440 -o root -g root "$SRV/server/sudoers.lending" /etc/sudoers.d/91-lending.tmp
visudo -cf /etc/sudoers.d/91-lending.tmp >/dev/null
mv -f /etc/sudoers.d/91-lending.tmp /etc/sudoers.d/91-lending

# nginx: snippets and site from the repository, root:root. Upstream, CSP and basic auth are written by lending-ctl.
install -m 644 "$SRV/nginx/lending-limits.conf" /etc/nginx/conf.d/lending-limits.conf
if [ -n "$CLOUDFLARE" ]; then
  install -m 644 "$SRV/nginx/lending-cloudflare.conf" /etc/nginx/conf.d/lending-cloudflare.conf
else
  rm -f /etc/nginx/conf.d/lending-cloudflare.conf
fi
install -d /etc/nginx/snippets
install -m 644 "$SRV/nginx/lending-security-headers.conf" /etc/nginx/snippets/
install -m 644 "$SRV/nginx/lending-locations.conf" /etc/nginx/snippets/
[ -f /etc/nginx/lending-upstream.conf ] || echo 'server 127.0.0.1:3001;' >/etc/nginx/lending-upstream.conf
# shellcheck disable=SC2016 # nginx variables, not shell
if [ ! -f /etc/nginx/lending-csp.conf ]; then
  printf '%s\n' "set \$lending_csp \"default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\";" \
    'set $lending_csp_report_only "";' >/etc/nginx/lending-csp.conf
fi
[ -f /etc/nginx/lending-auth.conf ] || echo 'auth_basic off;' >/etc/nginx/lending-auth.conf
# shellcheck disable=SC2016
if [ ! -f /etc/nginx/lending-monitor.conf ]; then
  printf 'map $http_authorization $lending_monitor_ok {\n    default 0;\n}\n' >/etc/nginx/lending-monitor.conf
  chown root:www-data /etc/nginx/lending-monitor.conf
  chmod 640 /etc/nginx/lending-monitor.conf
fi
if [ -f /etc/nginx/lending.htpasswd ]; then chown root:www-data /etc/nginx/lending.htpasswd && chmod 640 /etc/nginx/lending.htpasswd; fi
# The backend has no dev routes; nginx also closes the path itself, in case an old release comes back on rollback
printf 'location ^~ /api/dev/ {\n    return 404;\n}\n' >/etc/nginx/lending-profile.conf
chown root:root /etc/nginx/lending-upstream.conf /etc/nginx/lending-csp.conf /etc/nginx/lending-auth.conf /etc/nginx/lending-profile.conf
chmod 644 /etc/nginx/lending-upstream.conf /etc/nginx/lending-csp.conf /etc/nginx/lending-auth.conf /etc/nginx/lending-profile.conf

if [ ! -e /opt/lending/frontend/current ]; then
  install -d -o deploy -g deploy /opt/lending/frontend/empty
  echo '<!doctype html><title>Canton Lending</title><p>Deploy pending.</p>' >/opt/lending/frontend/empty/index.html
  ln -sfn /opt/lending/frontend/empty /opt/lending/frontend/current
fi
rm -f /etc/nginx/sites-enabled/default

site=/etc/nginx/sites-available/lending.conf
if [ -n "$TLS_DOMAIN" ]; then
  cert_dir=/etc/letsencrypt/live/$TLS_DOMAIN
  install -d -m 755 /var/www/letsencrypt
  if [ ! -f "$cert_dir/fullchain.pem" ]; then
    # First issuance: a temporary HTTP server with acme-challenge only
    cat >"$site" <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; default_type text/plain; }
    location / { return 404; }
}
NGINX
    ln -sfn "$site" /etc/nginx/sites-enabled/lending.conf
    nginx -t -q
    systemctl enable --now nginx >/dev/null 2>&1
    systemctl reload nginx
    ufw allow 'Nginx Full' >/dev/null
    certbot certonly --webroot -w /var/www/letsencrypt -d "$TLS_DOMAIN" \
      $([ "$CERTBOT_EMAIL" = none ] && echo --register-unsafely-without-email || echo --email "$CERTBOT_EMAIL") \
      --agree-tos --non-interactive --no-eff-email
  fi
  install -d /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\nsystemctl reload nginx\n' >/etc/letsencrypt/renewal-hooks/deploy/lending-nginx-reload
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/lending-nginx-reload
  sed -e "s|__SERVER_NAME__|$TLS_DOMAIN|g" -e "s|__CERT_DIR__|$cert_dir|g" "$SRV/nginx/lending-tls.conf" >"$site"
  if [ "$CLOUDFLARE" = flexible ]; then
    sed -e "s|__SERVER_NAME__|$TLS_DOMAIN|g" "$SRV/nginx/lending-cloudflare-flexible.conf" >>"$site"
  fi
fi
chmod 644 "$site"
ln -sfn "$site" /etc/nginx/sites-enabled/lending.conf
nginx -t -q
systemctl enable --now nginx >/dev/null 2>&1
systemctl reload nginx

# Firewall: only ssh and http(s) from outside. Backend ports listen on 127.0.0.1.
ufw allow OpenSSH >/dev/null
if [ -n "$TLS_DOMAIN" ]; then ufw allow 'Nginx Full' >/dev/null; else ufw allow 'Nginx HTTP' >/dev/null; fi
ufw --force enable >/dev/null

echo "setup done ($PROFILE${TLS_DOMAIN:+, https://$TLS_DOMAIN}): node $(node -v), pnpm $(pnpm -v)"
