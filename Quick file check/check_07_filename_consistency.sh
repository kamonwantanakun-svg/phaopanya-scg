#!/usr/bin/env bash
# Check 7 — Filename Consistency
# ตรวจว่า FILE: header ในแต่ละ .gs ตรงกับชื่อไฟล์จริง
#
# ตัวอย่างที่ผ่าน:
#   File: src/O_core_system/00_App.gs
#   Header: * FILE: 00_App.gs  ✅
#
# ตัวอย่างที่ fail:
#   File: src/O_core_system/00_App.gs
#   Header: * FILE: 99_Legacy.gs  ❌
#
# Returns:
#   0 = pass
#   1 = fail

set -uo pipefail
cd "$(dirname "$0")/../../.."

echo "📋 Check 7: Filename Consistency (FILE: header ↔ actual filename)"

# Skip legacy/investigation files (they have different format)
SKIP_FILES=("99_Legacy.gs" "INVESTIGATE_Issue26.gs")

is_skipped() {
  local filename="$1"
  for skip in "${SKIP_FILES[@]}"; do
    [[ "$filename" == "$skip" ]] && return 0
  done
  return 1
}

failures=0
checked=0

for f in $(find src -name "*.gs" -type f | sort); do
  filename=$(basename "$f")

  if is_skipped "$filename"; then
    continue
  fi

  checked=$((checked + 1))

  # Extract FILE: header value (first match in top 100 lines)
  # Use grep + sed (more portable than grep -P \K)
  header_file=$(head -100 "$f" | grep -m1 -E "^\s*\*\s*FILE:" | sed -E 's/^\s*\*\s*FILE:\s*//; s/\s.*$//' || echo "")

  if [[ -z "$header_file" ]]; then
    echo "  ❌ $f: no FILE: header"
    failures=$((failures + 1))
  elif [[ "$header_file" != "$filename" ]]; then
    echo "  ❌ $f: FILE: header says '$header_file' but actual filename is '$filename'"
    failures=$((failures + 1))
  fi
done

echo ""
echo "  Checked: $checked files"
echo "  Failures: $failures"

if [[ $failures -eq 0 ]]; then
  echo "  ✅ All FILE: headers match actual filenames"
  exit 0
else
  echo "  ❌ $failures filename mismatch(es)"
  exit 1
fi
