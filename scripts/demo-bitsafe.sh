#!/bin/sh
# BitSafe challenge demo (T4.1.2) on an in-memory Daml ledger: a 2-of-3 council (demo) and a BitSafe
# Decentralized Party (demoDecMan) lower the CBTC Collateral Factor 50% -> 45%; a 50% borrow is then
# rejected and a 45% one accepted. No LocalNet needed: each step prints one line.
#   pnpm demo:bitsafe
set -eu
. "$(dirname "$0")/env.sh"
cd "$LENDING_ROOT/daml"
dpm build --all >/dev/null 2>&1 || { echo "dpm build failed: run sh scripts/daml.sh build" >&2; exit 1; }
cd lending-tests
dar=$(ls -t .daml/dist/lending-tests-*.dar | head -1)
for script in demo demoDecMan; do
  echo "== $script"
  # static time: quotes and ledger time agree, as in dpm test
  dpm script --dar "$dar" --script-name "Test.Lending.BitSafeDemo:$script" --ide-ledger --static-time 2>&1 \
    | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -E 'Prelude:[0-9]+\]: |FAILURE|SUCCESS' \
    | sed 's/.*Prelude:[0-9]*\]: \\"\(.*\)\\"$/\1/'
done
