#!/usr/bin/env bash
# Check 2 — Stats Consistency
# ตรวจว่า README/BLUEPRINT/CONTEXT บอก stats ตรงกับจริง
#
# Returns:
#   0 = pass
#   1 = fail

set -uo pipefail
cd "$(dirname "$0")/../../.."

echo "📋 Check 2: Stats Consistency"

# Count actual
actual_gs=$(find src -name "*.gs" -type f | wc -l | tr -d ' \n')
actual_funcs=$(grep -hcE "^\s*function\s+[a-zA-Z_\$]" src/*/*.gs 2>/dev/null | awk '{s+=$1} END {print s+0}')
actual_lines=$(find src -name "*.gs" -type f -exec cat {} + | grep -v "^\s*$" | wc -l | tr -d ' \n')

echo "  Actual: $actual_gs files / $actual_funcs functions / $actual_lines lines"

# Check README
failures=0
readme_files=$(grep -oP "\|\s*\*\*Total Files\*\*\s*\|\s*\K\d+" README.md || echo "")
if [[ "$readme_files" != "$actual_gs" ]]; then
  echo "  ❌ README Total Files: $readme_files (expected $actual_gs)"
  failures=$((failures+1))
fi

# Check that no doc claims wrong counts (informational only — historical refs OK)
for doc in README.md BLUEPRINT.md CONTEXT.md "LMDS Supreme Engineer.md"; do
  if [[ ! -f "$doc" ]]; then continue; fi
  # Check for stale "22 ไฟล์" or "23 ไฟล์" (without "00-21" historical context)
  stale=$(grep -cE "(^|[^0-9-])(22|23)\s*ไฟล์|22\s*source files|22\s*\.gs files" "$doc" 2>/dev/null || true)
  stale=${stale:-0}
  if [[ "$stale" -gt 0 ]]; then
    echo "  ⚠️  $doc: still references 22/23 ไฟล์ ($stale matches — may need review)"
  fi
done

if [[ $failures -eq 0 ]]; then
  echo "  ✅ Stats consistent"
  exit 0
else
  echo "  ❌ $failures stat inconsistencies"
  exit 1
fi
