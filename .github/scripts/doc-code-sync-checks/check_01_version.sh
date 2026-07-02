#!/usr/bin/env bash
# Check 1 — Version Consistency
# ตรวจว่า VERSION: header ในทุก .gs ตรงกัน + ตรงกับ APP_VERSION
#
# Returns:
#   0 = pass (all versions consistent)
#   1 = fail (some files have different version)

set -euo pipefail
cd "$(dirname "$0")/../../.."

echo "📋 Check 1: Version Consistency"

# Extract APP_VERSION from 01_Config.gs
APP_VERSION=$(grep -oP "const\s+APP_VERSION\s*=\s*['\"]\K[^'\"]+" src/O_core_system/01_Config.gs || echo "")
if [[ -z "$APP_VERSION" ]]; then
  echo "  ❌ Cannot find APP_VERSION in 01_Config.gs"
  exit 1
fi

# Check SCHEMA_VERSION matches APP_VERSION
SCHEMA_VERSION=$(grep -oP "const\s+SCHEMA_VERSION\s*=\s*['\"]\K[^'\"]+" src/O_core_system/01_Config.gs || echo "")
if [[ "$SCHEMA_VERSION" != "$APP_VERSION" ]]; then
  echo "  ❌ SCHEMA_VERSION ($SCHEMA_VERSION) != APP_VERSION ($APP_VERSION)"
  exit 1
fi

# Check VERSION: header in every .gs file
failures=0
for f in $(find src -name "*.gs" -type f); do
  header_ver=$(grep -m1 -oP "^\s*\*\s*VERSION:\s*\K\S+" "$f" || echo "")
  if [[ -z "$header_ver" ]]; then
    echo "  ❌ $f: no VERSION header"
    failures=$((failures+1))
  elif [[ "$header_ver" != "$APP_VERSION" ]]; then
    echo "  ❌ $f: $header_ver (expected $APP_VERSION)"
    failures=$((failures+1))
  fi
done

# Check package.json version matches APP_VERSION
PKG_VERSION=$(grep -oP '"version":\s*"([^"]+)"' package.json | head -1 | grep -oP '"[^"]+"\s*$' | tr -d '"')
if [[ "$PKG_VERSION" != "$APP_VERSION" ]]; then
  echo "  ❌ package.json version ($PKG_VERSION) != APP_VERSION ($APP_VERSION)"
  failures=$((failures+1))
fi

if [[ $failures -eq 0 ]]; then
  echo "  ✅ All versions consistent: $APP_VERSION"
  exit 0
else
  echo "  ❌ $failures version inconsistencies found"
  exit 1
fi
