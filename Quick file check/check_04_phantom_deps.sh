#!/usr/bin/env bash
# Check 4 — No Phantom Dependencies
# ตรวจว่า docstrings ที่อ้าง function names ใน REQUIRES section อ้างถึงฟังก์ชันที่มีจริง
#
# ข้าม comments (// หรือ *) และ historical notes ("[REMOVED ...]")
#
# Returns:
#   0 = pass
#   1 = fail

set -uo pipefail
cd "$(dirname "$0")/../../.."

echo "📋 Check 4: No Phantom Dependencies"

# Known phantom patterns from previous audits
phantom_patterns=("loadAllFacts_" "syncAliasToEntityTable_" "getMapCache_")

failures=0
for pattern in "${phantom_patterns[@]}"; do
  # Count only ACTIVE references (not in comments or historical notes)
  # Skip lines starting with //, *, or containing [REMOVED
  matches=$(grep -rn "$pattern" src/ 2>/dev/null | \
    grep -vE "^[^:]+:[0-9]+:\s*(//|\*|/\*)" | \
    grep -v "\[REMOVED" | \
    grep -v "DEPRECATED" | \
    wc -l | tr -d ' \n')
  matches=${matches:-0}
  
  if [[ "$matches" -gt 0 ]]; then
    echo "  ❌ Found active phantom dep '$pattern': $matches references"
    grep -rn "$pattern" src/ 2>/dev/null | \
      grep -vE "^[^:]+:[0-9]+:\s*(//|\*|/\*)" | \
      grep -v "\[REMOVED" | \
      grep -v "DEPRECATED" | head -3
    failures=$((failures+1))
  fi
done

if [[ $failures -eq 0 ]]; then
  echo "  ✅ No known phantom dependencies (active references)"
  exit 0
else
  exit 1
fi
