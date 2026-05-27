#!/bin/bash
set -euo pipefail

REPO_DIR="/home/dst/dev/pi"
AGENT_DIR="/home/dst/.pi/agent"
LOG_FILE="/home/dst/.pi/sync-upstream.log"
CUSTOM_DIFF="/tmp/pi-custom-diff.patch"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

cd "$REPO_DIR"

log "========================================"
log "Starting pi upstream sync"
log "========================================"

# ── 1. Check if upstream has a newer release version ──
log "Checking upstream release version..."
NPM_VERSION=$(npm view @earendil-works/pi-coding-agent version 2>/dev/null || echo "")
LOCAL_VERSION=$(node -p "require('./packages/coding-agent/package.json').version" 2>/dev/null || echo "")

if [ -z "$NPM_VERSION" ]; then
    log "Could not fetch npm version, skipping"
    exit 0
fi

log "Local version: $LOCAL_VERSION, Upstream npm version: $NPM_VERSION"

# Compare semver: exit if local >= upstream
NEEDS_UPDATE=$(node -e "
const compare = require('semver').compare;
const local = '$LOCAL_VERSION';
const upstream = '$NPM_VERSION';
console.log(compare(local, upstream) >= 0 ? 'no' : 'yes');
" 2>/dev/null || echo "yes")

if [ "$NEEDS_UPDATE" = "no" ]; then
    log "Local version ($LOCAL_VERSION) >= upstream ($NPM_VERSION). No update needed."
    exit 0
fi

log "Upstream has newer version ($NPM_VERSION). Proceeding with sync."

# ── 2. Capture custom changes before sync ──
log "Capturing custom diff (working tree + local commits vs origin/main)..."
git diff origin/main -- packages/ai packages/coding-agent packages/tui packages/agent > "$CUSTOM_DIFF" 2>/dev/null || true

if [ ! -s "$CUSTOM_DIFF" ]; then
    log "No custom changes detected"
    CUSTOM_DIFF_HAS_CHANGES=false
else
    CUSTOM_DIFF_HAS_CHANGES=true
    log "Custom changes detected ($(wc -c < "$CUSTOM_DIFF") bytes)"
    git diff origin/main --stat -- packages/ai packages/coding-agent packages/tui packages/agent | head -20 | tee -a "$LOG_FILE"
fi

# ── 3. Stash working tree changes ──
log "Stashing working tree changes..."
git stash save "pi-sync-auto-stash" 2>&1 | tee -a "$LOG_FILE" || true

# ── 4. Sync fork: fetch upstream and merge into main ──
log "Fetching upstream..."
git fetch upstream main 2>&1 | tee -a "$LOG_FILE"

LOCAL_COMMITS=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
log "Local commits ahead of origin/main: $LOCAL_COMMITS"

if [ "$LOCAL_COMMITS" -eq 0 ]; then
    # No local feature commits — hard reset to upstream
    log "No local feature commits, hard-resetting to upstream/main..."
    git reset --hard upstream/main 2>&1 | tee -a "$LOG_FILE"
else
    # Local feature commits — merge upstream into main (Option B)
    log "Local feature commits detected, merging upstream/main into main..."
    git merge upstream/main 2>&1 | tee -a "$LOG_FILE" || {
        # Merge conflict — resolve by accepting upstream (theirs) version
        log "Merge conflict detected, resolving with upstream (theirs)..."
        CONFLICTS=0
        while git diff --name-only --diff-filter=U 2>/dev/null | grep -q .; do
            CONFLICTS=$((CONFLICTS + 1))
            if [ "$CONFLICTS" -gt 30 ]; then
                log "Too many conflicts, aborting merge"
                git merge --abort 2>&1 | tee -a "$LOG_FILE"
                git stash pop 2>&1 | tee -a "$LOG_FILE" || true
                exit 1
            fi
            git checkout --theirs $(git diff --name-only --diff-filter=U) 2>&1 | tee -a "$LOG_FILE"
            git add $(git diff --name-only --diff-filter=U) 2>&1
        done
        log "Resolved $CONFLICTS conflicts, completing merge..."
        git commit 2>&1 | tee -a "$LOG_FILE"
    }
fi

# ── 5. Pop stash, resolve conflicts ──
STASH_COUNT=$(git stash list | wc -l)
if [ "$STASH_COUNT" -gt 0 ]; then
    log "Applying stash..."
    if git stash pop 2>&1 | tee -a "$LOG_FILE"; then
        log "Stash applied successfully"
    else
        log "Stash conflicted with upstream, dropping"
        git stash drop 2>&1 | tee -a "$LOG_FILE" || true
        # Clean up any unmerged paths
        git reset --hard HEAD 2>&1 | tee -a "$LOG_FILE" || true
    fi
fi

# ── 6. Check if custom changes still needed ──
if [ "$CUSTOM_DIFF_HAS_CHANGES" = true ]; then
    log "Checking if custom changes still needed (vs new HEAD)..."
    if git apply --check "$CUSTOM_DIFF" 2>&1 | tee -a "$LOG_FILE"; then
        log "Custom changes still apply cleanly — keeping them"
    else
        log "Custom changes CONFLICT with upstream — likely already upstream. Dropping them."
    fi
fi

# ── 7. Push synced fork to origin ──
log "Pushing synced fork to origin..."
git push --force-with-lease origin main 2>&1 | tee -a "$LOG_FILE" || log "Push failed - may need manual push"

# ── 8. Install missing deps ──
log "Installing dependencies..."
npm install 2>&1 | tail -5 | tee -a "$LOG_FILE" || true

# ── 9. Build ──
log "Building..."
if npm run build 2>&1 | tee -a "$LOG_FILE"; then
    log "Build succeeded!"
else
    log "ERROR: Build failed! Trying to fix..."
    # Try installing missing types
    npm install --save-dev @types/cross-spawn 2>&1 | tee -a "$LOG_FILE" || true
    if npm run build 2>&1 | tee -a "$LOG_FILE"; then
        log "Build succeeded after fix!"
    else
        log "ERROR: Build still failed! Running pi agent to diagnose..."
        pi agent "The build failed. Diagnose and fix the build error in /home/dst/dev/pi. Check the build logs above and resolve any TypeScript errors, missing dependencies, or import issues. Then rebuild and verify the build succeeds." 2>&1 | tee -a "$LOG_FILE" || true
        exit 1
    fi
fi

# ── 10. Verify symlink ──
if [ ! -L "$AGENT_DIR/bin/pi" ] || [ "$(readlink "$AGENT_DIR/bin/pi")" != "$REPO_DIR/packages/coding-agent/dist/cli.js" ]; then
    log "Fixing symlink..."
    rm -f "$AGENT_DIR/bin/pi"
    ln -s "$REPO_DIR/packages/coding-agent/dist/cli.js" "$AGENT_DIR/bin/pi"
fi

# ── 11. Verify pi version ──
log "Verifying pi version..."
VERSION=$(pi --version 2>&1)
if [ -z "$VERSION" ]; then
    log "ERROR: pi failed to start!"
    log "Running pi agent to diagnose..."
    pi agent "pi failed to start after a sync/rebuild. Diagnose why ~/dev/pi/packages/coding-agent/dist/cli.js is not working. Check for missing files, bad imports, or runtime errors. Fix the issue and verify pi --version works." 2>&1 | tee -a "$LOG_FILE"
    exit 1
fi
log "pi version: $VERSION"

# ── 12. Live test: run pi with a simple prompt ──
log "Running live test: executing '1+1='..."
LIVE_RESULT=$(echo "What is 1+1?" | timeout 60 pi --no-tui 2>&1 || echo "TIMEOUT")
if echo "$LIVE_RESULT" | grep -qi "2\|two"; then
    log "Live test passed: pi answered correctly (got '2' for 1+1)"
else
    log "Live test failed! Result: $(echo "$LIVE_RESULT" | tail -3)"
    log "Running pi agent to diagnose..."
    pi agent "pi answered incorrectly to the prompt 'What is 1+1?'. The expected answer is 2. Diagnose why pi is not producing correct answers. Check the model configuration, LLM provider, and connection. Fix the issue and verify pi produces the correct answer." 2>&1 | tee -a "$LOG_FILE"
    exit 1
fi

# ── Done ──
rm -f "$CUSTOM_DIFF"
log "========================================"
log "Sync complete! Version: $VERSION"
log "========================================"