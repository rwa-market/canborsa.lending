#!/bin/sh
# Developer environment check: pnpm doctor
. "$(dirname "$0")/env.sh"
fail=0
check() {
  name=$1; shift
  if out=$("$@" 2>&1 | head -1); then printf '  ok   %-8s %s\n' "$name" "$out"
  else printf '  FAIL %-8s not found\n' "$name"; fail=1; fi
}
echo "Canton Lending: environment"
check node node --version
check pnpm pnpm --version
check java "$JAVA_HOME/bin/java" -version
check dpm dpm version
check docker docker --version
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || { echo "  FAIL node: Node 24+ required"; fail=1; }
"$JAVA_HOME/bin/java" -version 2>&1 | grep -qE 'version "(1[7-9]|[2-9][0-9])' || { echo "  FAIL java: JDK 17+ required"; fail=1; }
[ -f "$LENDING_ROOT/backend/.env" ] || echo "  warn no backend/.env: cp backend/.env.example backend/.env"
free_gb=$(df -g "$LENDING_ROOT" | awk 'NR==2 {print $4}')
[ "${free_gb:-0}" -ge 10 ] || echo "  warn ${free_gb} GB of disk free: Daml builds may not fit"
exit $fail
