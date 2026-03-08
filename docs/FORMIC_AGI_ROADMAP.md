# 🐜 Formic AGI 进化路线图 (Evolution Roadmap)

> **终极目标：** 将 Formic 从「人类微观管理的任务看板」升级为「目标导向、自我修复、平行运作的 AGI 研发团队」。
>
> **核心策略：** 坚持使用 CLI (Claude Code) 作为手脚，利用 Node.js/Fastify 后端作为大脑进行调度、防范错误与并发控制。

---

## 当前开发状态 (v0.6.2)

| 组件 | 状态 | 完成度 | 备注 |
|------|------|--------|------|
| 目标拆解 (Architect) | ✅ 已完成 | 100% | DAG 架构师完整实现，含 depends_on、Kahn 循环检测、阻断调度 |
| 租约管理 (Lease) | ✅ 已完成 | 80% | 档案级并发正常运作，无资料夹锁定 |
| 宣告步骤 (Declare) | ✅ 已完成 | 100% | 功能完善的档案宣告技能 |
| 看门狗 (Watchdog) | ✅ 已完成 | 90% | 监控租约、清理停滞进程、重新排队 |
| 并发执行 (Concurrent) | ✅ 已完成 | 75% | 平行任务可行，无优先级感知锁定管理 |
| 冲突检测 (Collision) | ✅ 已完成 | 85% | 透过 git hash 实现共享档案的乐观并发 |
| 队列优先化 (Prioritizer) | ✅ 已完成 | 100% | 四层评分（fix bonus + BFS 传递解锁 + 手动优先级 + FIFO 年龄）整合至 queueProcessor |
| 验证机制 (QA) | ✅ 已完成 | 100% | Safety Net + Verifier + Critic + Kill Switch 全部实现 |
| 记忆系统 (Memory) | ✅ 部分实现 | ~50% | memory.ts 完整实现（CRUD + 反思）；getRelevantMemories() 已定义但尚未注入 runner.ts |
| 相依图 (DAG) | ✅ 已完成 | 100% | dependsOn/dependsOnResolved 字段、自动解锁、dependency-resolved WebSocket 事件全部实现 |
| 验证代理 (Verifier) | ✅ 已完成 | 100% | executeVerifyStep() + Critic 重试迴圈 + Kill Switch 全部实现 |

### 已有基础

- **目标任务类型** (`type: 'goal'`): Architect 技能可将高阶目标拆解为 3-8 个子任务
- **架构师工作流** (`executeGoalWorkflow()`): 解析 `architect-output.json`，建立带有父子关联的任务
- **租约管理器** (`leaseManager.ts`): 独占/共享档案租约、原子化获取、git hash 冲突检测
- **宣告技能** (Declare Skill): 分析计划并输出 `declared-files.json`
- **看门狗** (`watchdog.ts`): 30秒轮询，清理过期租约，还原未提交变更
- **让出机制** (Yield): 租约不可用时让出任务，最高重试 50 次
- **迭代执行**: 每任务最多 5 次迭代，含停滞检测
- **安全存档** (`gitUtils.ts → createSafePoint()`): 任务执行前自动 `git add . && git commit --allow-empty`，SHA 储存于 `task.safePointCommit`
- **验证员** (`executeVerifyStep()`): 执行后运行 `VERIFY_COMMAND`，成功→review，失败→触发 Critic
- **评论家与 Kill Switch** (`executeCriticAndRetry()`): 自动建立 fix 任务（type:quick, priority:high），3 次失败后 git reset + 暂停队列 + 通知
- **修复任务优先排队** (`getQueuedTasks()` 3-tier sort): fixForTaskId 设置的任务永远排在最前
- **相依感知队列优先化** (`prioritizer.ts`): 四层评分算法自动重排 queued 任务，fix 任务 > 可解锁最多 blocked 任务者 > 手动优先级 > FIFO
- **DAG 相依性** (`dependsOn`/`dependsOnResolved`/`blocked`): 架构师输出含 depends_on，Kahn's 循环检测，blocked 任务自动解锁
- **目标输入 UI** (Objective mode): 前端独立的 🎯 Objective 输入模式，自动设定 type:'goal'
- **中断任务恢复** (`recoverStuckTasks()`): 服务器重启时自动将卡在执行中状态的任务重新排队

---

## 🟢 阶段一：自愈 QA 迴圈 (Self-Healing QA Loop)

**目标：** 让 AI 写的代码哪怕坏了，也能自己修好。这是迈向 AGI 的核心，也是最重要的第一步。

### Step 1.1: 任务前自动存档 (The Safety Net)

**现状：** ✅ 已完成 — gitUtils.ts 中 createSafePoint() 完整实作，在 workflow.ts 与 runner.ts 的 spawn 前均有呼叫。

**实作：**
- 在 `runner.ts` 呼叫 `spawn('claude')` 之前，执行 `git add .` + `git commit -m "auto-save: before task [ID]"`
- 在任务对象中记录 Commit SHA (`task.safePointCommit`)
- 此 SHA 作为任何失败情况下的清洁回滚目标

**涉及文件：**
- `src/server/services/runner.ts` — 加入执行前 git commit
- `src/types/index.ts` — 新增 `safePointCommit?: string`

### Step 1.2: 验证员机制 (The Verifier)

**现状：** ✅ 已完成 — executeVerifyStep() 在 workflow.ts 实作完整；verifying 状态已加入 TaskStatus；Verifying 看板栏已加入前端。

**实作：**
- 新增 `'verifying'` 到 `TaskStatus` 枚举
- 执行完毕后进入 `verifying` 状态而非直接进入 `review`
- 自动执行可配置的验证指令（如 `npm run build`、`npm test`）
- 解析 Exit Code 与 stdout/stderr
- 成功 → 进入 `review`；失败 → 触发 Critic (Step 1.3)
- 可透过环境变量 `SKIP_VERIFY=true` 跳过验证（开发用）

**涉及文件：**
- `src/types/index.ts` — 新增 `verifying` 状态、`verifyCommand?: string`
- `src/server/services/workflow.ts` — 新增 `executeVerifyStep()`
- `src/server/services/store.ts` — board 级验证配置
- `src/client/index.html` — 新增 Verifying 看板栏位

### Step 1.3: 评论家与重试迴圈 (The Critic)

**现状：** ✅ 已完成 — executeCriticAndRetry() 在 workflow.ts 实作完整，含 Kill Switch 机制（git reset + 队列暂停 + WebSocket + Telegram/LINE 通知）。

**实作：**
- 验证失败时撷取 Error Log（最后 100 行 stderr）
- 自动建立修复任务：`"Fix: [原始标题] — [错误摘要]"`，`type: 'quick'`，`priority: 'high'`
- 透过 `fixForTaskId` 字段连结原始任务
- 插队到队列最前端（优先级覆盖）
- 在原始任务上追踪 `retryCount`

**Kill Switch（紧急停止）：**
- 若 `retryCount >= 3`，执行 `git reset --hard <safePointCommit>`
- 暂停队列处理器
- 透过 WebSocket + Telegram/LINE 发送通知
- 需要人类介入才能恢复

**涉及文件：**
- `src/types/index.ts` — 新增 `retryCount`、`fixForTaskId`、`safePointCommit`
- `src/server/services/workflow.ts` — 验证失败后的 Critic 逻辑
- `src/server/services/queueProcessor.ts` — 修复任务的优先级覆盖、暂停机制
- `src/server/services/boardNotifier.ts` — Kill Switch 通知

---

## 🟡 阶段二：具备相依图 (DAG) 的架构师

**目标：** 架构师不仅要拆解任务，还要定义任务之间的「依赖关系」，为后续的平行处理铺路。

### Step 2.1: 高阶目标输入 (Objective Input)

**现状：** ✅ 已完成 — 🎯 Objective 模式按钮与专属输入 UI 已在 index.html 前端独立完成。

**实作：**
- 前端新增「Objective」输入模式（大文本区域），区别于普通任务创建
- 创建时自动设定 `type: 'goal'`
- 显示视觉指示器表明这将触发架构师拆解

**涉及文件：**
- `src/client/index.html` — Objective 输入 UI
- `src/client/app.js` — Goal 任务创建处理器

### Step 2.2: 具备 DAG 感知能力的提示词

**现状：** ✅ 已完成 — skills/architect/SKILL.md 已更新含 task_id/depends_on 字段；workflow.ts 含 detectDAGCycle()（Kahn's Algorithm）及循环时的扁平化回退。

**实作：**
- 更新 `skills/architect/SKILL.md` 提示词，要求输出包含 `depends_on` 字段：
  ```json
  [
    {
      "task_id": "setup-stripe",
      "title": "Set up Stripe SDK and configuration",
      "context": "...",
      "priority": "high",
      "depends_on": []
    },
    {
      "task_id": "checkout-api",
      "title": "Implement checkout API endpoints",
      "context": "...",
      "priority": "high",
      "depends_on": ["setup-stripe"]
    }
  ]
  ```
- 使用拓扑排序（Kahn's Algorithm）校验是否产生循环依赖
- 若检测到循环，退回到扁平模式并记录警告

**涉及文件：**
- `skills/architect/SKILL.md` — 更新提示词
- `src/server/services/workflow.ts` — 解析 `depends_on`、DAG 验证

### Step 2.3: DAG 生成与调度

**现状：** ✅ 已完成 — dependsOn/dependsOnResolved/blocked 全部实作于 types/store/workflow/boardNotifier；unblockSiblingTasks() 于任务完成时自动触发；dependency-resolved WebSocket 事件广播完成。

**实作：**
- 任务新增 `dependsOn: string[]` 字段和 `blocked` 状态
- 建立子任务时，将架构师输出的临时 `task_id`（如 `"setup-stripe"`）映射到实际 Formic ID（如 `"t-52"`）
- 无依赖的任务 → `queued`（READY）
- 有未满足依赖的任务 → `blocked`
- 队列处理器跳过 `blocked` 状态的任务

**解锁逻辑：**
- 当任务完成（`done`）时，扫描同一 `parentGoalId` 下的所有 `blocked` 任务
- 若某任务的所有 `dependsOn` 项目均为 `done`，将其从 `blocked` → `queued`
- 透过 WebSocket 广播 `DEPENDENCY_RESOLVED` 事件

**涉及文件：**
- `src/types/index.ts` — 新增 `dependsOn`、`blocked` 状态
- `src/server/services/store.ts` — 任务完成时的依赖解锁逻辑
- `src/server/services/queueProcessor.ts` — 跳过 blocked 任务
- `src/server/services/boardNotifier.ts` — 依赖解锁事件
- `src/client/index.html` — blocked 指示器、依赖关系显示

---

## 🟠 阶段三：工业级并发系统 (Industrial-Grade Concurrency)

**目标：** 安全的平行 Agent 执行，预防死锁 (Deadlock) 并优化资源利用。

### Step 3.1: 增强型租约系统

**现状：** ✅ 已完成 — `leaseManager.ts` 完整实现优先级抢占（`preemptLease()`）、死锁检测（`detectDeadlock()` 基于 wait-for 图 + Kahn's 循环解析）和磁盘持久化（`persistLeases()` / `.formic/leases.json`）。由任务 t-53 实现。

**已完成：**
- ~~加入租约优先级：高优先级任务可强占低优先级的资源持有者（优雅终止）~~ ✅
- ~~加入死锁检测：若 Task A 持有档案 X 并等待 Y，而 Task B 持有 Y 并等待 X~~ ✅
- ~~持久化租约到磁盘，防止服务器重启时丢失~~ ✅

**涉及文件：**
- `src/server/services/leaseManager.ts` — 优先级抢占、循环检测
- `src/server/services/watchdog.ts` — 死锁扫描

### Step 3.2: 具备让出机制的智慧 Worker 池

**现状：** ✅ 已完成 — `queueProcessor.ts` 实现 `yieldReason` 持久化（透过 `updateTask()`）、指数退避常数（`YIELD_BACKOFF_INITIAL_MS`、`YIELD_BACKOFF_MULTIPLIER`、`YIELD_BACKOFF_MAX_MS`）和 `yieldUntil` 映射。`src/types/index.ts` 包含 `yieldReason?: string`。由任务 t-54 实现。

**已完成：**
- ~~Worker 让出后立即抓取下一个 READY 且不冲突的任务（已部分实现）~~ ✅
- ~~记录让出原因用于调试 (`yieldReason`)~~ ✅
- ~~实作指数退避 (Exponential Backoff) 策略：让出次数影响重新排队延迟~~ ✅

**涉及文件：**
- `src/server/services/queueProcessor.ts` — 智慧任务选取、退避策略
- `src/types/index.ts` — `yieldReason?: string`

### Step 3.3: 事件驱动的状态广播

**现状：** ✅ 已完成 — `internalEvents.ts` 导出 `TASK_COMPLETED` 和 `LEASE_RELEASED` 常数及 `EventEmitter`。`queueProcessor.ts` 透过 `internalEvents.on(TASK_COMPLETED, wakeQueueProcessor)` 和 `internalEvents.on(LEASE_RELEASED, wakeQueueProcessor)` 订阅两个事件。`workflow.ts` 在所有任务完成路径上发送 `TASK_COMPLETED`，`leaseManager.ts` 在租约释放时发送 `LEASE_RELEASED`。由任务 t-55 实现。

**已完成：**
- ~~广播 dependency-resolved 事件~~ ✅ 已实作于 boardNotifier.ts
- ~~TASK_COMPLETED、LEASE_RELEASED 细粒度事件~~ ✅
- ~~Worker 订阅相关事件而非持续轮询~~ ✅
- ~~减少对 `QUEUE_POLL_INTERVAL` 的依赖，实现更快的反应速度~~ ✅

**涉及文件：**
- `src/server/services/boardNotifier.ts` — 事件类型与订阅机制
- `src/server/services/queueProcessor.ts` — 事件驱动唤醒

### Step 3.4: 相依感知队列优先化器 (Dependency-Aware Queue Prioritizer)

**现状：** ✅ 已完成 — `src/server/services/prioritizer.ts` 实现四层评分算法，在 `queueProcessor.ts` 的 `processQueue()` 选取任务前自动重排队列顺序。由任务 t-68 实现。

**已完成：**
- ~~四层评分算法：修复任务加权 (+1000)、传递性解锁分数 (+100 每阻断任务)、手动优先级 (high=+30, medium=+20, low=+10)、FIFO 年龄加成 (+min(ageMs/1000, 10))~~ ✅
- ~~`buildReverseDepGraph(allTasks)` — 从所有任务构建反向依赖图 (`Map<taskId, Set<dependentId>>`)~~ ✅
- ~~`countTransitivelyUnblocked(taskId, reverseGraph, allTasks)` — 用 BFS 计算完成此任务后可传递解锁的 blocked 任务数量~~ ✅
- ~~`prioritizeQueue(tasks, allTasks)` — 按分数降序重排 queued 任务，返回新数组（不修改原数组）~~ ✅
- ~~`getQueueAnalysis(tasks, allTasks)` — 返回可观测性数据（每任务的分数明细），不修改队列~~ ✅
- ~~整合至 `queueProcessor.ts` 的 `processQueue()` — 在任务选取前调用 `prioritizeQueue()`~~ ✅

**涉及文件：**
- `src/server/services/prioritizer.ts` — 四层评分引擎、反向依赖图、BFS 传递性解锁计算
- `src/server/services/queueProcessor.ts` — 在 `processQueue()` 内整合 `prioritizeQueue()`

---

## ✅ 阶段四：长期记忆与自我演进 (Memory & Evolution)

> **✅ Phase 4 完整完成 (2026-03-07)**
>
> **关键实现文件：**
> - `src/server/services/memory.ts` — 相关性评分（标签重叠 + 文件路径匹配 + 时间近度加权）
> - `src/server/services/runner.ts` — 记忆与工具上下文注入至 Agent 提示词
> - `src/server/services/tools.ts` — 新工具锻造服务（`listTools()`、`addTool()`、`validateTool()`、`incrementUsage()`）
> - `src/server/routes/tools.ts` — REST 端点 `GET /api/tools` 和 `POST /api/tools`
> - `src/types/index.ts` — 新增 `Tool` 和 `ToolStore` 类型定义

**目标：** 系统拥有记忆，不会在同一个坑踩两次；系统会自己写工具给自己用。

### Step 4.1: 记忆存储 (The Hippocampus)

**现状：** ✅ 已完成 — `src/server/services/memory.ts` 完整实现 `loadMemoryStore()`、`saveMemoryStore()`、`addMemory()`、`getMemories()`、`getRelevantMemories()`。`src/types/index.ts` 包含 `MemoryEntry` 接口和 `MemoryStore` 类型。由任务 t-56 实现。

**已完成：**
- ~~建立 `.formic/memory.json` 记忆存储~~ ✅
- ~~任务完成（`done`）后运行「反思提示词」并将输出解析为记忆条目~~ ✅
- ~~Memory CRUD 服务（`addMemory`、`getMemories`、`getRelevantMemories`）~~ ✅
- ~~`MemoryEntry` 和 `MemoryStore` 类型定义~~ ✅

### Step 4.2: 上下文注入 (Context Injection)

**现状：** ✅ 已完成 — relevance scoring implemented in `getRelevantMemories()` (tag overlap + file path matching + recency weighting); top-5 memories injected as a `## Past Experience` section into the agent prompt in `runner.ts`.

**已完成：**
- ~~执行新任务前，查询 `memory.json` 中与当前任务相关的条目（基于标签/文件匹配）~~ ✅
- ~~将相关记忆附加到 Agent 提示词中作为「过往经验」~~ ✅
- ~~按相关性排名（标签重叠 + 时间近度）~~ ✅

**涉及文件：**
- `src/server/services/memory.ts` — `getRelevantMemories(task)` 函数
- `src/server/services/runner.ts` — 注入记忆到 Agent 提示词

### Step 4.3: 工具锻造 (Tool Forging)

**现状：** ✅ 已完成 — new `src/server/services/tools.ts` service (`listTools()`, `addTool()`, `validateTool()`, `incrementUsage()`); REST API at `GET/POST /api/tools`; available tools injected as `## Available Tools` section in agent prompt; manifests persisted in `.formic/tools/tools.json`.

**已完成：**
- ~~赋予 Agent 写入 `.formic/tools/` 资料夹的权限~~ ✅
- ~~每个工具是一个脚本（bash/node）加上清单文件~~ ✅
- ~~Agent 可在后续任务中调用这些自建工具~~ ✅
- ~~追踪使用统计，识别最有价值的工具~~ ✅

**涉及文件：**
- `src/server/services/tools.ts` — 新服务：工具管理
- `src/server/routes/tools.ts` — REST 端点 `GET /api/tools` 和 `POST /api/tools`
- `src/types/index.ts` — Tool 类型定义
- `skills/execute/SKILL.md` — 通知 Agent 可用工具列表

---

## 优先级与依赖图

```
阶段 1 (自愈迴圈) ───────────────────────────────────────────┐
  Step 1.1 (自动存档) ──→ Step 1.2 (验证员) ──→ Step 1.3 (评论家)
                                                              │
阶段 2 (DAG 架构师) ─────────────────────────────────────────┤
  Step 2.1 (目标输入) ──→ Step 2.2 (DAG 提示词) ──→ Step 2.3 (DAG 调度)
                                                              │
阶段 3 (工业级并发) ──────────────────────────── depends on 阶段 2
  Step 3.1 (租约++) ──→ Step 3.2 (智慧让出) ──→ Step 3.3 (事件广播) ──→ Step 3.4 (依赖优先)
                                                              │
阶段 4 (记忆演进) ──────────────────────────── depends on 阶段 1
  Step 4.1 (记忆库) ──→ Step 4.2 (上下文注入) ──→ Step 4.3 (工具锻造)
```

**推荐顺序：** 阶段 1 → 阶段 2 → 阶段 3 → 阶段 4

阶段 1 是**最基础的防线** — 没有自愈能力，扩大并发只会加速代码崩溃。阶段 2 开启智慧平行的可能性。阶段 3 强化系统稳定性。阶段 4 让系统真正变聪明。

---

## 🧪 测试策略与评估框架 (Testing Strategy & Evaluation)

每个阶段实现后都需要对应的测试来验证 AGI 机制是否正确运作。

### 阶段一测试：QA 迴圈验证

**测试文件：** `test/test_qa_loop.py`

| 测试案例 | 验证内容 |
|----------|---------|
| Auto-Save Test | 任务执行前产生 `auto-save: before task [ID]` 的 git commit |
| Verifier Success | 在 build 成功的项目中执行任务 → 确认任务进入 `review` |
| Verifier Failure | 执行会引入语法错误的任务 → 确认触发 Critic，自动建立 `priority: high` 的修复任务 |
| Critic Retry | 模拟 3 次连续失败 → 确认执行 `git reset --hard`、队列暂停、通知发送 |
| Kill Switch Recovery | Kill Switch 触发后 → 确认工作区回到 safe point commit，队列已暂停 |

### 阶段二测试：DAG 调度验证

**测试文件：** `test/test_dag_scheduling.py`

| 测试案例 | 验证内容 |
|----------|---------|
| DAG Output | 提交有明确依赖的目标 → 确认架构师输出包含有效的 `depends_on` |
| Cycle Detection | 手动注入循环依赖 → 确认系统检测并优雅降级 |
| Sequential Blocking | 建立 A→B→C 依赖链 → 确认 B 在 A 完成后才启动，C 在 B 完成后才启动 |
| Parallel Independence | 建立 A、B（无依赖）和 C（依赖 A+B）→ 确认 A、B 平行执行，C 等待 |
| Unblock Cascade | 完成任务 A → 确认所有仅依赖 A 的任务从 `blocked` 转为 `queued` |

### 阶段三测试：并发压力测试

**测试文件：** `test/test_concurrency_advanced.py`

| 测试案例 | 验证内容 |
|----------|---------|
| Lease Priority | 高优先级任务请求被低优先级持有的档案 → 验证抢占行为 |
| Deadlock Detection | 两个任务互相需要对方的独占档案 → 验证检测与解决 |
| Yield Backoff | 任务多次让出 → 验证重试间隔递增 |
| 100-Task Stress | 排队 100 个混合依赖和共享档案的任务 → 零死锁、零资料损坏 |

**测试文件：** `test/test_prioritizer.py`

| 测试案例 | 验证内容 |
|----------|---------|
| Fix Task Bonus | 带 `fixForTaskId` 的任务得分领先 +1000，排在最前 |
| Transitive Unblocking | 完成后可解锁 N 个 blocked 任务者得分 = N × 100 |
| Manual Priority | high=+30、medium=+20、low=+10 反映在最终排序 |
| Age Bonus | 最旧任务得分 +10（上限），最新得分 +0 |
| Queue Analysis | `getQueueAnalysis()` 返回每任务分数明细，不修改队列顺序 |

### 阶段四测试：记忆系统验证

**测试文件：** `test/test_memory.py`

| 测试案例 | 验证内容 |
|----------|---------|
| Memory Creation | 完成任务 → 确认 `.formic/memory.json` 新增反思条目 |
| Memory Injection | 创建触及已有记忆条目文件的任务 → 确认记忆出现在 Agent 提示词 |
| Tool Forging | Agent 在 `.formic/tools/` 建立工具 → 确认清单有效且后续任务可用 |

### 整合测试

**测试文件：** `test/test_agi_integration.py`

| 测试案例 | 验证内容 |
|----------|---------|
| End-to-End Goal | 提交目标 → 架构师拆解 → 任务执行含 QA → 全部完成 → 记忆已保存 |
| Failure Recovery | 提交目标 → 子任务失败 → Critic 建立修复 → 修复成功 → 目标完成 |
| Concurrent Goals | 同时提交两个目标 → 无资源冲突，两者均完成 |

### 自动化评估指标

**指标收集器：** `test/agi_metrics.py`

| 指标 | 目标值 | 计算方式 |
|------|--------|---------|
| 自愈率 (Self-Healing Rate) | ≥ 80% | 3 次重试内自动恢复的失败任务占比 |
| DAG 准确率 (DAG Accuracy) | ≥ 90% | 架构师正确识别依赖关系的拆解占比 |
| 死锁率 (Deadlock Rate) | 0 | 每 100 个任务中的死锁次数 |
| 记忆效用 (Memory Utilization) | ≥ 50% 降低 | 记忆注入后重複性错误的减少率 |
| 平均完成时间 (Avg Completion) | 持续追踪 | 每阶段实现前后的任务平均完成时间 |

---

## 相关任务追踪

| Formic Task | 内容 | 类型 |
|-------------|------|------|
| Phase 1 Goal | ~~实现自愈 QA 迴圈 (Safety Net + Verifier + Critic)~~ ✅ 已完成 | `goal` |
| Phase 2 Goal | ~~实现 DAG 感知架构师 (Objective UI + DAG Prompt + Scheduler)~~ ✅ 已完成 | `goal` |
| Test Suite | 建构 AGI 进化测试套件与评估框架 (t-33, 🔄 进行中) | `standard` |
| t-53 | ~~实现增强型租约系统（优先级抢占、死锁检测、磁盘持久化）~~ ✅ 已完成 | `standard` |
| t-54 | ~~实现智慧 Worker 池（让出原因追踪、指数退避）~~ ✅ 已完成 | `standard` |
| t-55 | ~~实现事件驱动队列唤醒（TASK_COMPLETED + LEASE_RELEASED 广播）~~ ✅ 已完成 | `standard` |
| t-56 | ~~实现记忆存储服务（任务完成后反思）~~ ✅ 已完成 | `standard` |
| t-68 | ~~实现相依感知自动队列优先化器（四层评分 + BFS 传递解锁）~~ ✅ 已完成 | `standard` |
| ~~t-46~~ | ~~原始 quick 任务（范围过大，已被以上任务取代）~~ | ~~deprecated~~ |
