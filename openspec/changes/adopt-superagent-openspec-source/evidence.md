# 验收证据 — adopt-superagent-openspec-source

> `review.md` 的四节是机器可读约定，证据一律写在这里（task 28 明确要求）。

## 本机门禁记录（2026-11-01）

环境：macOS 25.6.0 / Node v24.11.0 / pnpm 10.33.2；
宿主内核 `@deepseek-ai/dsh-tools 0.2.1-rc.2`（`--profile web` 实装）。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（host / client / packages 三个 program） |
| `pnpm test` | 90 个文件 / 788 条用例全部通过 |
| `pnpm build` | 通过；子包产物 `packages/superagent-source/dist/source-watch.js` 35.2kb |
| `pnpm verify` | 六条门禁全绿：contract / toolchain / host-compat / client-gate / source-gate / test-integrity |
| `pnpm test:toolchain` | 59 条通过（含 `rollback-superagent.test.mjs` 16 条、`verify-source-install.test.mjs` 8 条） |

`verify:source` 原话：

```
[source-gate] ok — name=workmate-superagent-source, inject=[orchestrator], apply 在无 orchestrator 时保持不活动
```

`verify:test` 原话：

```
[test-integrity] ok — 90 个测试文件全部执行，788 条通过，0 skip / 0 todo（仓库发现全集 90，与 include 无关）
```

## `verify-source-install.mjs` 三种夹具（task 27）

夹具用真实宿主 profile，不是 mock：

**① 正常安装**（临时 profile `wm-source-check`，用 `dsh plugin add` 装子包）：

```
[ ok ] 包已安装且版本可读            workmate-superagent-source@0.1.0
[ ok ] bundle 已加入 dsh.profile.bundles
[ ok ] bundle patch 恰好一条 entry    ./cordis.patch.yml 有 1 条 entry
[ ok ] 来源出现在 --dump-config-schema 且可装载
       条目 workmate-superagent-source status=absent（预期：无插件级 Config，配置属于 Source 实例）
结论：来源可被宿主装载。   exit=0
```

`status=absent` 的语义来自宿主 `config-schema/collect.ts:192-214`：模块 import 成功但没有
profile 级 Config。本包的全部配置属于 Source 实例（存 Super-agent 自己的库），所以这是
预期值；`error` / `unsupported` 才是故障。

**② 已装未启用**（把包名从 `dsh.profile.bundles` 移除，其余不变）：

```
[ ok ] 包已安装且版本可读
[FAIL] bundle 已加入 dsh.profile.bundles   bundles 不含 workmate-superagent-source
[ ok ] bundle patch 恰好一条 entry
[FAIL] 来源出现在 --dump-config-schema 且可装载
       --dump-config-schema 里没有 workmate-superagent-source（先确认已装且已进 bundles）
结论：上面 FAIL 的项不修好，这个来源不会工作。   exit=1
```

**③ 未安装**（本机 `web` profile，从未装过子包）：

```
[FAIL] 包已安装且版本可读        未安装：.../node_modules/workmate-superagent-source 不存在
[FAIL] bundle 已加入 dsh.profile.bundles
[FAIL] bundle patch 恰好一条 entry   package.json 未声明 dsh.bundle.patch
[FAIL] 来源出现在 --dump-config-schema 且可装载
结论：上面 FAIL 的项不修好，这个来源不会工作。   exit=1
```

`--dump-config` 侧的证据（正常安装夹具）：`- id: workmate-superagent-source` /
`name: workmate-superagent-source` 出现在 profile 组合树里，且**没有**手工编辑过
`dsh.profile.bundles` —— 由 `dsh plugin add` 自动写入，符合「装即启用」。

## `workmate_team_run` 在 superagent 下的 disabled 结论

`src/features/team/tools.test.ts` 6 条全通过，其中两条直接覆盖：

- `workmate_team_run` 抛出的拒绝文案包含 `taskExecutor`（引导显式设 `team`）；
- `workmate_team_plan(start=true)` 返回 `dispatch: { disabled: true, reason }`，不派发。

## 回滚演练（task 22，真实 git 夹具）

临时仓库 `drill`：`.workmates/workmate-drill-aaaaaaaaaaaa`（分支
`workmate/drill-aaaaaaaaaaaa`）+ `ports.json` 键 `drill-prop--drill--task-drill-1`。

```
WorkMate × Super-agent 回滚
· task-drill-1（drill-prop · drill）
  目录      /tmp/.../.workmates/workmate-drill-aaaaaaaaaaaa [cached]
  worktree  已移除
  分支      workmate/drill-aaaaaaaaaaaa — 已删除
  端口      已释放 drill-prop--drill--task-drill-1
结论：目录与分支已按预期处理。   exit=0
```

执行后：`git worktree list` 只剩主检出，`git branch` 只剩 `main`，`ports.json` 为 `{}`。
演练过程中发现并修正一个真实问题：分支名不能只按目录末段推导（目录带 `workmate-` 前缀
时会拼出双前缀），已改为「提案 target 的 `featureBranch` → 默认命名 → 去前缀命名」三级候选。

## 真机验收（2026-11-01，task 28 已执行部分）

环境：Super-agent 原型在本机构建（`pnpm install && pnpm build`，`lib/` 产物就绪）；
两个临时 profile：

- `sa-accept`：`@deepseek-ai/dsh-base` + `dsh-web-app` + `dsh-superagent`（GitHub /
  Feishu Source 均 `disabled`）+ `workmate-superagent-source`，web 3092
- `wm-accept`：`dsh-base` + `dsh-web-app` + `workmate4dsh`，web 3093，
  `taskFile` 与 `taskExecutor: superagent`、`superagentEndpoint: http://127.0.0.1:3092`

共用一个任务文件 `~/.dsh/state/sa-accept/workmate/tasks.json`。

### A. 安装与装载 ✅

```
[ ok ] 包已安装且版本可读            workmate-superagent-source@0.1.0
[ ok ] bundle 已加入 dsh.profile.bundles
[ ok ] bundle patch 恰好一条 entry    ./cordis.patch.yml 有 1 条 entry
[ ok ] 来源出现在 --dump-config-schema 且可装载
       条目 workmate-superagent-source status=absent（预期：无插件级 Config）
```

宿主 `GET /orchestrator/api/sources` 返回来源条目，含 `fields` 全部配置项与
`title`/`description` 的 zh/en——说明 kind 被真实注册，不只是模块能 import。

### B. `interactive=false` 首跑 ✅

```
health: {"name":"workmate","state":"ready","detail":"只读：1 条可投递"}
stats: {"received":0,...}
```

任务文件里已有一条 `assigned=true` 的待办，Source 读到了（"1 条可投递"），但
`received: 0` —— **只读模式不产生 Trigger**，与 spec 一致。

### C. `interactive=true` 后的投递与 Thread ✅（前两阶段）

```
health: {"state":"ready","detail":"投递 1"}
stats:  {"received":1,"lastAt":"2026-11-01T18:50:34.953Z"}

GET threads/workmate:task-accept-1 →
{"key":"workmate:task-accept-1","source":"workmate",
 "stage":"queued","latest":{"actor":{"source":"workmate","id":"workmate:panel"},
 "human":true,...},"pending":1}
```

- Thread key、actor 身份（`workmate:panel`）、`human: true` 全部符合设计 D9b；
- 面板同一时刻显示 `substate=submitted`（"已投递，等待接受"），**没有**说"已开工"；
- 第二阶段之后（Eval → Ticket）需要真实 GitHub 仓库 + 已登录的 `gh`，本机
  `gh auth login` 未完成，故 C 的后四个阶段（working/person/ended）**未执行**。

### D. worktree 与执行环境 —— 未执行

`prepare` 只在产生 Ticket 后跑；没有 Ticket 就没有目录。等待一个配好 GitHub 的实例。

### E. Channel 端到端（部分）✅

面板"回答"一次 → `inputs.jsonl` 追加一行 →

```
{"seq":1,"taskId":"task-accept-1","text":"补充：只改 README 第 1 行，别动其它文件",
 "by":"workmate:panel","at":"2026-11-01T18:51:38.385Z"}
```

同一 Thread 上出现第二条 `human: true` 的 Trigger（`received` 由 1 变 2，
重复扫描后保持 2 —— 游标幂等成立）。`tasks.jsonl` 未生成：没有 Ticket 就没有
Channel 送达，符合"不镜像执行状态"。

### F. 四档宽度布局 ✅（真机截图，见 `docs/assets/ui/`）

| 宽度 | 结果 | 证据 |
| --- | --- | --- |
| 1440 | 四列铺满，无横向滚动条 | `task-view-1440.png` |
| 1180 | 四列，详情抽屉与看板并排不挤压 | `task-view-1180.png` / `task-drawer-1180.png` |
| 760 | **四列仍成立**（每列约 170px，标题两行截断） | `task-view-760.png` |
| 320 | 单列纵向堆叠，头部换行不裁剪 | `task-view-320.png` |

320 首测暴露两个真实缺陷并已修：头部不换行导致视图切换被裁出屏幕、提案计数被压成
竖排；760 原先降到两列且标题不截断（验收表要求四列）。修复：`@media (max-width:720px)`
头部换行 + 工具条横向滚动，列数断点下调到 640/460，`.wm-task-title` 两行 clamp。

### G. 回退演练 —— 未在真机执行（脚本演练见上一节）

### H. 离线与失败态（部分）✅

停掉 Super-agent 进程后：

```
health: {"online":false,"endpoint":"http://127.0.0.1:3092","reason":"fetch failed"}
notes:  ["执行器离线：fetch failed"]
card:   working / unknown / "fetch failed"
```

面板给出"执行器离线 · fetch failed"红字与"待办仍可记录，恢复后由 Source 扫描投递"，
**没有**显示"已投递"（见 `task-view-offline-1180.png`）。坏 `tasks.json` 的路径由
`TaskStoreCorruptError` 与回滚脚本的退出码 2 覆盖（单测）。

### 真机发现并修复的两个 bug

1. **健康报告全部丢失**：`apply` 先 `orchestrator.context()` 再 `sources.register()`。
   宿主的 `SourceContext.report` 在 context 构造时就把 `kind.health` 解析成句柄表
   （`source-context.ts:34`），注册前取到的是空表 → 所有 `report()` 静默 no-op，
   来源健康永远停在注册时的 `starting`。改为先注册、再取 context，并在 dispose 时
   反注册（`index.ts`）。单测的假 context 原先不校验这段顺序，已改为"未 claim 的
   条目丢弃 report"，补两条回归用例。
2. **状态键用了 Symbol**：宿主把 `state` 的 key 直接绑给 SQLite TEXT 列
   （`store.ts:164-171`），Symbol 在运行期报
   `Provided value cannot be bound to SQLite parameter 1`。改成
   `workmate-source:cursor` / `workmate-source:tickets` 字符串键，契约里把
   `state.get/set` 收紧成 `string`。

## 引擎级端到端演练（2026-11-01，本机无 GitHub 凭据时的替代路径）

`gh auth login` 未完成、也没有可写的 GitHub 仓库，因此 C 的后四个阶段、D、E、G
在**真机（DSH worker 会话 + GitHub PR 绑定）**上无法执行。这些环节本身并不依赖
GitHub——它们只依赖 Super-agent 的 `Engine` 与本仓库的代码，所以另做了一次**进程内
引擎级演练**，用的是真代码而不是替身：

```bash
node --experimental-transform-types scripts/verify-superagent-offline.mjs \
     --superagent ../dsh-superagent-prototype      # 或 pnpm verify:drill
```

参与的真实组件：

| 组件 | 来源 |
| --- | --- |
| `Engine` / `MemoryRepositories` / `ticketStage` | Super-agent 构建产物 `lib/index.js` |
| 门禁 `settingsPolicy` | Super-agent **源码** `src/policy.ts`（`--experimental-transform-types` 直载） |
| `scanOnce` / `buildTaskTrigger` / `buildInputTrigger` | 本仓库 `packages/superagent-source/src/watch.ts` |
| `createChannel` / `readResults` / `appendResult` / `compactResults` | 同上 `files.ts`、`channel.ts` |
| `PREPARE_SNIPPET` / `environmentValues` | 同上 `environment.ts` |
| `projectTask`（面板四列投影） | 本仓库 `src/features/superagent/project.ts` |
| `reclaimOne` / `PortAllocator` / `planTaskPorts` | 本仓库 `src/features/task/`、`worktree/` |
| git 仓库、worktree、分支、`.env` | 真实文件系统上的真实 git |

只有两处是脚本扮演的，输出的每一行都标了对应真机触发点：worker 的
`engine.report(...)`（真机由 DSH worker 会话调用）、打开/关闭 PR 线程（真机由 GitHub
Source 的 `bindThread` / `threadClosed` 调用）。

### 演练结果（`exit=0`，31 项断言全过）

```
## C.1 扫描 → Trigger → 真实门禁
  ✔ scanOnce 投递 1 条待办 — submitted=task-drill-1
  ✔ 真实门禁判为 explicit — strength=explicit
  ✔ 门禁 basis 记录来源与名单 — via=addressed sender=workmate:panel

## C.2 accept → Ticket → working/queued
  ✔ decision 建出 Ticket — ticketId=9bdb818370e3a2caa5c31e164f9effba
  ✔ 面板投影 = 执行中/排队中 — working/queued
  ✔ ack 经真实 Channel 写入 tasks.jsonl — rows=1
  ✔ messageId 是 32 位十六进制（Super-agent 的 key 格式）

## C.3 assignmentStarted → working
  ✔ 面板投影 = 执行中/执行中 — working/working

## D. 真实 prepare 建 worktree
  ✔ prepare 前目录不存在（重要：预先存在会让 prepare 被跳过）
  ✔ 仓库里恰好两个 worktree（主检出 + 该 Ticket）
  ✔ 目录已注册为本仓 worktree
  ✔ 分支 = workmate/<Ticket 短名> — workmate/readme-line-9bdb818370e3
  ✔ .env 写入 WORKMATE_PORT / WORKMATE_PORTS
  ✔ _TASK / _BASE_BRANCH / _PORTS 来自 meta；_COPY 来自实例配置

## C.4 person/answer → 回答 → 继续
  ✔ 面板投影 = 需要我/待回答，且带出提问原文
  ✔ 回答被接收（stored）并进入 Ticket 的 undelivered
  ✔ answer 回复经 Channel 送达；tasks.jsonl 出现 reply 行

## C.5 person/review → ended/merged
  ✔ 面板投影 = 需要我/待验收（Ticket 尚未结束，等 PR 线程关闭）
  ✔ 线程合并后 Ticket 以 merged 结束
  ✔ 面板投影 = 已完成/已合并 — done/merged

## E. Channel
  ✔ result 回复在 Ticket 结束后仍可送达
  ✔ 待办被删除后 Channel 返回 gone（不再重试）
  ✔ 压缩删除了行（3 → 7，上限 6 + 保留的 ack/结果），保留至少一条 ack

## G. 回收
  ✔ 回收成功；目录已移除；git worktree list 只剩主检出
  ✔ 分支已删除；端口已释放
```

演练过程中发现并修掉的两处脚本建模错误（不是产品缺陷，记录在案）：
`inputsRead` 必须被调用，否则 Ticket 永远"有未读完的输入"、PR 关闭也不会结束；
`compactResults` 在 `maxRowsPerTask` 之外还会保留 ack 与最后一条结果，行数上限是
`max+2` 而不是 `max`。

### policy 分片的真机验证（2026-11-01）

补完之后把它装进一个真实的 Super-agent profile（3094）验证，不只是单测：

```jsonc
// GET /orchestrator/api/settings → sources[workmate].policy
{"fields":[{"key":"allowed","type":"rows", …}],
 "explicit":{"zh":"名单里的创建者在任务文件里建的待办，就是对本来源的明确请求。", …},
 "rows":[{"id":"tasks","cells":{"listedUnaddressed":false,"unlistedAddressed":true,"unlistedUnaddressed":false}}]}
```

保存与拒绝都符合预期：

```
PUT settings/policy {"sources":{"workmate":{"allowed":[{"id":"workmate:panel"}]}}}
→ {"saved":true,"revision":1,"policy_changed":true}，回读 value 里确有该条 allowed

PUT（多一个 acceptedRule 键）→ 400 Unrecognized key: "acceptedRule"
PUT（allowed 写成字符串）    → 400 sources.workmate.allowed … expected array
```

也就是说"配置里没有接受规则开关、不能靠改配置绕过授权"这条不只是写在文档里，
在真机上也会被拒绝。

### 顺带补齐的一个规格缺口

演练前审规格发现 `policy` 分片（`superagent-source` 的「执行环境变量与策略」要求
"该 kind SHALL 实现 `policy`（`allowed` + `admission` 表）"）**没有实现**——`kind.ts`
只在注释里说过"不做接受规则"。已补：`policySchema`（`allowed` 列表，strict）、
`POLICY_FIELDS`、`POLICY_EXPLICIT`、`policyRows`（单行准入表，只放行
`unlistedAddressed`），并在 `index.ts` 的 kind 上挂载；`kind.test.ts` 与
`index.test.ts` 各补用例（默认 `allowed: []` 即默认拒绝）。

### 仍然只能在真机执行的项

| 项 | 为什么只能在真机 |
| --- | --- |
| C 阶段的 worker 真实执行 | 需要 DSH worker 会话真的写代码；演练只是模拟 `report()` |
| PR 归属与合并 | 需要 GitHub Source 轮询 + agent 账号开 PR |
| `DSH_SUPERAGENT_*` 在 worker 进程内可见 | 演练只验证了 `environmentValues()` 的返回值 |
| 面板 ↔ Super-agent Execution 页逐阶段对照 | 需要两侧真实运行并截图 |

执行方式与勾选表见 `docs/SUPERAGENT-ACCEPTANCE.md`；准备好 GitHub 账号后按该表逐条走完，
把结果补进本节即可。

## 未执行项（需要配好 GitHub 的真实实例）

- [x] ~~C 的 working / person / ended 四个阶段~~ → 引擎级演练已覆盖（真机 worker 执行仍待补）
- [x] ~~D worktree 目录、分支、`.env` 端口~~ → 引擎级演练已用真实 git 覆盖
- [x] ~~E 的 `tasks.jsonl` 送达记录、`gone`、行压缩~~ → 引擎级演练已覆盖
- [x] ~~G 真机回退~~ → 引擎级演练覆盖了 `reclaimOne`（真实 worktree/分支/端口）
- [x] ~~H 的"卸掉子包后面板不崩"~~ → 见「离线与失败态」一节的 `unknown` 投影与单测
- [ ] C 的 worker 真实执行 + PR 绑定（需 GitHub）
- [ ] 面板 ↔ Execution 页逐阶段对照截图（需两侧真实运行）
- [ ] `gh auth login` 后的完整真机流程（task 28 的原始定义）
