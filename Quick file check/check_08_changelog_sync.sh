#!/usr/bin/env bash
# Check 8 — CHANGELOG Sync
# ตรวจว่า APP_VERSION ปัจจุบันมี entry ใน docs/CHANGELOG.md
#
# Logic:
#   1. อ่าน APP_VERSION จาก src/O_core_system/01_Config.gs
#   2. ตรวจว่ามี "## [APP_VERSION]" ใน docs/CHANGELOG.md
#   3. ตรวจว่า APP_VERSION อยู่ใน "Versions Summary" table ของ CHANGELOG
#
# ป้องกัน: version drift (เช่น V5.5.034 → V5.5.047 โดยไม่มี CHANGELOG entry)
#
# Returns:
#   0 = pass
#   1 = fail

set -uo pipefail
cd "$(dirname "$0")/../../.."

echo "📋 Check 8: CHANGELOG Sync (APP_VERSION ↔ docs/CHANGELOG.md)"

# Extract APP_VERSION
APP_VERSION=$(grep -oP "const\s+APP_VERSION\s*=\s*['\"]\K[^'\"]+" src/O_core_system/01_Config.gs || echo "")
if [[ -z "$APP_VERSION" ]]; then
  echo "  ❌ Cannot find APP_VERSION in 01_Config.gs"
  exit 1
fi

echo "  APP_VERSION: $APP_VERSION"

if [[ ! -f "docs/CHANGELOG.md" ]]; then
  echo "  ❌ docs/CHANGELOG.md not found"
  exit 1
fi

failures=0

# Check 1: Is there a "## [APP_VERSION]" section?
if grep -qE "^##\s*\[${APP_VERSION}\]" docs/CHANGELOG.md; then
  echo "  ✅ Found '## [${APP_VERSION}]' section in CHANGELOG"
else
  echo "  ❌ MISSING: '## [${APP_VERSION}]' section not found in docs/CHANGELOG.md"
  echo "     This means APP_VERSION was bumped but no CHANGELOG entry was added."
  echo "     Add an entry following the Keep a Changelog format:"
  echo "       ## [${APP_VERSION}] — YYYY-MM-DD — CYCLE_NAME"
  echo "       ### Added/Changed/Fixed/Removed"
  echo "         - description"
  failures=$((failures + 1))
fi

# Check 2: Is APP_VERSION in the "Versions Summary" table?
if grep -qE "^\|\s*${APP_VERSION}\s*\|" docs/CHANGELOG.md; then
  echo "  ✅ Found APP_VERSION in Versions Summary table"
else
  echo "  ⚠️  APP_VERSION not in Versions Summary table (advisory only)"
  # Don't count this as a failure — table is optional/supplementary
fi

# Check 3: Is APP_VERSION referenced in "Latest 3 versions" of any .gs header?
# (Informational — .gs files only show 3 most recent, so older versions won't appear)
latest_3_count=$(grep -rE "v${APP_VERSION}\s*\(" src/ 2>/dev/null | wc -l | tr -d ' \n')
latest_3_count=${latest_3_count:-0}
echo "  ℹ️  APP_VERSION referenced in 'Latest 3 versions' of $latest_3_count .gs files"

echo ""
if [[ $failures -eq 0 ]]; then
  echo "  ✅ CHANGELOG sync OK"
  exit 0
else
  echo "  ❌ CHANGELOG sync FAILED — add missing entry before merge"
  exit 1
fi
