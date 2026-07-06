#!/usr/bin/env bash
# Check 10 — Architecture Refs Resolve
# ตรวจว่า functionName() ที่อ้างใน ARCHITECTURE section มีอยู่จริงใน codebase
#
# Pattern ที่ตรวจ:
#   ARCHITECTURE section มักจะมี ASCII diagram ที่อ้าง functionName()
#   เช่น:
#     * │   ├── "Run Full Pipeline" → runFullPipeline()
#     * │   ├── onOpen() → createMenu_()
#
# ข้าม:
#   - 99_Legacy.gs, INVESTIGATE_*.gs
#   - References ใน comment ที่ชัดเจนว่า historical (เช่น "[REMOVED ...]")
#
# Returns:
#   0 = pass
#   1 = fail

set -uo pipefail
cd "$(dirname "$0")/../../.."

echo "📋 Check 10: Architecture Refs Resolve (functionName() in ARCHITECTURE → real functions)"

# Build a list of all functions defined across all .gs files
echo "  Building function index..."
ALL_FUNCTIONS=$(grep -rhE "^\s*function\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\(" src/ 2>/dev/null | \
  sed -E 's/^\s*function\s+([a-zA-Z_][a-zA-Z0-9_]*).*/\1/' | sort -u)
TOTAL_FUNCS=$(echo "$ALL_FUNCTIONS" | wc -l | tr -d ' \n')
echo "  Found $TOTAL_FUNCS unique functions in codebase"

# Skip legacy/investigation files
SKIP_FILES=("99_Legacy.gs" "INVESTIGATE_Issue26.gs")

is_skipped() {
  local filename="$1"
  for skip in "${SKIP_FILES[@]}"; do
    [[ "$filename" == "$skip" ]] && return 0
  done
  return 1
}

failures=0
checked_files=0
total_refs=0
total_resolved=0
# Use plain file (more portable than associative arrays with set -u)
UNRESOLVED_FILE=$(mktemp)
trap 'rm -f "$UNRESOLVED_FILE"' EXIT

for f in $(find src -name "*.gs" -type f | sort); do
  filename=$(basename "$f")

  if is_skipped "$filename"; then
    continue
  fi

  checked_files=$((checked_files + 1))

  # Extract ARCHITECTURE section
  # Use [ \t] instead of \s for awk portability
  arch_block=$(awk '
    /^[ \t]*\*[ \t]*ARCHITECTURE:/ { in_arch=1; next }
    in_arch && /^[ \t]*\*[ \t]*={5,}/ { exit }
    in_arch { print }
  ' "$f")

  if [[ -z "$arch_block" ]]; then
    continue  # Already checked in Check 6
  fi

  # Extract functionName() references — pattern: word followed by ()
  # Use grep -oE to extract
  while IFS= read -r func_ref; do
    [[ -z "$func_ref" ]] && continue
    total_refs=$((total_refs + 1))

    # Check if this function exists in the codebase
    if echo "$ALL_FUNCTIONS" | grep -qx "$func_ref"; then
      total_resolved=$((total_resolved + 1))
    else
      # Skip obvious non-function patterns (e.g., "()" alone, or arrow markers)
      if [[ "$func_ref" == "arrow" || "$func_ref" == "function" || ${#func_ref} -lt 3 ]]; then
        continue
      fi
      # Skip patterns like "USER_DEPLOYING" or all-caps config values
      if [[ "$func_ref" =~ ^[A-Z_]+$ ]]; then
        continue
      fi
      echo "  ❌ $filename: ARCHITECTURE references '$func_ref()' but function not found in codebase"
      echo "$func_ref" >> "$UNRESOLVED_FILE"
      failures=$((failures + 1))
    fi
  done < <(echo "$arch_block" | grep -oE '[a-zA-Z_][a-zA-Z0-9_]*\s*\(\s*\)' | sed -E 's/\s*\(\s*\)//' | sort -u)
done

echo ""
echo "  Checked: $checked_files files"
echo "  Total function refs in ARCHITECTURE sections: $total_refs"
echo "  Resolved: $total_resolved"
echo "  Unresolved: $failures"

if [[ -s "$UNRESOLVED_FILE" ]]; then
  echo ""
  echo "  Unresolved functions (unique):"
  sort -u "$UNRESOLVED_FILE" | while IFS= read -r func; do
    echo "    - $func (referenced but not defined)"
  done
fi

if [[ $failures -eq 0 ]]; then
  echo "  ✅ All ARCHITECTURE function references resolve"
  exit 0
else
  echo "  ❌ $failures unresolved function reference(s) in ARCHITECTURE sections"
  exit 1
fi
