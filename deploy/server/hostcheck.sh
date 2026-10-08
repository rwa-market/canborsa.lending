#!/bin/bash
# Host state snapshot for the external monitor (audit I-11). Once a minute, as lending.
# Public JSON without paths, names or secrets: only numbers and flags.
set -euo pipefail
ROOT=/opt/lending
disk_pct=$(df -P "$ROOT" | awk 'NR==2 {gsub("%","",$5); print $5}')
mem_avail_mb=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
swap_used_mb=$(awk '/^SwapTotal:/ {t=$2} /^SwapFree:/ {f=$2} END {print int((t-f)/1024)}' /proc/meminfo)
now=$(date -u +%s)
backup_at=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["at"])' "$ROOT/status/backup.json" 2>/dev/null || echo 0)
backup_age=$((backup_at > 0 ? now - backup_at : -1))
tmp=$(mktemp "$ROOT/status/.host.XXXXXX")
printf '{"at":%s,"diskUsedPct":%s,"memAvailableMb":%s,"swapUsedMb":%s,"backupAgeSec":%s}\n' \
  "$now" "$disk_pct" "$mem_avail_mb" "$swap_used_mb" "$backup_age" >"$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$ROOT/status/host-health.json"
