#!/bin/bash
# Backend state backup (audit I-10, B-11). Run by lending-backup.timer as root.
#   - indexer SQLite: online copy via the backup API (safe while the WAL writer is running),
#     then PRAGMA integrity_check on the copy;
#   - deployment.json (parties and instruments: the backend does not start without it);
#   - ledger tokens (/opt/lending/shared/tokens) are a secret, hence the 0600 archive and offsite encryption.
# Locally: /var/backups/lending/<UTC time>.tar.gz, kept for BACKUP_KEEP_DAYS (14) days.
# Offsite (optional, /etc/lending/backup.env): BACKUP_AGE_RECIPIENT=age1… encrypts the archive with
# `age`, BACKUP_RCLONE_REMOTE=remote:bucket/path copies it via rclone. Without them the copy is local only.
# The TestNet participant Postgres is backed up with the validator tooling (deploy/TESTNET.md).
set -euo pipefail
umask 077
ROOT=/opt/lending
OUT=/var/backups/lending
KEEP=${BACKUP_KEEP_DAYS:-14}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

db=$ROOT/shared/data/lending.db
if [ -f "$db" ]; then
  python3 - "$db" "$work/lending.db" <<'PY'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=30)
dst = sqlite3.connect(sys.argv[2])
with dst:
    src.backup(dst)
ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
if ok != "ok":
    sys.exit(f"integrity_check failed: {ok}")
PY
fi
[ -f "$ROOT/shared/deployment.json" ] && cp -p "$ROOT/shared/deployment.json" "$work/"
[ -d "$ROOT/shared/tokens" ] && cp -rp "$ROOT/shared/tokens" "$work/tokens"
[ -d "$ROOT/deployments" ] && cp -rp "$ROOT/deployments" "$work/deployments"

archive=$OUT/lending-$stamp.tar.gz
install -d -m 0700 "$OUT"
tar -C "$work" -czf "$archive" .
chmod 600 "$archive"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || { echo "age is not installed" >&2; exit 1; }
  age -r "$BACKUP_AGE_RECIPIENT" -o "$archive.age" "$archive"
  if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
    rclone copy --no-traverse "$archive.age" "$BACKUP_RCLONE_REMOTE/"
  fi
  rm -f "$archive.age"
elif [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  echo "BACKUP_RCLONE_REMOTE requires BACKUP_AGE_RECIPIENT: tokens are never copied off-host unencrypted" >&2
  exit 1
fi

find "$OUT" -maxdepth 1 -name 'lending-*.tar.gz' -mtime +"$KEEP" -delete
# old ledger-init databases (old-*): 7 days (audit I-10: they eat disk)
find "$ROOT/shared/data" -maxdepth 1 -type d -name 'old-*' -mtime +7 -exec rm -rf {} + 2>/dev/null || true

size=$(stat -c %s "$archive")
printf '{"at":%s,"bytes":%s}\n' "$(date -u +%s)" "$size" >"$ROOT/status/backup.json.tmp"
chmod 644 "$ROOT/status/backup.json.tmp"
mv -f "$ROOT/status/backup.json.tmp" "$ROOT/status/backup.json"
echo "backup $archive ($size bytes)"
