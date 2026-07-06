#!/usr/bin/env bash
# Check 9 — Dependencies Resolve
# ตรวจว่า DEPENDENCIES section ในแต่ละ .gs อ้างถึงไฟล์ที่มีอยู่จริง
#
# Pattern ที่ตรวจ:
#   - "→ XX_Name.gs" (ใน CALLS section)
#   - "- XX_Name.gs" (ใน REQUIRES section)
#   - "XX_Name.gs" เฉยๆ ใน DEPENDENCIES block
#
# Skip:
#   - Comments และ historical notes ([REMOVED ...], DEPRECATED)
#   - 99_Legacy.gs และ INVESTIGATE_*.gs (different format)
#
# Returns:
#   0 = pass
#   1 = fail

set -uo pipefail
cd "$(dirname "$0")/../../.."

echo "📋 Check 9: Dependencies Resolve (DEPENDENCIES section → real files)"

# Collect all .gs files in src/
declare -a ALL_GS_FILES=()
while IFS= read -r f; do
  ALL_GS_FILES+=("$(basename "$f")")
done < <(find src -name "*.gs" -type f | sort)

# Skip legacy/investigation files
SKIP_FILES=("99_Legacy.gs" "INVESTIGATE_Issue26.gs")

is_skipped() {
  local filename="$1"
  for skip in "${SKIP_FILES[@]}"; do
    [[ "$filename" == "$skip" ]] && return 0
  done
  return 1
}

# Function to check if a .gs file exists in src/
gs_exists() {
  local target="$1"
  for f in "${ALL_GS_FILES[@]}"; do
    [[ "$f" == "$target" ]] && return 0
  done
  return 1
}

failures=0
checked_files=0
total_refs=0
total_resolved=0

for f in $(find src -name "*.gs" -type f | sort); do
  filename=$(basename "$f")

  if is_skipped "$filename"; then
    continue
  fi

  checked_files=$((checked_files + 1))

  # Extract DEPENDENCIES section (between "DEPENDENCIES:" and next "===" separator)
  # Use awk with [ \t] instead of \s (more portable across awk implementations)
  dep_block=$(awk '
    /^[ \t]*\*[ \t]*DEPENDENCIES:/ { in_dep=1; next }
    in_dep && /^[ \t]*\*[ \t]*={5,}/ { exit }
    in_dep { print }
  ' "$f")

  if [[ -z "$dep_block" ]]; then
    echo "  ⚠️  $filename: no DEPENDENCIES section found"
    continue
  fi

  # Extract all "XX_Name.gs" references from the block
  # Pattern: word characters + underscore + word characters + .gs
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    total_refs=$((total_refs + 1))

    # Skip if reference is in [REMOVED ...] or DEPRECATED context
    # (we already filter by section, but double-check the line)
    if gs_exists "$ref"; then
      total_resolved=$((total_resolved + 1))
    else
      echo "  ❌ $filename: DEPENDENCIES references '$ref' but file not found in src/"
      failures=$((failures + 1))
    fi
  done < <(echo "$dep_block" | grep -oE '[A-Za-z0-9_]+\.gs' | sort -u)
done

echo ""
echo "  Checked: $checked_files files"
echo "  Total dependency refs: $total_refs"
echo "  Resolved: $total_resolved"
echo "  Failed: $failures"

if [[ $failures -eq 0 ]]; then
  echo "  ✅ All DEPENDENCIES references resolve to real files"
  exit 0
else
  echo "  ❌ $failures unresolved dependency reference(s)"
  exit 1
fi
