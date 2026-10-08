# shellcheck shell=sh
# Shared environment for scripts: dpm and JDK 17 without editing ~/.zshrc.
# Usage: . scripts/env.sh
if [ -z "${JAVA_HOME:-}" ] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -qE 'version "(1[7-9]|[2-9][0-9])'; then
  for candidate in /opt/homebrew/opt/openjdk@17 /usr/local/opt/openjdk@17 /usr/lib/jvm/java-17-openjdk-amd64; do
    if [ -x "$candidate/bin/java" ]; then JAVA_HOME=$candidate; break; fi
  done
  export JAVA_HOME
fi
export PATH="$HOME/.dpm/bin:$JAVA_HOME/bin:$PATH"
# Repository root: from the script path (`sh scripts/x.sh`), and with `. scripts/env.sh` straight from
# the shell ($0 = bash or sh), from the current directory, as in CI steps
if [ -f "$(dirname "$0")/env.sh" ]; then
  LENDING_ROOT=$(cd "$(dirname "$0")/.." && pwd)
else
  LENDING_ROOT=$(pwd)
fi
export LENDING_ROOT
# Path to a package's built DAR by the version in its daml.yaml (no hardcoded versions, audit I-19):
#   lending_dar lending-core-v2 → $LENDING_ROOT/daml/lending-core-v2/.daml/dist/lending-core-v2-1.0.3.dar
lending_dar() {
  _v=$(sed -n 's/^version: *//p' "$LENDING_ROOT/daml/$1/daml.yaml" | head -1)
  echo "$LENDING_ROOT/daml/$1/.daml/dist/$1-$_v.dar"
}
