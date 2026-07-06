#!/usr/bin/env bash
# Check 6 — Required Headers in .gs Files
# ตรวจว่าทุก .gs ไฟล์มี 6 headers ครบ:
#   VERSION, FILE, PURPOSE, CHANGELOG, DEPENDENCIES, ARCHITECTURE
#
# Returns:
#   0 = pass (all 6 headers present in every .gs file)
#   1 = fail (some header missing)

set -uo pipefail
cd "$(dirname "$0")/../../.."

echo "📋 Check 6: Required Headers in .gs Files"
echo "  Required: VERSION, FILE, PURPOSE, CHANGELOG, DEPENDENCIES, ARCHITECTURE"

# Skip legacy/investigation files (they have different format)
SKIP_FILES=("99_Legacy.gs" "INVESTIGATE_Issue26.gs")

is_skipped() {
  local filename="$1"
  for skip in "${SKIP_FILES[@]}"; do
    [[ "$filename" == "$skip" ]] && return 0
  done
  return 1
}

# Required headers — must appear as "* HEADER:" (with leading * and colon)
REQUIRED_HEADERS=("VERSION" "FILE" "PURPOSE" "CHANGELOG" "DEPENDENCIES" "ARCHITECTURE")

failures=0
checked=0

for f in $(find src -name "*.gs" -type f | sort); do
  filename=$(basename "$f")

  # Skip legacy/investigation
  if is_skipped "$filename"; then
    echo "  ⏭️  Skipping $filename (legacy/investigation)"
    continue
  fi

  checked=$((checked + 1))

  # Read first 100 lines (headers are always in the docstring at top)
  header_text=$(head -100 "$f")

  missing=()
  for hdr in "${REQUIRED_HEADERS[@]}"; do
    # Look for "* HEADER:" or "* HEADER :" pattern (case-sensitive)
    # Header must be at start of a comment line
    if ! echo "$header_text" | grep -qE "^\s*\*\s*${hdr}\s*:"; then
      missing+=("$hdr")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "  ❌ $filename: missing ${missing[*]}"
    failures=$((failures + 1))
  fi
done

echo ""
echo "  Checked: $checked files"
echo "  Failures: $failures"

if [[ $failures -eq 0 ]]; then
  echo "  ✅ All .gs files have all 6 required headers"
  exit 0
else
  echo "  ❌ $failures file(s) missing required headers"
  exit 1
fi
