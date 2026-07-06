#!/usr/bin/env bash
# Check 11 — Doc ↔ Code Cross-Links
# ตรวจสอบความสัมพันธ์ 2 ทิศทางระหว่าง docs และ code
#
# Direction 1 (Doc → Code):
#   ทุก reference ถึง XX_Name.gs ใน docs/*.md ต้องชี้ไฟล์ที่มีอยู่จริงใน src/
#
# Direction 2 (Code → Doc):
#   ทุก .gs ไฟล์ใน src/ (ยกเว้น legacy/investigation) ต้องถูกอ้างถึง
#   ใน docs/*.md อย่างน้อย 1 ครั้ง (ยกเว้นไฟล์ใหม่มากๆ ที่ยังไม่ documented)
#
# Returns:
#   0 = pass
#   1 = fail (Direction 1 ผิดบล็อก PR; Direction 2 เป็น warning เท่านั้น)

set -uo pipefail
cd "$(dirname "$0")/../../.."

echo "📋 Check 11: Doc ↔ Code Cross-Links"

# Collect all .gs files (basename only) in src/
declare -a ALL_GS_FILES=()
while IFS= read -r f; do
  ALL_GS_FILES+=("$(basename "$f")")
done < <(find src -name "*.gs" -type f | sort)

# Collect all .md files
MD_FILES=$(find . -name "*.md" -not -path "./node_modules/*" -not -path "./.git/*" -type f | sort)

# ============================================================
# Direction 1: Doc → Code (BLOCK if any .gs ref doesn't resolve)
# ============================================================
echo ""
echo "  Direction 1: Doc → Code (every .gs ref in docs must resolve)"

# Skip example/placeholder file names that aren't real files
# These are common in coding guides and templates
SKIP_PATTERNS=(
  "XX_Component.gs"
  "XX_Name.gs"
  "XX_ComponentName.gs"
  "Untitled.gs"
  "code.gs"
  "Code.gs"
  "test.gs"
  "example.gs"
  "sample.gs"
  "template.gs"
  "myScript.gs"
  "yourScript.gs"
  "foo.gs"
  "bar.gs"
  "99_Deleted.gs"
  "99_Missing.gs"
)

is_skip_pattern() {
  local target="$1"
  for pat in "${SKIP_PATTERNS[@]}"; do
    [[ "$target" == "$pat" ]] && return 0
  done
  # Also skip names starting with _ (partial refs like _GoogleMapsAPI.gs)
  [[ "$target" == _* ]] && return 0
  return 1
}

# Docs that are allowed to reference future/historical files
# (roadmaps, historical CHANGELOG entries, deep-dive audits, enhancement analysis)
# Also exempt the check scripts' own README (uses example file names)
EXEMPT_DOCS=(
  "docs/CHANGELOG.md"
  "docs/roadmap/LMDS_V6.0_Roadmap.md"
  "docs/LMDS_Deep_Dive_Audit.md"
  "docs/LMDS_V5.5_Enhancement_Analysis.md"
  "docs/บันทึกการพัฒนาและปิดงานระบบ LMDS V5.2-V5.5.md"
  ".github/scripts/doc-code-sync-checks/README.md"
)

is_exempt_doc() {
  local doc_path="$1"
  for ex in "${EXEMPT_DOCS[@]}"; do
    [[ "$doc_path" == "./$ex" ]] && return 0
  done
  return 1
}

dir1_failures=0
dir1_total_refs=0
dir1_resolved=0
dir1_skipped=0

while IFS= read -r doc_file; do
  # Skip exempt docs (roadmaps, historical changelogs, deep-dive audits)
  if is_exempt_doc "$doc_file"; then
    continue
  fi
  # Find all "XX_Name.gs" references in this doc
  while IFS= read -r gs_ref; do
    [[ -z "$gs_ref" ]] && continue

    # Skip example/placeholder names
    if is_skip_pattern "$gs_ref"; then
      dir1_skipped=$((dir1_skipped + 1))
      continue
    fi

    dir1_total_refs=$((dir1_total_refs + 1))

    # Check if this .gs file exists
    found=0
    for gs in "${ALL_GS_FILES[@]}"; do
      if [[ "$gs" == "$gs_ref" ]]; then
        found=1
        break
      fi
    done

    if [[ $found -eq 1 ]]; then
      dir1_resolved=$((dir1_resolved + 1))
    else
      echo "  ❌ $doc_file: references '$gs_ref' but file not found in src/"
      dir1_failures=$((dir1_failures + 1))
    fi
  done < <(grep -oE '[A-Za-z0-9_]+\.gs' "$doc_file" 2>/dev/null | sort -u)
done <<< "$MD_FILES"

echo "    Total .gs refs in docs: $dir1_total_refs (skipped $dir1_skipped example/placeholder refs)"
echo "    Resolved: $dir1_resolved"
echo "    Unresolved: $dir1_failures"

# ============================================================
# Direction 2: Code → Doc (WARN if any .gs file is not documented)
# ============================================================
echo ""
echo "  Direction 2: Code → Doc (every .gs file should be documented)"

dir2_undocumented=0
dir2_documented=0

# Skip legacy/investigation — they may not need full documentation
SKIP_FILES=("99_Legacy.gs" "INVESTIGATE_Issue26.gs")

is_skipped() {
  local filename="$1"
  for skip in "${SKIP_FILES[@]}"; do
    [[ "$filename" == "$skip" ]] && return 0
  done
  return 1
}

for gs in "${ALL_GS_FILES[@]}"; do
  if is_skipped "$gs"; then
    continue
  fi

  # Check if this .gs file is referenced in any .md
  ref_count=0
  while IFS= read -r doc_file; do
    # Use grep -c which returns count (sanitize newlines)
    count=$(grep -c -- "$gs" "$doc_file" 2>/dev/null || true)
    count=${count//[^0-9]/}
    count=${count:-0}
    ref_count=$((ref_count + count))
  done <<< "$MD_FILES"

  if [[ $ref_count -eq 0 ]]; then
    echo "  ⚠️  $gs: not referenced in any .md file (needs documentation)"
    dir2_undocumented=$((dir2_undocumented + 1))
  else
    dir2_documented=$((dir2_documented + 1))
  fi
done

echo "    Documented .gs files: $dir2_documented"
echo "    Undocumented .gs files: $dir2_undocumented (warning only)"

# ============================================================
# Summary
# ============================================================
echo ""
echo "  Summary:"
echo "    Direction 1 (Doc → Code): $dir1_failures unresolved refs (BLOCKING)"
echo "    Direction 2 (Code → Doc): $dir2_undocumented undocumented files (warning)"

if [[ $dir1_failures -eq 0 ]]; then
  echo "  ✅ Direction 1: all doc → code refs resolve"
  # Direction 2 is warning only — don't fail the build
  if [[ $dir2_undocumented -gt 0 ]]; then
    echo "  ⚠️  Direction 2: $dir2_undocumented file(s) need documentation (non-blocking)"
  fi
  exit 0
else
  echo "  ❌ Direction 1: $dir1_failures unresolved doc → code refs"
  exit 1
fi
