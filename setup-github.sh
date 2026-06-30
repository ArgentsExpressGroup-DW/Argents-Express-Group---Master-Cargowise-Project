#!/usr/bin/env bash
#
# setup-github.sh — one-time bootstrap for the Argents Supabase ingest repo.
#
# What it does:
#   1. Initialises git in this folder (if not already)
#   2. Creates a NEW private repo under your GitHub org and pushes
#   3. Sets all 9 GitHub Actions secrets, read from your local ingest/.env
#
# Your secret values stay in ingest/.env on your machine — they are never
# typed into this script and never leave your computer except to GitHub.
#
# Prerequisites:
#   - GitHub CLI installed and authenticated:  gh auth login
#   - ingest/.env created and filled in:        cp ingest/.env.example ingest/.env
#   - Run from Git Bash (Windows), WSL, or any bash shell.
#
# Usage:
#   1. Edit GH_ORG and REPO_NAME below.
#   2. bash setup-github.sh
# =============================================================

set -euo pipefail

# ── EDIT THESE TWO ────────────────────────────────────────────
# Your GitHub org's *login slug* (NOT the display name). Find it in the URL
# of any repo in the org: github.com/<THIS-PART>/some-repo
GH_ORG="argents-express-group"        # <-- confirm the exact org slug
REPO_NAME="supabase-migration"        # <-- name for the new repo
VISIBILITY="private"                  # private | internal | public
# ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/ingest/.env"
REPO_SLUG="$GH_ORG/$REPO_NAME"

# The 9 secrets the GitHub Actions workflow expects.
SECRETS=(
  AZURE_TENANT_ID
  AZURE_CLIENT_ID
  AZURE_CLIENT_SECRET
  SHAREPOINT_HOST
  SHAREPOINT_SITE_PATH
  SHAREPOINT_DRIVE_NAME
  SHAREPOINT_REPORTS_FOLDER
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
)

echo "==> Checking prerequisites"
command -v gh >/dev/null  || { echo "ERROR: GitHub CLI (gh) not found. Install it and run 'gh auth login'."; exit 1; }
gh auth status >/dev/null || { echo "ERROR: not logged in. Run 'gh auth login' first."; exit 1; }
[ -f "$ENV_FILE" ]        || { echo "ERROR: $ENV_FILE not found. Run: cp ingest/.env.example ingest/.env  and fill it in."; exit 1; }

# ── 1. git init + first commit ────────────────────────────────
cd "$SCRIPT_DIR"
if [ ! -d .git ]; then
  echo "==> Initialising git repo"
  git init -b main
fi
git add -A
git commit -m "Initial commit: Supabase ingest pipeline + migrations" || echo "   (nothing new to commit)"

# ── 2. Create repo on GitHub + push ───────────────────────────
if gh repo view "$REPO_SLUG" >/dev/null 2>&1; then
  echo "==> Repo $REPO_SLUG already exists — adding as remote + pushing"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$REPO_SLUG.git"
  git push -u origin main
else
  echo "==> Creating $VISIBILITY repo $REPO_SLUG and pushing"
  gh repo create "$REPO_SLUG" --"$VISIBILITY" --source=. --remote=origin --push
fi

# ── 3. Set the 9 Actions secrets from ingest/.env ─────────────
echo "==> Loading values from $ENV_FILE"
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a

echo "==> Setting GitHub Actions secrets"
missing=0
for name in "${SECRETS[@]}"; do
  value="${!name:-}"
  if [ -z "$value" ]; then
    echo "   ✗ $name is empty in .env — skipping"
    missing=1
    continue
  fi
  printf '%s' "$value" | gh secret set "$name" --repo "$REPO_SLUG" --body -
  echo "   ✓ $name set"
done

echo
if [ "$missing" -eq 0 ]; then
  echo "All 9 secrets set on $REPO_SLUG."
else
  echo "Done, but some secrets were empty in .env — fill them in and re-run."
fi
echo "Verify any time with:  gh secret list --repo $REPO_SLUG"
echo "Trigger a dry run:     gh workflow run 'Supabase Ingest Job' --repo $REPO_SLUG -f dry_run=true"
