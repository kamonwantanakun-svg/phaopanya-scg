#!/usr/bin/env bash
# Check 3 — No file:/// Local Paths
# ตรวจว่าไม่มี file:/// paths ใน docs (กัน dev-machine path รั่ว)
#
# Returns:
#   0 = pass (no file:/// paths)
#   1 = fail

set -uo pipefail
cd "$(dirname "$0")/../../.."

echo "📋 Check 3: No file:/// Local Paths"

# Count file:/// paths in docs/ and root *.md files
matches=$(grep -rE "file:///[a-zA-Z]:" docs/ *.md 2>/dev/null | wc -l | tr -d ' \n')
matches=${matches:-0}

if [[ "$matches" == "0" ]]; then
  echo "  ✅ No file:/// paths in docs"
  exit 0
else
  echo "  ❌ Found $matches file:/// paths:"
  grep -rE "file:///[a-zA-Z]:" docs/ *.md 2>/dev/null | head -5
  exit 1
fi
