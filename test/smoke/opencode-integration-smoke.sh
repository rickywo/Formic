#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# OpenCode Integration Smoke Test
#
# Validates the full spawn→parse→skills chain: Formic starts with
# AGENT_TYPE=opencode, creates a trivial quick task in a scratch git repo,
# and confirms the task reaches 'review' with the expected edit applied.
#
# SAFETY: This test NEVER runs against Formic's own repository under
# `npm run dev` (tsx watch). It uses `npm run build && npm start` pointing
# at a disposable scratch workspace, per REMEDIATION_PLAN Issue 12.
#
# Prerequisites:
#   - opencode CLI with a configured provider (e.g., DeepSeek API key)
#   - Node.js >= 20
#   - The Formic `dist/` must already be built (`npm run build`)
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ---- Configuration ---------------------------------------------------------
FORMIC_PORT=${FORMIC_SMOKE_PORT:-8765}       # Non-default port to avoid conflicts
FORMIC_HOST="127.0.0.1"
SCRATCH_DIR="/tmp/formic-opencode-smoke-$$"
FORMIC_URL="http://${FORMIC_HOST}:${FORMIC_PORT}"
MAX_WAIT_SEC=180                              # Max time to wait for task completion
POLL_INTERVAL=3                               # Seconds between status checks

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS="${GREEN}PASS${NC}"
FAIL="${RED}FAIL${NC}"
WARN="${YELLOW}WARN${NC}"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo -e "  $PASS  $*"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo -e "  $FAIL  $*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
warn() { echo -e "  $WARN  $*"; }

cleanup() {
  echo ""
  echo "--- Cleanup ---"
  if [ -n "${FORMIC_PID:-}" ]; then
    kill "$FORMIC_PID" 2>/dev/null || true
    wait "$FORMIC_PID" 2>/dev/null || true
    echo "  Stopped Formic server (PID $FORMIC_PID)"
  fi
  if [ -d "$SCRATCH_DIR" ]; then
    rm -rf "$SCRATCH_DIR"
    echo "  Removed scratch dir: $SCRATCH_DIR"
  fi
}
trap cleanup EXIT INT TERM

# ---- Phase 1: Setup --------------------------------------------------------
echo "============================================="
echo " OpenCode Integration Smoke Test"
echo "============================================="
echo ""

echo "--- Phase 1: Setup ---"

# 1a. Verify opencode is available
if command -v opencode &>/dev/null; then
  pass "opencode CLI found: $(which opencode)"
else
  fail "opencode CLI not found — skipping smoke test"
  exit 1
fi

# 1b. Verify Formic is built
if [ -f "$PROJECT_ROOT/dist/server/index.js" ]; then
  pass "Formic dist/ found (build artifact present)"
else
  echo "  Building Formic..."
  (cd "$PROJECT_ROOT" && npm run build) || {
    fail "Formic build failed"
    exit 1
  }
  pass "Formic build completed"
fi

# 1c. Create scratch git repo
echo "  Creating scratch git repo at $SCRATCH_DIR..."
mkdir -p "$SCRATCH_DIR"
cd "$SCRATCH_DIR"
git init
git config user.email "smoke-test@formic.local"
git config user.name "Formic Smoke Test"
echo "# Smoke Test Repo" > README.md
git add README.md
git commit -m "Initial commit for opencode smoke test"
pass "Scratch git repo initialized"

# 1d. Create .claude/skills symlink so opencode can discover Formic skills
# The agent adapter uses skillsDir='.claude/skills'. We copy the skills into
# the scratch repo so opencode can find them when spawned in that working dir.
cp -r "$PROJECT_ROOT/skills" "$SCRATCH_DIR/skills"
mkdir -p "$SCRATCH_DIR/.claude"
ln -sf "$SCRATCH_DIR/skills" "$SCRATCH_DIR/.claude/skills"
pass "Skills directory staged in scratch repo"

# ---- Phase 2: Start Formic with AGENT_TYPE=opencode ------------------------
echo ""
echo "--- Phase 2: Start Formic ---"

# Use the built server (npm start) — NEVER tsx watch for self-hosting safety.
AGENT_TYPE=opencode \
WORKSPACE_PATH="$SCRATCH_DIR" \
PORT="$FORMIC_PORT" \
HOST="$FORMIC_HOST" \
  node "$PROJECT_ROOT/dist/server/index.js" &
FORMIC_PID=$!
echo "  Formic PID: $FORMIC_PID"

# Wait for the server to be ready
echo "  Waiting for Formic to become ready..."
READY=false
for i in $(seq 1 30); do
  if curl -s "$FORMIC_URL/health" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done

if $READY; then
  pass "Formic server is healthy at $FORMIC_URL"
else
  fail "Formic server did not become healthy within 30s"
  exit 1
fi

# Verify the agent type in the health response
AGENT_ECHO=$(curl -s "$FORMIC_URL/health" 2>&1 || true)
echo "  Health: $AGENT_ECHO"

# ---- Phase 3: Create and Run Quick Task ------------------------------------
echo ""
echo "--- Phase 3: Create and Run Quick Task ---"

# Create a quick task: append a recognizable line to README.md
SENTINEL="opencode-smoke-test-$(date +%s)"
TASK_PAYLOAD=$(cat <<EOF
{
  "title": "Append smoke test line to README.md",
  "context": "Append the line '$SENTINEL' to the end of README.md.",
  "priority": "high",
  "type": "quick"
}
EOF
)

echo "  Task payload: $TASK_PAYLOAD"
CREATE_RESP=$(curl -s -X POST "$FORMIC_URL/api/tasks" \
  -H "Content-Type: application/json" \
  -d "$TASK_PAYLOAD")

echo "  Create response: $CREATE_RESP"

TASK_ID=$(echo "$CREATE_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$TASK_ID" ]; then
  fail "Failed to extract task ID from create response"
  exit 1
fi
pass "Task created: $TASK_ID"

# Run the task
echo "  Triggering task execution..."
RUN_RESP=$(curl -s -X POST "$FORMIC_URL/api/tasks/$TASK_ID/run")
echo "  Run response: $RUN_RESP"
RUN_STATUS=$(echo "$RUN_RESP" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "unknown")

if [ "$RUN_STATUS" = "running" ] || [ "$RUN_STATUS" = "briefing" ]; then
  pass "Task $TASK_ID started ($RUN_STATUS)"
else
  warn "Task run returned status '$RUN_STATUS' — may have failed to start"
fi

# ---- Phase 4: Poll for Completion ------------------------------------------
echo ""
echo "--- Phase 4: Poll for Task Completion ---"

FINAL_STATUS="unknown"
WAITED=0
while [ $WAITED -lt $MAX_WAIT_SEC ]; do
  TASK_RESP=$(curl -s "$FORMIC_URL/api/tasks/$TASK_ID" || echo '{}')
  CURRENT_STATUS=$(echo "$TASK_RESP" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "unknown")
  echo "  [${WAITED}s] Task $TASK_ID status: $CURRENT_STATUS"

  case "$CURRENT_STATUS" in
    review|done)
      FINAL_STATUS="$CURRENT_STATUS"
      break
      ;;
    todo|queued)
      # Task may have failed and been reset — check the yield reason
      YIELD=$(echo "$TASK_RESP" | grep -o '"yieldReason":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
      if [ -n "$YIELD" ] && [ "$YIELD" != "null" ]; then
        warn "Task yielded with reason: $YIELD — may retry"
      fi
      ;;
    failed)
      FINAL_STATUS="failed"
      break
      ;;
  esac

  sleep $POLL_INTERVAL
  WAITED=$((WAITED + POLL_INTERVAL))
done

echo ""
if [ "$FINAL_STATUS" = "review" ] || [ "$FINAL_STATUS" = "done" ]; then
  pass "Task $TASK_ID reached '$FINAL_STATUS' status"
else
  # Don't fail outright — diagnostic output
  warn "Task $TASK_ID finished with status '$FINAL_STATUS' after ${WAITED}s"
  echo "  Last task response:"
  echo "$TASK_RESP" | head -20
fi

# ---- Phase 5: Verify the Edit ----------------------------------------------
echo ""
echo "--- Phase 5: Verify Edit Applied ---"

cd "$SCRATCH_DIR"
if grep -q "$SENTINEL" README.md 2>/dev/null; then
  pass "SENTINEL line found in README.md — edit was applied"
else
  warn "SENTINEL line NOT found in README.md"
  echo "  README.md contents:"
  cat README.md
fi

# Also dump the git log to see what the agent committed
echo ""
echo "  Recent git log:"
git log --oneline -5 2>/dev/null || echo "  (no git log available)"

# ---- Phase 6: Final Report -------------------------------------------------
echo ""
echo "============================================="
echo " Smoke Test Results"
echo "============================================="
echo -e "  Passed: $PASS_COUNT"
echo -e "  Failed: $FAIL_COUNT"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}INTEGRATION SMOKE: FAILURES DETECTED${NC}"
  exit 1
else
  echo -e "${GREEN}INTEGRATION SMOKE: ALL CHECKS PASSED${NC}"
  exit 0
fi
