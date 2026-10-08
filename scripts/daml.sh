#!/bin/sh
# Build and test all Daml packages: sh scripts/daml.sh build|test|upgrade-check
#   upgrade-check: build the packages and check SCU compatibility (dpm upgrade-check --both)
#   against the released DARs in daml/released/: for each released package the current
#   DAR with the same name is taken. The new version must be a valid upgrade of the deployed one.
set -eu
. "$(dirname "$0")/env.sh"
cd "$LENDING_ROOT/daml"

upgrade_check() {
  dpm build --all
  set --
  for released in released/*.dar; do
    # released/v1 holds the lending-core and lending-governance line before the Compound V3
    # model; released/*.dar are the versions deployed on DevNet
    [ -e "$released" ] || { echo "upgrade-check: no released DARs of the current packages yet"; return 0; }
    base=$(basename "$released" .dar)
    name=${base%-*}
    [ -f "$name/daml.yaml" ] || { echo "upgrade-check: package $name for $released not found" >&2; exit 1; }
    version=$(sed -n 's/^version: *//p' "$name/daml.yaml")
    current="$name/.daml/dist/$name-$version.dar"
    if [ "$current" = "$name/.daml/dist/$base.dar" ]; then
      # the released version itself: fine while the build is the same package, otherwise bump
      if [ "$(dpm inspect-dar --json "$current" 2>/dev/null | jq -r .main_package_id)" = \
           "$(dpm inspect-dar --json "$released" 2>/dev/null | jq -r .main_package_id)" ]; then
        echo "upgrade-check: $name $version is the released package, unchanged"
        continue
      fi
      echo "upgrade-check: $name changed but is still $version: bump the version in $name/daml.yaml" >&2
      exit 1
    fi
    echo "upgrade-check: $released -> $current"
    set -- "$@" "$released" "$current"
  done
  [ $# -gt 0 ] || { echo "upgrade-check: ok (every package is the released one)"; return 0; }
  mkdir -p .daml
  if dpm upgrade-check --both "$@" > .daml/upgrade-check.log 2>&1; then
    echo "upgrade-check: ok"
  else
    grep -E "NOT_VALID_UPGRADE_PACKAGE|rror" .daml/upgrade-check.log >&2 || cat .daml/upgrade-check.log >&2
    echo "upgrade-check: FAILED (full log: daml/.daml/upgrade-check.log)" >&2
    exit 1
  fi
}

case "${1:-build}" in
  build) dpm build --all ;;
  test) dpm build --all && (cd lending-tests && dpm test) ;;
  upgrade-check) upgrade_check ;;
  *) echo "usage: $0 build|test|upgrade-check" >&2; exit 2 ;;
esac
