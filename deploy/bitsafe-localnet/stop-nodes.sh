#!/bin/bash
# Stops the three DecMan nodes (they ignore SIGTERM: TERM, then KILL) and removes their data.
cd "$(dirname "$0")"
[ -f nodes/pids ] && for p in $(cat nodes/pids); do kill "$p" 2>/dev/null; done
sleep 2
[ -f nodes/pids ] && for p in $(cat nodes/pids); do kill -9 "$p" 2>/dev/null; done
rm -rf nodes state-*.json input-*.json result-*.json propose-*.json proposal-*.json *.log
echo "DecMan nodes stopped"
