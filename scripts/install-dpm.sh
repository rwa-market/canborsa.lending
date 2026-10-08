#!/bin/sh
# Install dpm (Daml SDK CLI) without `curl | sh` (audit I-13). Used in CI and in deploy/server/setup.sh.
#   1. the installer is downloaded to a file, not piped into sh;
#   2. if DPM_INSTALLER_SHA256 is set (repository or environment variable), the hash is checked,
#      a mismatch is a refusal; without it the hash is printed so it can be pinned;
#   3. exactly the SDK version from daml/multi-package.yaml (or DAML_SDK) is installed, errors are not swallowed.
# Digital Asset does not publish the installer hash separately: the pinned hash is "trust on first
# use", it must be updated deliberately when the installer changes.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK=${DAML_SDK:-$(sed -n 's/^sdk-version: *//p' "$ROOT/daml/multi-package.yaml" 2>/dev/null | head -1)}
[ -n "$SDK" ] || { echo "install-dpm: SDK version unknown (daml/multi-package.yaml or DAML_SDK)" >&2; exit 1; }
URL=https://get.digitalasset.com/install/install.sh

if [ ! -x "$HOME/.dpm/bin/dpm" ]; then
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp" "$URL"
  if command -v sha256sum >/dev/null; then
    actual=$(sha256sum "$tmp" | cut -d' ' -f1)
  else
    actual=$(shasum -a 256 "$tmp" | cut -d' ' -f1)
  fi
  if [ -n "${DPM_INSTALLER_SHA256:-}" ]; then
    if [ "$actual" != "$DPM_INSTALLER_SHA256" ]; then
      echo "install-dpm: installer sha256 $actual != pinned $DPM_INSTALLER_SHA256" >&2
      exit 1
    fi
  else
    echo "install-dpm: warning: DPM_INSTALLER_SHA256 is not set; installer sha256 is $actual" >&2
  fi
  sh "$tmp"
fi
"$HOME/.dpm/bin/dpm" install "$SDK"
if [ -n "${GITHUB_PATH:-}" ]; then echo "$HOME/.dpm/bin" >>"$GITHUB_PATH"; fi
echo "dpm with SDK $SDK is installed"
