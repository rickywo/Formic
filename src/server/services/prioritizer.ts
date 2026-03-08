/**
 * Automated queue re-prioritizer.
 * Scores and re-orders queued tasks based on dependency graph analysis.
 * Called inside processQueue() before task pickup to maximise DAG throughput.
 */
import type { Task, QueueAnalysisEntry } from '../../types/index.js';

// ==================== Scoring Constants ====================

const FIX_BONUS = 1000;
const UNBLOCK_BONUS = 100;
const PRIORITY_SCORES: Record<string, number> = { high: 30, medium: 20, low: 10 };
const MAX_AGE_BONUS = 10;

// ==================== Private Helpers ====================

/**
 * Build a reverse dependency graph from the full task list.
 * Maps each depId → array of taskIds that declare it in their dependsOnResolved.
 */
function buildReverseDepGraph(allTasks: Task[]): Map<string, string[]> {
  const reverseGraph = new Map<string, string[]>();
  for (const task of allTasks) {
    if (!task.dependsOnResolved || task.dependsOnResolved.length === 0) continue;
    for (const depId of task.dependsOnResolved) {
      const dependents = reverseGraph.get(depId) ?? [];
      dependents.push(task.id);
      reverseGraph.set(depId, dependents);
    }
  }
  return reverseGraph;
}

/**
 * BFS over the reverse dependency graph starting from taskId.
 * Counts the number of unique `blocked` tasks transitively reachable —
 * these are the tasks that would eventually become runnable once taskId completes.
 */
function countTransitivelyUnblocked(
  taskId: string,
  reverseGraph: Map<string, string[]>,
  allTasksMap: Map<string, Task>,
): number {
  const visited = new Set<string>();
  const queue: string[] = [taskId];
  let count = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const dependents = reverseGraph.get(current) ?? [];
    for (const dependentId of dependents) {
      if (visited.has(dependentId)) continue;
      const dependent = allTasksMap.get(dependentId);
      if (dependent?.status === 'blocked') {
        count++;
        // Continue BFS — this task may itself transitively unblock further tasks
        queue.push(dependentId);
      }
    }
  }

  return count;
}

/**
 * Compute a numeric score and human-readable reasoning for a single queued task.
 * Score components (higher = picked first):
 *   - Fix bonus:          +1000 if fixForTaskId is set
 *   - Unblocking:         +100 per transitively blocked task that becomes runnable
 *   - Manual priority:    high=+30, medium=+20, low=+10
 *   - FIFO age bonus:     +min(ageMs/1000, 10)
 */
function scoreTask(
  task: Task,
  unblockingPotential: number,
): { score: number; reasoning: string } {
  const fixBonus = task.fixForTaskId ? FIX_BONUS : 0;
  const unblockScore = unblockingPotential * UNBLOCK_BONUS;
  const priorityScore = PRIORITY_SCORES[task.priority] ?? PRIORITY_SCORES['medium'];
  const ageMs = Date.now() - new Date(task.queuedAt ?? task.createdAt ?? new Date().toISOString()).getTime();
  const ageBonus = Math.min(ageMs / 1000, MAX_AGE_BONUS);
  const score = fixBonus + unblockScore + priorityScore + ageBonus;

  const parts: string[] = [];
  if (fixBonus > 0) parts.push(`fix-bonus(+${fixBonus})`);
  if (unblockScore > 0) parts.push(`unblocking(${unblockingPotential}×+${UNBLOCK_BONUS}=+${unblockScore})`);
  parts.push(`priority(${task.priority}=+${priorityScore})`);
  parts.push(`age(+${ageBonus.toFixed(1)})`);
  const reasoning = `score=${score.toFixed(1)}: ${parts.join(', ')}`;

  return { score, reasoning };
}

// ==================== Exported Functions ====================

/**
 * Re-orders queued tasks by descending score using a 4-tier dependency-aware algorithm:
 *   1. Fix task bonus    (+1000 if fixForTaskId is set — preserves self-healing fast-path)
 *   2. Unblocking score  (+100 per transitively blocked task that becomes runnable)
 *   3. Manual priority   (high=+30, medium=+20, low=+10)
 *   4. FIFO age bonus    (+min(ageMs/1000, 10) — breaks ties, favours older tasks)
 *
 * When no dependency relationships exist, output order matches the pre-existing
 * getQueuedTasks() sort (fix → priority → FIFO).
 */
export function prioritizeQueue(tasks: Task[], allTasks: Task[]): Task[] {
  if (tasks.length <= 1) return tasks;

  const reverseGraph = buildReverseDepGraph(allTasks);
  const allTasksMap = new Map<string, Task>(allTasks.map(t => [t.id, t]));

  const scored = tasks.map(task => {
    const unblockingPotential = countTransitivelyUnblocked(task.id, reverseGraph, allTasksMap);
    const { score, reasoning } = scoreTask(task, unblockingPotential);
    return { task, score, reasoning };
  });

  scored.sort((a, b) => b.score - a.score);

  const originalOrder = tasks.map(t => t.id).join(', ');
  const newOrder = scored.map(e => e.task.id).join(', ');
  if (originalOrder !== newOrder) {
    console.log(`[Prioritizer] Reordered queue: [${newOrder}] (was [${originalOrder}])`);
  }

  return scored.map(e => e.task);
}

/**
 * Returns a QueueAnalysisEntry for each queued task with taskId, score,
 * unblockingPotential, and reasoning. Does not mutate or reorder the input list.
 * Useful for observability and debugging of queue ordering decisions.
 */
export function getQueueAnalysis(tasks: Task[], allTasks: Task[]): QueueAnalysisEntry[] {
  const reverseGraph = buildReverseDepGraph(allTasks);
  const allTasksMap = new Map<string, Task>(allTasks.map(t => [t.id, t]));

  return tasks.map(task => {
    const unblockingPotential = countTransitivelyUnblocked(task.id, reverseGraph, allTasksMap);
    const { score, reasoning } = scoreTask(task, unblockingPotential);
    return { taskId: task.id, score, unblockingPotential, reasoning };
  });
}
