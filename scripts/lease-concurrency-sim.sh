#!/usr/bin/env bash
#
# Formic lease/concurrency simulation harness
# ============================================
# Creates real Formic tasks (via the REST API) whose ONLY purpose is to
# exercise the file-lease and concurrency system — NOT to implement any
# actual feature. Each task's context instructs the executing agent to:
#   1. Declare a specific, pre-agreed set of exclusive/shared files
#      (never real source files — always scratch fixtures under
#      .formic/lease-sim/).
#   2. Sleep for a controlled duration (to hold the lease/running state
#      long enough for other tasks in the scenario to collide with it).
#   3. Append one marker line to its declared file(s) — nothing else.
#
# This lets the REAL leaseManager.ts / workflow.ts / watchdog.ts code run
# exactly as it does for genuine work, so what you observe (yields, holds,
# preemption, renewal, collisions) is the actual system, not a mock.
#
# IMPORTANT — this is LLM-driven, not 100% deterministic: the task
# `context` is only injected verbatim into the BRIEF step; PLAN, DECLARE,
# and EXECUTE all work from the artifacts (README.md / PLAN.md /
# subtasks.json) that the previous step produced, not from raw context.
# Despite highly directive wording, the agent could in principle declare
# a different file than intended. This script VERIFIES the actual
# declared-files.json after each declare step and prints a clear WARN
# (without aborting) if it diverges — so you always know whether you're
# looking at the intended scenario or a drifted one.
#
# Usage:
#   ./scripts/lease-concurrency-sim.sh                 # run everything
#   ./scripts/lease-concurrency-sim.sh --list           # list scenarios
#   ./scripts/lease-concurrency-sim.sh --only 1,5,8     # run specific ones
#   ./scripts/lease-concurrency-sim.sh --setup-only      # fixtures+config only
#   ./scripts/lease-concurrency-sim.sh --restore-config  # undo config bumps
#   FORMIC_API=http://127.0.0.1:9888 ./scripts/lease-concurrency-sim.sh
#
# Cleanup is NEVER automatic (task/fixture deletion is your call) — the
# script prints exact commands for it at the end.
#
set -uo pipefail

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
API="${FORMIC_API:-http://127.0.0.1:9888}"
STATE_DIR="/tmp/formic-lease-sim"
CONFIG_BACKUP="$STATE_DIR/config-backup.json"
RUN_TAG="$(date +%Y%m%d-%H%M%S)"
FIXTURE_ROOT=".formic/lease-sim"

mkdir -p "$STATE_DIR"

# --------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; DIM=''; RESET=''
fi

hdr()   { printf '\n%s=== %s ===%s\n' "$BOLD$CYAN" "$1" "$RESET"; }
info()  { printf '  %s\n' "$1"; }
ok()    { printf '  %s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn()  { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }
err()   { printf '  %s✗ %s%s\n' "$RED" "$1" "$RESET"; }
dim()   { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || { err "Required command not found: $1"; exit 1; }; }
require_cmd curl
require_cmd jq
require_cmd git

# --------------------------------------------------------------------------
# API helpers
# --------------------------------------------------------------------------
api_get()  { curl -sS -m 15 "$API$1"; }
api_post() { curl -sS -m 15 -X POST -H 'Content-Type: application/json' -d "$2" "$API$1"; }
api_put()  { curl -sS -m 15 -X PUT  -H 'Content-Type: application/json' -d "$2" "$API$1"; }

check_api() {
  local status
  status=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$API/api/config" 2>/dev/null)
  [ -z "$status" ] && status="000"
  if [ "$status" != "200" ]; then
    err "Formic API not reachable at $API (HTTP $status)"
    info "Set FORMIC_API=http://host:port if it's running elsewhere, and make sure the server is up."
    exit 1
  fi
  ok "Formic API reachable at $API"
}

get_setting() { api_get "/api/config/settings/$1" | jq -r '.value'; }
set_setting() { api_put "/api/config/settings/$1" "$(jq -n --argjson v "$2" '{value:$v}')" >/dev/null; }

create_task() {
  local title="$1" context="$2" priority="$3" type="$4"
  local body
  body=$(jq -n --arg t "$title" --arg c "$context" --arg p "$priority" --arg ty "$type" \
    '{title:$t, context:$c, priority:$p, type:$ty}')
  api_post "/api/tasks" "$body" | jq -r '.id'
}

queue_task() { api_post "/api/tasks/$1/queue" '{}' >/dev/null; }

get_task()        { api_get "/api/tasks/$1"; }
task_status()     { get_task "$1" | jq -r '.status'; }
task_yield_count() { get_task "$1" | jq -r '.yieldCount // 0'; }
declared_files()  { api_get "/api/tasks/$1/declared-files"; }
leases_json()     { api_get "/api/leases"; }

file_lease_holder() {
  # Prints the taskId holding an EXCLUSIVE lease on $1, or empty if none.
  leases_json | jq -r --arg f "$1" '.[] | select(.filePath == $f and .leaseType == "exclusive") | .taskId' | head -1
}

file_is_leased_at_all() {
  leases_json | jq -e --arg f "$1" '.[] | select(.filePath == $f)' >/dev/null 2>&1
}

file_lease_expiry() {
  leases_json | jq -r --arg f "$1" --arg t "$2" '.[] | select(.filePath == $f and .taskId == $t) | .expiresAt' | head -1
}

# wait_for_condition <description> <timeout_seconds> <poll_seconds> <command...>
# Command should be a bash function name that returns 0 (true) when satisfied.
wait_for() {
  local desc="$1" timeout="$2" interval="$3" fn="$4"; shift 4
  local waited=0
  printf '  waiting: %s' "$desc"
  while [ "$waited" -lt "$timeout" ]; do
    if "$fn" "$@"; then
      printf ' %s[ok, %ss]%s\n' "$GREEN" "$waited" "$RESET"
      return 0
    fi
    printf '.'
    sleep "$interval"
    waited=$((waited + interval))
  done
  printf ' %s[TIMEOUT after %ss]%s\n' "$YELLOW" "$timeout" "$RESET"
  return 1
}

_cond_lease_held_by() { [ "$(file_lease_holder "$1")" = "$2" ]; }
_cond_lease_gone()    { ! file_is_leased_at_all "$1"; }
_cond_status_in()     { local s; s=$(task_status "$1"); [[ ",$2," == *",$s,"* ]]; }
_cond_yielded()       { [ "$(task_yield_count "$1")" -gt 0 ] 2>/dev/null; }

verify_declared() {
  # verify_declared <taskId> <expected_exclusive_csv> <expected_shared_csv>
  local id="$1" want_excl="$2" want_shared="$3" got
  got=$(declared_files "$id")
  local got_excl got_shared
  got_excl=$(echo "$got" | jq -r '.exclusive | join(",")')
  got_shared=$(echo "$got" | jq -r '.shared | join(",")')
  if [ "$got_excl" = "$want_excl" ] && [ "$got_shared" = "$want_shared" ]; then
    ok "declared-files.json matches expected (exclusive=[$got_excl] shared=[$got_shared])"
  else
    warn "declared-files.json DIVERGED from the intended scenario:"
    dim "  expected exclusive=[$want_excl] shared=[$want_shared]"
    dim "  actual   exclusive=[$got_excl] shared=[$got_shared]"
    dim "  (this is LLM summarization drift — see script header comment. The rest of this"
    dim "   scenario's observations will reflect whatever the agent ACTUALLY declared.)"
  fi
}

# --------------------------------------------------------------------------
# Context template — shared preamble injected into every scenario task.
# Deliberately phrased close to the brief skill's own README sections
# (Requirements / Non-Goals) to maximize survival through the brief -> plan
# -> declare -> execute summarization chain (see script header).
# --------------------------------------------------------------------------
sim_context() {
  local scenario_name="$1" sleep_seconds="$2" exclusive_csv="$3" shared_csv="$4" marker_file="$5" extra="$6"
  cat <<EOF
LEASE/CONCURRENCY TEST HARNESS TASK — DO NOT IMPLEMENT A REAL FEATURE.

This task exists ONLY to exercise Formic's own file-lease and concurrency
system (scenario: ${scenario_name}, run ${RUN_TAG}). It is not a product
change. Follow the instructions below EXACTLY and do nothing else.

## Non-Goals
- Do NOT implement any feature, fix any bug, or refactor any code.
- Do NOT read, create, or modify any file outside the exact paths listed below.
- Do NOT add tests, documentation, or dependencies.
- Do NOT run npm install, git commit, or any command other than what is listed.

## Requirements (mandatory declare-step instructions)
- When declaring files (declared-files.json), declare EXACTLY this set and
  nothing more:
  - exclusive: [${exclusive_csv:-none}]
  - shared: [${shared_csv:-none}]
- Do not classify any other file as exclusive or shared, even if the
  general declare guidelines would normally suggest package.json,
  tsconfig.json, or src/types/index.ts. This is a synthetic scratch file
  test — ignore the usual shared-hotspot heuristics for this task.

## Requirements (mandatory execution steps, run in this exact order)
1. Run this shell command via your Bash/shell tool and wait for it to
   finish before continuing: sleep ${sleep_seconds}
2. Append exactly one line to ${marker_file} using a non-destructive
   append (e.g. \`echo "# lease-sim ${scenario_name} ${RUN_TAG} \$(date -u +%FT%TZ)" >> ${marker_file}\`).
   Do not overwrite or truncate the file's existing content.
3. Do not perform any other action. Do not write a summary file, do not
   update README/PLAN beyond what the workflow itself already generates.

${extra}

## Acceptance Criteria
- declared-files.json contains exactly the exclusive/shared lists above.
- ${marker_file} has exactly one new line appended, no other changes.
- No other file in the repository is touched.
EOF
}

# --------------------------------------------------------------------------
# Setup: config bump (save originals) + fixtures
# --------------------------------------------------------------------------
setup_config() {
  hdr "Saving current config and raising concurrency for the simulation"
  local orig_max orig_watchdog
  orig_max=$(get_setting maxConcurrentSessions)
  orig_watchdog=$(get_setting watchdogIntervalMs)
  jq -n --argjson max "$orig_max" --argjson wd "$orig_watchdog" \
    '{maxConcurrentSessions:$max, watchdogIntervalMs:$wd}' > "$CONFIG_BACKUP"
  info "Backed up original settings to $CONFIG_BACKUP (maxConcurrentSessions=$orig_max, watchdogIntervalMs=$orig_watchdog)"

  set_setting maxConcurrentSessions 6
  set_setting watchdogIntervalMs 8000
  ok "maxConcurrentSessions -> 6 (so scenarios can actually run in parallel)"
  ok "watchdogIntervalMs -> 8000 (8s ticks, so expiry/renewal is observable quickly)"
  info "Takes effect within one queue-processor/watchdog poll tick — no server restart needed."
}

restore_config() {
  hdr "Restoring original config"
  if [ ! -f "$CONFIG_BACKUP" ]; then
    warn "No backup found at $CONFIG_BACKUP — nothing to restore."
    return
  fi
  local orig_max orig_watchdog
  orig_max=$(jq -r '.maxConcurrentSessions' "$CONFIG_BACKUP")
  orig_watchdog=$(jq -r '.watchdogIntervalMs' "$CONFIG_BACKUP")
  set_setting maxConcurrentSessions "$orig_max"
  set_setting watchdogIntervalMs "$orig_watchdog"
  ok "Restored maxConcurrentSessions=$orig_max, watchdogIntervalMs=$orig_watchdog"
}

setup_fixtures() {
  hdr "Setting up scratch fixtures"
  local workspace
  workspace=$(api_get "/api/workspace/info" | jq -r '.path')
  if [ -z "$workspace" ] || [ "$workspace" = "null" ]; then
    err "Could not resolve the active workspace path from /api/workspace/info"
    exit 1
  fi
  ok "Active workspace: $workspace"
  cd "$workspace" || { err "Cannot cd into workspace: $workspace"; exit 1; }

  if [ ! -d .git ]; then
    err "Workspace is not a git repository — the no-diff verification gate and"
    err "hash-based collision detection both require git. Aborting."
    exit 1
  fi

  mkdir -p "$FIXTURE_ROOT"/s1-exclusive-conflict \
           "$FIXTURE_ROOT"/s2-shared-coexist \
           "$FIXTURE_ROOT"/s3-shared-vs-exclusive \
           "$FIXTURE_ROOT"/s4-collision \
           "$FIXTURE_ROOT"/s5-preemption \
           "$FIXTURE_ROOT"/s6-renewal \
           "$FIXTURE_ROOT"/s7-fanin \
           "$FIXTURE_ROOT"/s8-cap \
           "$FIXTURE_ROOT"/s9-quick-bypass

  for f in \
    "$FIXTURE_ROOT/s1-exclusive-conflict/target.txt" \
    "$FIXTURE_ROOT/s2-shared-coexist/shared.txt" \
    "$FIXTURE_ROOT/s3-shared-vs-exclusive/fileX.txt" \
    "$FIXTURE_ROOT/s3-shared-vs-exclusive/fileY.txt" \
    "$FIXTURE_ROOT/s4-collision/shared.txt" \
    "$FIXTURE_ROOT/s5-preemption/contended.txt" \
    "$FIXTURE_ROOT/s6-renewal/target.txt" \
    "$FIXTURE_ROOT/s7-fanin/fileA.txt" \
    "$FIXTURE_ROOT/s7-fanin/fileB.txt" \
    "$FIXTURE_ROOT/s8-cap/file1.txt" \
    "$FIXTURE_ROOT/s8-cap/file2.txt" \
    "$FIXTURE_ROOT/s8-cap/file3.txt" \
    "$FIXTURE_ROOT/s8-cap/file4.txt" \
    "$FIXTURE_ROOT/s9-quick-bypass/target.txt" \
    ; do
    [ -f "$f" ] || printf 'baseline fixture — safe to append to, safe to delete this whole file\n' > "$f"
  done

  if [ -n "$(git status --porcelain -- "$FIXTURE_ROOT")" ]; then
    git add "$FIXTURE_ROOT"
    git commit -m "lease-sim: baseline fixtures (run $RUN_TAG)" --no-verify -q
    ok "Committed baseline fixtures under $FIXTURE_ROOT (clean safe point for the no-diff gate + hash baselines)"
  else
    info "Fixtures already present and committed from a prior run — reusing them."
  fi
  echo "$workspace" > "$STATE_DIR/workspace-path"
}

# --------------------------------------------------------------------------
# Scenario 1 — Exclusive/exclusive conflict, yield, and successful retry
# --------------------------------------------------------------------------
scenario_1() {
  hdr "Scenario 1: exclusive/exclusive conflict -> yield -> retry -> success"
  info "Two standard tasks both declare the SAME file exclusively. The second"
  info "must yield at declare (status -> queued, yieldCount++, resumeFromStep=declare)"
  info "until the first releases its lease, then retry and succeed."

  local file="$FIXTURE_ROOT/s1-exclusive-conflict/target.txt"
  local ctxA ctxB idA idB
  ctxA=$(sim_context "s1-holder" 60 "$file" "" "$file" "This task holds the lease first — task B (created separately) will try to acquire the same file and should yield until you finish.")
  ctxB=$(sim_context "s1-requester" 5 "$file" "" "$file" "This task intentionally requests the SAME exclusive file as another concurrently-running lease-sim task. You are expected to yield (be re-queued) until it releases — this is the scenario under test, not an error.")

  idA=$(create_task "[LEASE-SIM $RUN_TAG] S1 Holder — exclusive $file" "$ctxA" medium standard)
  idB=$(create_task "[LEASE-SIM $RUN_TAG] S1 Requester — exclusive conflict on $file (expect yield)" "$ctxB" medium standard)
  ok "Created holder=$idA requester=$idB"

  queue_task "$idA"
  wait_for "task A acquires the exclusive lease on $file" 240 5 _cond_lease_held_by "$file" "$idA" || warn "A never showed up holding the lease — check the board manually."
  verify_declared "$idA" "$file" ""

  queue_task "$idB"
  wait_for "task B yields (status queued again with yieldCount>0)" 180 5 _cond_yielded "$idB" \
    && ok "Confirmed B yielded on the conflict (this is the expected behavior)" \
    || warn "Did not observe B yield in time — it may have run after A finished too quickly, or diverged. Check manually."

  wait_for "task A releases its lease (finishes)" 180 5 _cond_lease_gone "$file"
  wait_for "task B reaches review" 240 5 _cond_status_in "$idB" "review,done"
  ok "Scenario 1 complete — inspect task $idB in the board: yieldCount, resumeFromStep history, final status."
}

# --------------------------------------------------------------------------
# Scenario 2 — Shared/shared coexistence (no yield for either)
# --------------------------------------------------------------------------
scenario_2() {
  hdr "Scenario 2: shared/shared coexistence — neither task should yield"
  info "Two tasks both declare the SAME file as SHARED (not exclusive). Per"
  info "leaseManager, shared leases never block each other — both should reach"
  info "'running' concurrently with zero yields. (A collision MAY also be"
  info "flagged afterward since both really write to the file — that's fine,"
  info "it's scenario 4's point, not this one's. This one is purely about the"
  info "lease-acquisition step never denying either task.)"

  local file="$FIXTURE_ROOT/s2-shared-coexist/shared.txt"
  local ctxA ctxB idA idB
  ctxA=$(sim_context "s2-shared-a" 20 "" "$file" "$file" "")
  ctxB=$(sim_context "s2-shared-b" 20 "" "$file" "$file" "")

  idA=$(create_task "[LEASE-SIM $RUN_TAG] S2 Shared-A on $file" "$ctxA" medium standard)
  idB=$(create_task "[LEASE-SIM $RUN_TAG] S2 Shared-B on $file" "$ctxB" medium standard)
  ok "Created A=$idA B=$idB"

  queue_task "$idA"
  queue_task "$idB"

  info "Polling both tasks until they reach running/review, without either yielding:"
  local waited=0 a_status b_status a_yield b_yield
  while [ "$waited" -lt 180 ]; do
    a_status=$(task_status "$idA"); b_status=$(task_status "$idB")
    a_yield=$(task_yield_count "$idA"); b_yield=$(task_yield_count "$idB")
    if [[ "$a_status" =~ ^(running|review|done)$ ]] && [[ "$b_status" =~ ^(running|review|done)$ ]]; then
      break
    fi
    sleep 5; waited=$((waited + 5))
  done
  if [ "${a_yield:-0}" -eq 0 ] && [ "${b_yield:-0}" -eq 0 ]; then
    ok "Neither task yielded — shared+shared coexistence confirmed (A=$a_status yields=$a_yield, B=$b_status yields=$b_yield)"
  else
    warn "One or both tasks yielded (A yields=$a_yield, B yields=$b_yield) — unexpected for pure shared/shared. Check declared-files.json for drift."
  fi
  verify_declared "$idA" "" "$file"
  verify_declared "$idB" "" "$file"

  wait_for "both tasks reach review" 240 5 _cond_status_in "$idA" "review,done"
  wait_for "both tasks reach review" 240 5 _cond_status_in "$idB" "review,done"
}

# --------------------------------------------------------------------------
# Scenario 3 — Cross-type conflicts: exclusive blocks shared, shared blocks exclusive
# --------------------------------------------------------------------------
scenario_3() {
  hdr "Scenario 3a: an EXCLUSIVE holder blocks a SHARED requester on the same file"
  local fileX="$FIXTURE_ROOT/s3-shared-vs-exclusive/fileX.txt"
  local ctxHolder ctxRequester idHolder idRequester
  ctxHolder=$(sim_context "s3a-exclusive-holder" 60 "$fileX" "" "$fileX" "")
  ctxRequester=$(sim_context "s3a-shared-requester" 5 "" "$fileX" "$fileX" "You are requesting this file as SHARED while another task holds it EXCLUSIVELY. You are expected to yield until it releases.")

  idHolder=$(create_task "[LEASE-SIM $RUN_TAG] S3a Exclusive holder on $fileX" "$ctxHolder" medium standard)
  idRequester=$(create_task "[LEASE-SIM $RUN_TAG] S3a Shared requester vs exclusive (expect yield)" "$ctxRequester" medium standard)
  ok "Created holder=$idHolder requester=$idRequester"

  queue_task "$idHolder"
  wait_for "exclusive holder acquires $fileX" 240 5 _cond_lease_held_by "$fileX" "$idHolder"
  verify_declared "$idHolder" "$fileX" ""

  queue_task "$idRequester"
  wait_for "shared requester yields against the exclusive lease" 180 5 _cond_yielded "$idRequester" \
    && ok "Confirmed: exclusive lease blocked the shared request, as expected" \
    || warn "Did not observe the expected yield — check manually."

  wait_for "holder releases (finishes)" 180 5 _cond_lease_gone "$fileX"
  wait_for "requester reaches review" 240 5 _cond_status_in "$idRequester" "review,done"

  hdr "Scenario 3b: a SHARED holder blocks an EXCLUSIVE requester on the same file"
  local fileY="$FIXTURE_ROOT/s3-shared-vs-exclusive/fileY.txt"
  local ctxSharedHolder ctxExclRequester idSharedHolder idExclRequester
  ctxSharedHolder=$(sim_context "s3b-shared-holder" 60 "" "$fileY" "$fileY" "")
  ctxExclRequester=$(sim_context "s3b-exclusive-requester" 5 "$fileY" "" "$fileY" "You are requesting this file EXCLUSIVELY while another task holds a SHARED lease on it. You are expected to yield until it releases.")

  idSharedHolder=$(create_task "[LEASE-SIM $RUN_TAG] S3b Shared holder on $fileY" "$ctxSharedHolder" medium standard)
  idExclRequester=$(create_task "[LEASE-SIM $RUN_TAG] S3b Exclusive requester vs shared (expect yield)" "$ctxExclRequester" medium standard)
  ok "Created holder=$idSharedHolder requester=$idExclRequester"

  queue_task "$idSharedHolder"
  # Shared leases are stored under a scoped key, so file_lease_holder (which
  # only matches leaseType=="exclusive") won't see it — poll declared_files/
  # status instead to know when it has acquired and moved to running.
  wait_for "shared holder reaches running" 240 5 _cond_status_in "$idSharedHolder" "running,review,done"
  verify_declared "$idSharedHolder" "" "$fileY"

  queue_task "$idExclRequester"
  wait_for "exclusive requester yields against the shared lease" 180 5 _cond_yielded "$idExclRequester" \
    && ok "Confirmed: shared lease blocked the exclusive request, as expected" \
    || warn "Did not observe the expected yield — check manually."

  wait_for "shared holder finishes" 180 5 _cond_status_in "$idSharedHolder" "review,done"
  wait_for "exclusive requester reaches review" 240 5 _cond_status_in "$idExclRequester" "review,done"
}

# --------------------------------------------------------------------------
# Scenario 4 — Optimistic concurrency collision on a shared file
# --------------------------------------------------------------------------
scenario_4() {
  hdr "Scenario 4: optimistic-concurrency collision detection on a shared file"
  info "Both tasks declare the file as SHARED (no lease-level blocking). Task A"
  info "is short and finishes first, genuinely modifying the file. Task B sleeps"
  info "much longer, so by the time IT finishes, the file has changed since B's"
  info "own declare-time hash baseline — detectCollisions() should flag it in"
  info "B's task.fileConflicts."

  local file="$FIXTURE_ROOT/s4-collision/shared.txt"
  local ctxA ctxB idA idB
  ctxA=$(sim_context "s4-fast-writer" 10 "" "$file" "$file" "")
  ctxB=$(sim_context "s4-slow-writer" 60 "" "$file" "$file" "By the time your sleep finishes, the other lease-sim task will likely have already modified this same shared file. That is expected and is exactly what this scenario is testing.")

  idA=$(create_task "[LEASE-SIM $RUN_TAG] S4 Fast writer on shared $file" "$ctxA" medium standard)
  idB=$(create_task "[LEASE-SIM $RUN_TAG] S4 Slow writer on shared $file (expect fileConflicts)" "$ctxB" medium standard)
  ok "Created fast=$idA slow=$idB"

  queue_task "$idA"
  queue_task "$idB"

  wait_for "fast writer (A) reaches review" 180 5 _cond_status_in "$idA" "review,done"
  wait_for "slow writer (B) reaches review" 300 5 _cond_status_in "$idB" "review,done"

  local conflicts
  conflicts=$(get_task "$idB" | jq -c '.fileConflicts // []')
  if [ "$conflicts" != "[]" ]; then
    ok "Collision detected on task $idB: $conflicts"
  else
    warn "No fileConflicts recorded on $idB. Possible causes: A finished after B's"
    warn "hash check ran, or the LLM didn't actually touch the shared file both"
    warn "times, or timing didn't stagger as intended. Check declared-files.json"
    warn "and each task's execute log to see what actually happened."
  fi
  verify_declared "$idA" "" "$file"
  verify_declared "$idB" "" "$file"
}

# --------------------------------------------------------------------------
# Scenario 5 — Priority preemption
# --------------------------------------------------------------------------
scenario_5() {
  hdr "Scenario 5: priority preemption (high-priority requester tears down a low-priority holder)"
  info "A low-priority task holds an exclusive lease. A high-priority task then"
  info "requests the same file. Per leaseManager.preemptLease, since the"
  info "requester's priority rank exceeds the holder's, the holder should be"
  info "torn down (process stopped, changes reverted, lease released, re-queued)"
  info "so the high-priority task can proceed quickly instead of waiting it out."

  local file="$FIXTURE_ROOT/s5-preemption/contended.txt"
  local ctxLow ctxHigh idLow idHigh
  ctxLow=$(sim_context "s5-low-priority-holder" 90 "$file" "" "$file" "")
  ctxHigh=$(sim_context "s5-high-priority-requester" 5 "$file" "" "$file" "You request the same file as a low-priority lease-sim task. Because you are high priority, you should be preempted-in favor of, i.e. the other task gets torn down so you can proceed quickly.")

  idLow=$(create_task "[LEASE-SIM $RUN_TAG] S5 LOW priority holder on $file" "$ctxLow" low standard)
  idHigh=$(create_task "[LEASE-SIM $RUN_TAG] S5 HIGH priority requester on $file (expect preemption)" "$ctxHigh" high standard)
  ok "Created low=$idLow high=$idHigh"

  queue_task "$idLow"
  wait_for "low-priority task acquires $file" 240 5 _cond_lease_held_by "$file" "$idLow"
  verify_declared "$idLow" "$file" ""

  local low_status_before
  low_status_before=$(task_status "$idLow")
  info "Low-priority task status before high-priority request: $low_status_before"

  queue_task "$idHigh"
  wait_for "high-priority task acquires $file (after preempting the holder)" 120 5 _cond_lease_held_by "$file" "$idHigh" \
    && ok "Preemption worked: high-priority task now holds the lease" \
    || warn "High-priority task never showed as holding the lease in time — check whether preemption fired (server logs: '[LeaseManager] Preempting lease')."

  local low_status_after
  low_status_after=$(task_status "$idLow")
  info "Low-priority task status after preemption attempt: $low_status_after"
  if [ "$low_status_after" != "$low_status_before" ]; then
    ok "Low-priority task's status changed ($low_status_before -> $low_status_after) — consistent with being torn down/re-queued."
  else
    warn "Low-priority task's status did not change — preemption may not have fired (e.g. if it already finished before the high-priority request arrived)."
  fi

  wait_for "high-priority task reaches review" 240 5 _cond_status_in "$idHigh" "review,done"
}

# --------------------------------------------------------------------------
# Scenario 6 — Lease renewal during a legitimately long execution
# --------------------------------------------------------------------------
scenario_6() {
  hdr "Scenario 6: lease renewal for an actively-running task (no crash)"
  info "leaseDurationMs is temporarily shortened so the lease would expire mid-"
  info "execution. Because the task's workflow process is genuinely still"
  info "running (isWorkflowRunning=true), the watchdog should RENEW the lease"
  info "(extend expiresAt) instead of tearing the task down. Watch expiresAt"
  info "advance below rather than the lease disappearing."

  local orig_lease_ms
  orig_lease_ms=$(get_setting leaseDurationMs)
  set_setting leaseDurationMs 20000
  ok "Temporarily set leaseDurationMs=20000 (20s) for this scenario"

  local file="$FIXTURE_ROOT/s6-renewal/target.txt"
  local ctx id
  ctx=$(sim_context "s6-renewal" 55 "$file" "" "$file" "Your sleep (55s) deliberately exceeds the current lease duration (20s) so Formic's watchdog must renew your lease at least twice while you are still actively running. This is expected — do not shorten the sleep.")
  id=$(create_task "[LEASE-SIM $RUN_TAG] S6 Long-running holder on $file (expect renewal)" "$ctx" medium standard)
  ok "Created task=$id"

  queue_task "$id"
  wait_for "task acquires $file" 240 5 _cond_lease_held_by "$file" "$id"
  verify_declared "$id" "$file" ""

  info "Polling expiresAt every 6s for ~48s — it should move forward, not vanish:"
  local i expiry
  for i in $(seq 1 8); do
    expiry=$(file_lease_expiry "$file" "$id")
    if [ -z "$expiry" ]; then
      warn "  [$i] lease is GONE — task may have been torn down instead of renewed (unexpected)"
    else
      info "  [$i] expiresAt = $expiry"
    fi
    sleep 6
  done

  wait_for "task reaches review" 180 5 _cond_status_in "$id" "review,done"
  set_setting leaseDurationMs "$orig_lease_ms"
  ok "Restored leaseDurationMs=$orig_lease_ms"
}

# --------------------------------------------------------------------------
# Scenario 7 — Fan-in wait (negative deadlock test)
# --------------------------------------------------------------------------
scenario_7() {
  hdr "Scenario 7: fan-in wait — a third task waits on two independent holders (must NOT be flagged as a deadlock)"
  info "Task A holds fileA, task B holds fileB (independently, no conflict"
  info "between them). Task C requests BOTH files at once (all-or-nothing) and"
  info "is denied entirely, so it waits on both holders. Since neither A nor B"
  info "is itself waiting on anything, this is a 'star', not a cycle —"
  info "detectDeadlock() must NOT report it. Watch the server log for the"
  info "absence of '[LeaseManager] Detected N deadlock cycle(s)' during this"
  info "window (there is no REST endpoint exposing the wait-for graph directly)."

  local fileA="$FIXTURE_ROOT/s7-fanin/fileA.txt"
  local fileB="$FIXTURE_ROOT/s7-fanin/fileB.txt"
  local ctxA ctxB ctxC idA idB idC
  ctxA=$(sim_context "s7-holder-a" 60 "$fileA" "" "$fileA" "")
  ctxB=$(sim_context "s7-holder-b" 60 "$fileB" "" "$fileB" "")
  ctxC=$(sim_context "s7-fanin-waiter" 5 "$fileA,$fileB" "" "$fileA" "You request BOTH $fileA and $fileB exclusively in the SAME declare step. Both are expected to already be held by other lease-sim tasks, so your whole request should be denied and you should yield waiting on both.")

  idA=$(create_task "[LEASE-SIM $RUN_TAG] S7 Holder-A on $fileA" "$ctxA" medium standard)
  idB=$(create_task "[LEASE-SIM $RUN_TAG] S7 Holder-B on $fileB" "$ctxB" medium standard)
  idC=$(create_task "[LEASE-SIM $RUN_TAG] S7 Fan-in waiter on both (expect yield, NOT deadlock)" "$ctxC" medium standard)
  ok "Created A=$idA B=$idB C=$idC"

  queue_task "$idA"; queue_task "$idB"
  wait_for "holder A acquires $fileA" 240 5 _cond_lease_held_by "$fileA" "$idA"
  wait_for "holder B acquires $fileB" 240 5 _cond_lease_held_by "$fileB" "$idB"
  verify_declared "$idA" "$fileA" ""
  verify_declared "$idB" "$fileB" ""

  queue_task "$idC"
  wait_for "fan-in waiter (C) yields" 180 5 _cond_yielded "$idC" \
    && ok "C yielded as expected — check server logs to confirm NO deadlock cycle was logged" \
    || warn "Did not observe C yield — check manually."

  wait_for "A finishes" 180 5 _cond_status_in "$idA" "review,done"
  wait_for "B finishes" 180 5 _cond_status_in "$idB" "review,done"
  wait_for "C eventually completes once both files are free" 240 5 _cond_status_in "$idC" "review,done"
  ok "Scenario 7 complete — A and B should have finished normally (not torn down for 'deadlock_resolution')."
}

# --------------------------------------------------------------------------
# Scenario 8 — Concurrency cap enforcement
# --------------------------------------------------------------------------
scenario_8() {
  hdr "Scenario 8: maxConcurrentSessions caps how many tasks actually run in parallel"
  local orig_cap
  orig_cap=$(get_setting maxConcurrentSessions)
  set_setting maxConcurrentSessions 2
  ok "Temporarily set maxConcurrentSessions=2 for this scenario"

  info "Queuing 4 fully independent tasks (no file overlap at all) at once."
  info "Even though nothing conflicts at the lease level, the queue processor"
  info "should never run more than 2 concurrently."

  local ids=()
  local i file ctx id
  for i in 1 2 3 4; do
    file="$FIXTURE_ROOT/s8-cap/file${i}.txt"
    ctx=$(sim_context "s8-cap-$i" 30 "$file" "" "$file" "")
    id=$(create_task "[LEASE-SIM $RUN_TAG] S8 Cap test task $i (independent file)" "$ctx" medium standard)
    ids+=("$id")
    queue_task "$id"
  done
  ok "Created and queued: ${ids[*]}"

  info "Sampling active-task count every 5s for 60s (should never exceed 2):"
  local t active max_seen=0
  for t in $(seq 1 12); do
    active=0
    for id in "${ids[@]}"; do
      local s; s=$(task_status "$id")
      if [[ "$s" =~ ^(declaring|running)$ ]]; then
        active=$((active + 1))
      fi
    done
    [ "$active" -gt "$max_seen" ] && max_seen=$active
    info "  [$t] active (declaring/running) count = $active"
    sleep 5
  done

  if [ "$max_seen" -le 2 ]; then
    ok "Max observed concurrent = $max_seen — cap respected"
  else
    warn "Max observed concurrent = $max_seen — exceeded the configured cap of 2, investigate queueProcessor.ts"
  fi

  for id in "${ids[@]}"; do
    wait_for "task $id reaches review" 180 5 _cond_status_in "$id" "review,done"
  done

  set_setting maxConcurrentSessions "$orig_cap"
  ok "Restored maxConcurrentSessions=$orig_cap"
}

# --------------------------------------------------------------------------
# Scenario 9 — Quick-task lease bypass (awareness, not a bug)
# --------------------------------------------------------------------------
scenario_9() {
  hdr "Scenario 9: 'quick' tasks skip declare/lease entirely — awareness check"
  info "executeQuickTask() never calls the declare step, so a quick task is NOT"
  info "subject to any exclusive lease held by a standard task — even on the"
  info "SAME file. This is documented/expected (quick tasks are meant for tiny,"
  info "isolated changes) but worth confirming so it's not a surprise."

  local file="$FIXTURE_ROOT/s9-quick-bypass/target.txt"
  local ctxStandard ctxQuick idStandard idQuick
  ctxStandard=$(sim_context "s9-standard-holder" 60 "$file" "" "$file" "")
  ctxQuick="LEASE/CONCURRENCY TEST HARNESS TASK (quick type) — run ${RUN_TAG}.
Immediately append exactly one line to ${file} (e.g. \`echo \"# lease-sim s9-quick ${RUN_TAG} \$(date -u +%FT%TZ)\" >> ${file}\`) and do nothing else. Do not modify any other file."

  idStandard=$(create_task "[LEASE-SIM $RUN_TAG] S9 Standard holder on $file" "$ctxStandard" medium standard)
  idQuick=$(create_task "[LEASE-SIM $RUN_TAG] S9 Quick task touching same file (expect NO blocking)" "$ctxQuick" medium quick)
  ok "Created standard=$idStandard quick=$idQuick"

  queue_task "$idStandard"
  wait_for "standard task acquires exclusive lease on $file" 240 5 _cond_lease_held_by "$file" "$idStandard"
  verify_declared "$idStandard" "$file" ""

  queue_task "$idQuick"
  wait_for "quick task reaches review (should be fast, no declaring/yield stage at all)" 120 5 _cond_status_in "$idQuick" "review,done" \
    && ok "Quick task completed without ever entering 'declaring' — confirms it bypassed the lease system entirely" \
    || warn "Quick task didn't complete in time — check manually."

  local quick_yields
  quick_yields=$(task_yield_count "$idQuick")
  if [ "${quick_yields:-0}" -eq 0 ]; then
    ok "Quick task had 0 yields, as expected (it never contended for the lease at all)"
  else
    warn "Quick task showed yieldCount=$quick_yields — unexpected, investigate."
  fi

  wait_for "standard task finishes" 180 5 _cond_status_in "$idStandard" "review,done"
}

# --------------------------------------------------------------------------
# Documented, non-automated notes
# --------------------------------------------------------------------------
print_zombie_runbook() {
  hdr "Manual scenario: zombie-lease cleanup via server crash/restart (not automated)"
  cat <<'EOF'
  This scenario requires killing/restarting the Formic SERVER process itself
  (not just an agent CLI) while a task holds a lease — that's a deliberate
  action only you should trigger, so it's not automated here. Steps:

  1. Run one lease-sim task with a long sleep (e.g. re-run scenario 1's
     holder alone) and wait until GET /api/leases shows it holding its file.
  2. Stop the Formic server (Ctrl+C, or kill the process) WHILE that task
     is still sleeping/holding the lease. Its in-memory activeWorkflows
     entry is lost, but the lease was already persisted to
     .formic/leases.json by acquireLeases().
  3. Restart the server. On startup it calls restoreLeases() (reloads
     non-expired leases from disk) and recoverStuckTasks() (recovers tasks
     stuck in an active status when the server went down).
  4. Watch what happens to the lease: since the new process has no
     activeWorkflows entry for that old task, isWorkflowRunning() returns
     false for it. Once its expiresAt passes, the watchdog's
     scanExpiredLeases() should treat it as orphaned and call
     teardownTask(id, 'lease_expired') — reverting any uncommitted change,
     releasing the lease, and re-queuing the task — rather than renewing it.
  5. Confirm via GET /api/leases (lease gone) and the task's status/history
     (should show a teardown/re-queue, not silent limbo).
EOF
}

print_deadlock_limitation_note() {
  hdr "Note: true circular (A-waits-on-B, B-waits-on-A) deadlocks are not reachable via the live task workflow"
  cat <<'EOF'
  By design, a task only calls acquireLeases() ONCE per attempt (at its
  single declare step); a task that successfully acquires never re-declares
  mid-execution, and a task that fails becomes a pure waiter holding
  nothing. That means the wait-for graph can only ever grow "waiter ->
  holder" edges, never "holder -> also-waiting-on-something-else" edges —
  so a genuine 2-cycle cannot form through ordinary queued tasks, no matter
  how you sequence them. This is a structural safety property of the
  all-or-nothing single-shot declare model, not a gap in this script.

  detectDeadlock()'s cycle-detection algorithm is still real and load-
  bearing (it protects against future features that might allow partial/
  incremental lease requests) and is already covered directly at the unit
  level, where recordWait()/acquireLeases() are called manually to
  construct a genuine cycle:
    - test/unit/deadlockDetection.test.ts
    - test/test_deadlock_survivor.py
  Run those for cycle-detection coverage; this script's scenario 7 is the
  closest live-system analog (a fan-in wait that must NOT be misreported
  as a cycle).
EOF
}

# --------------------------------------------------------------------------
# Listing / summary
# --------------------------------------------------------------------------
SCENARIOS=(1 2 3 4 5 6 7 8 9)
scenario_name() {
  case "$1" in
    1) echo "Exclusive/exclusive conflict -> yield -> retry -> success";;
    2) echo "Shared/shared coexistence (no yield)";;
    3) echo "Cross-type conflicts: exclusive-blocks-shared and shared-blocks-exclusive";;
    4) echo "Optimistic-concurrency collision detection on a shared file";;
    5) echo "Priority preemption (high priority tears down low-priority holder)";;
    6) echo "Lease renewal for a legitimately long-running task";;
    7) echo "Fan-in wait — negative deadlock test";;
    8) echo "maxConcurrentSessions concurrency cap enforcement";;
    9) echo "Quick-task lease bypass awareness check";;
  esac
}

list_scenarios() {
  hdr "Available scenarios"
  local n
  for n in "${SCENARIOS[@]}"; do
    printf '  %s. %s\n' "$n" "$(scenario_name "$n")"
  done
  echo
  echo "  Plus two documented (non-automated) notes: zombie-lease crash recovery,"
  echo "  and why true circular deadlocks aren't reachable via the live workflow."
}

run_scenario() {
  case "$1" in
    1) scenario_1;; 2) scenario_2;; 3) scenario_3;; 4) scenario_4;;
    5) scenario_5;; 6) scenario_6;; 7) scenario_7;; 8) scenario_8;; 9) scenario_9;;
    *) err "Unknown scenario: $1";;
  esac
}

print_final_summary() {
  hdr "Done"
  cat <<EOF
  All requested scenarios ran (see WARN lines above for anything that
  diverged from the intended timing/declaration — that's the LLM-drift
  risk described in this script's header, not necessarily a real bug).

  Inspect results:
    - Board UI: open Formic and filter for "[LEASE-SIM $RUN_TAG]"
    - Live leases:        curl -s $API/api/leases | jq
    - A task's detail:    curl -s $API/api/tasks/<id> | jq
    - Declared files:     curl -s $API/api/tasks/<id>/declared-files | jq

  Cleanup (NOT automatic — run these yourself when ready):
    - Delete a task:  curl -X DELETE $API/api/tasks/<id>
    - Remove fixtures: rm -rf "\$(curl -s $API/api/workspace/info | jq -r .path)/$FIXTURE_ROOT"
                       (then git add -A && git commit -m "lease-sim: remove fixtures")
    - Config was already restored automatically by this run (or run
      '$0 --restore-config' if it was interrupted).
EOF
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
usage() {
  sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  local only="" setup_only=0 restore_only=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --list) check_api; list_scenarios; exit 0;;
      --only) only="$2"; shift 2;;
      --setup-only) setup_only=1; shift;;
      --restore-config) restore_only=1; shift;;
      --api) API="$2"; shift 2;;
      -h|--help) usage; exit 0;;
      *) err "Unknown argument: $1"; usage; exit 1;;
    esac
  done

  check_api

  if [ "$restore_only" -eq 1 ]; then
    restore_config
    exit 0
  fi

  setup_config
  setup_fixtures

  if [ "$setup_only" -eq 1 ]; then
    ok "Setup complete (config bumped, fixtures committed). Run scenarios with --only, or with no flags for all."
    exit 0
  fi

  # Ensure config is restored even if a scenario errors out or the user Ctrl-Cs.
  trap restore_config EXIT

  if [ -n "$only" ]; then
    IFS=',' read -ra list <<< "$only"
    for n in "${list[@]}"; do run_scenario "$n"; done
  else
    for n in "${SCENARIOS[@]}"; do run_scenario "$n"; done
    print_zombie_runbook
    print_deadlock_limitation_note
  fi

  print_final_summary
}

main "$@"
