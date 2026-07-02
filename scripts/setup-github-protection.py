#!/usr/bin/env python3
"""
GitHub Repository Settings Script
ตั้งค่า Branch Protection + Repo Settings ผ่าน GitHub API

วิธีใช้:
1. สร้าง Personal Access Token ที่ https://github.com/settings/tokens
   - Scopes: repo (full control), admin:org (ถ้าเป็น org repo)
2. รัน: python3 setup-github-protection.py --token ghp_xxx --owner Siriwat08 --repo phaopanya-scg

หรือตั้ง environment variable:
   export GITHUB_TOKEN=ghp_xxx
   python3 setup-github-protection.py --owner Siriwat08 --repo phaopanya-scg
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error

GITHUB_API = "https://api.github.com"

def api_call(token, method, url, data=None):
    """เรียก GitHub API"""
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
    }
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            if resp.status == 204:
                return {}
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        print(f"  ❌ HTTP {e.code}: {error_body[:200]}")
        return None
    except Exception as e:
        print(f"  ❌ Error: {e}")
        return None

def setup_branch_protection(token, owner, repo):
    """ตั้งค่า Branch Protection สำหรับ main"""
    print("\n🔒 1. Branch Protection Rules (main)")
    url = f"{GITHUB_API}/repos/{owner}/{repo}/branches/main/protection"
    data = {
        "required_status_checks": {
            "strict": True,  # Require branches to be up to date
            "contexts": []   # ไม่บังคับ specific checks (รอ CI setup)
        },
        "enforce_admins": False,  # admin ยังบังคับได้ (สำหรับ emergency fix)
        "required_pull_request_reviews": {
            "required_approving_review_count": 1,
            "dismiss_stale_reviews": True,
            "require_code_owner_reviews": True,
            "dismiss_stale_reviews_on_push": True
        },
        "restrictions": None,  # ไม่จำกัด who can push
        "required_linear_history": False,
        "allow_force_pushes": False,
        "allow_deletions": False,
        "block_creations": False,
        "required_conversation_resolution": False
    }
    result = api_call(token, "PUT", url, data)
    if result is not None:
        print("  ✅ Branch protection ตั้งค่าแล้ว:")
        print("     • Require 1 PR review (with CODEOWNERS)")
        print("     • Dismiss stale reviews")
        print("     • Require up-to-date branches")
        print("     • Block force push + deletion")
    return result is not None

def setup_repo_settings(token, owner, repo):
    """ตั้งค่า Repository Settings"""
    print("\n⚙️ 2. Repository Settings")
    url = f"{GITHUB_API}/repos/{owner}/{repo}"
    data = {
        "delete_branch_on_merge": True,     # ลบ branch หลัง merge
        "allow_auto_merge": True,            # อนุญาต auto-merge
        "allow_update_branch": True,         # อนุญาต update branch
        "allow_squash_merge": True,          # squash merge (default)
        "allow_merge_commit": False,         # ไม่อนุญาต merge commit (ใช้ squash)
        "allow_rebase_merge": False,         # ไม่อนุญาต rebase merge
        "has_issues": True,
        "has_projects": True,
        "has_wiki": False,                   # ปิด wiki (ใช้ docs/ แทน)
        "squash_merge_commit_title": "PR_TITLE",
        "squash_merge_commit_message": "PR_BODY"
    }
    result = api_call(token, "PATCH", url, data)
    if result is not None:
        print("  ✅ Repository settings อัปเดตแล้ว:")
        print("     • Delete branch on merge: ON")
        print("     • Allow auto-merge: ON")
        print("     • Allow update branch: ON")
        print("     • Squash merge only (no merge commit/rebase)")
        print("     • Wiki: OFF (ใช้ docs/ แทน)")
    return result is not None

def setup_vulnerability_alerts(token, owner, repo):
    """เปิด vulnerability alerts + automated security fixes"""
    print("\n🛡️ 3. Security Alerts")
    
    # Vulnerability alerts
    url1 = f"{GITHUB_API}/repos/{owner}/{repo}/vulnerability-alerts"
    r1 = api_call(token, "PUT", url1)
    if r1 is not None:
        print("  ✅ Vulnerability alerts: ON")
    
    # Automated security fixes
    url2 = f"{GITHUB_API}/repos/{owner}/{repo}/automated-security-fixes"
    r2 = api_call(token, "PUT", url2)
    if r2 is not None:
        print("  ✅ Automated security fixes: ON")
    
    return r1 is not None and r2 is not None

def main():
    parser = argparse.ArgumentParser(description="Setup GitHub repo protection + settings")
    parser.add_argument("--token", default=os.environ.get("GITHUB_TOKEN"),
                        help="GitHub Personal Access Token (or set GITHUB_TOKEN env)")
    parser.add_argument("--owner", default="Siriwat08", help="Repo owner")
    parser.add_argument("--repo", default="phaopanya-scg", help="Repo name")
    
    args = parser.parse_args()
    
    if not args.token:
        print("❌ ต้องการ GitHub token — สร้างที่ https://github.com/settings/tokens")
        print("   ใช้: python3 setup-github-protection.py --token ghp_xxx")
        print("   หรือ: export GITHUB_TOKEN=ghp_xxx && python3 setup-github-protection.py")
        sys.exit(1)
    
    print(f"🚀 Setting up GitHub protection for {args.owner}/{args.repo}")
    print(f"   Token: {args.token[:10]}...")
    
    ok1 = setup_branch_protection(args.token, args.owner, args.repo)
    ok2 = setup_repo_settings(args.token, args.owner, args.repo)
    ok3 = setup_vulnerability_alerts(args.token, args.owner, args.repo)
    
    print("\n" + "=" * 60)
    if ok1 and ok2 and ok3:
        print("✅ ทุกการตั้งค่าสำเร็จ!")
    else:
        print("⚠️ บางการตั้งค่าอาจไม่สำเร็จ — ตรวจ error ด้านบน")
    print("=" * 60)
    
    print("\n📋 สิ่งที่ต้องทำเพิ่มใน GitHub UI:")
    print("   1. Settings → General → Features → ตรวจ Issues + Projects ทำงาน")
    print("   2. Settings → Branches → ตรวจ branch protection rule สำหรับ main")
    print("   3. Settings → Code security → ตรวจ Dependabot + CodeQL ทำงาน")
    print("   4. Insights → Dependency graph → ตรวจ Dependabot alerts")

if __name__ == "__main__":
    main()
