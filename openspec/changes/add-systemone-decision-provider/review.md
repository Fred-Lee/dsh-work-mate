# Review — 本机 System One 判断模型接入（Jev 占位落地）

<!-- reviewer: proposal-auditor@session -->
> 审查对象：`openspec/changes/add-systemone-decision-provider`（实现提交 `533d5f6` + 验收脚本 `e3979dc`，见 `cef52d4` 的 7/9 勾选）。
> 审查方式：静态阅读 + **真机量测**（本机 Ollama 0.40.0 `/v1/systemone`，模型 `nimble` 9B qwen3_5 mxfp8，`num_ctx 8192`、`temperature 0`）+
> 失败链路证伪实验（本地 HTTP 服务端造"响应头已到、body 不结束"）+ 有效载荷边界探针（60 000 / 65 000 / 65 536 B）。
> **GitNexus 知识查询不可用**（`workmate_knowledge_query` 报 `VECTOR extension unavailable`），
> 消费方清单为静态 grep 结果，非图谱交叉验证；此降级如实标注，不冒充图谱结论。
> 下文 `疑问项` / `建议补充项` / `范围外发现` / `未验证项` 的开放条目**刻意带严重度标签**（`HIGH-n`/`MED-n`/`LOW-n`）：
> 未打标签的条目会被判断层的 `review-severity` 节点重新归级，可能把一条已知非阻断发现判成 `CRIT` 而误锁归档门。
> 带标签即声明严重度，属该解析器的正常形态（`src/features/quality/review-parser.ts:67`）。
> 本变更的阻断集为默认 `['CRIT']`（`src/config.ts:253`，profile 未覆盖），故下列 `HIGH`/`MED`/`LOW` 均不阻断归档。

## 确认项

- [x] 确认：任务 1 规格增量落地 — `specs/decision-layer/spec.md:11-13` 写明 `certainty` 取所选选项概率
  （`choice` → `max(probabilities)`、`noul` → `max(noul, 1 - noul)`）并 `SHALL NOT 使用 confidence`；
  `:15-16` 写明超预算即无结论、`SHALL NOT` 静默截断；6 个 Scenario 覆盖 `:18-48`。
  逐条比对本变更 6 条 `SHALL` 与实现，无未落地条款。
- [x] 确认：任务 2 配置面**两份同步** — interface `src/config.ts:121,123,128,134`、运行时 Schemastery
  schema `:231-234`、`CONFIG_DEFAULTS` `:290-293` 三处齐备且键名一致；`src/config.test.ts` 已断言默认值。
  缺运行时导出即无校验、无配置界面（`AGENTS.md` 插件契约），此处无该风险。
- [x] 确认：任务 3 provider 实现要点可核 — D9 上限 `src/features/decision/systemone.ts:183-194`（超限返回
  `undefined` 并留痕，无截断）；D2 `:252-255` 且 `:254` 明写"`entry.confidence` 存在且**故意不读**"；
  D4 `noul` 分支 `:226-240`；D3 `choice` 分支 `:242-265`；单选项题目在 `:108-116` 直接弃权（System One 要求 2–26 项）。
- [x] 确认：任务 4 接线与白名单 — `src/index.ts:138` 白名单为
  `provider === 'rules' || provider === 'jev' ? … : 'agent'`，`jev` **不会被吞成 `agent`**；
  providers 数组 `:146-164` 顺序为 `SystemOneProvider → AgentProvider → RulesProvider`，
  未配置时 `available()` 为 false（`systemone.ts:99-103`，仅看配置、不做启动期探测缓存，D6）。
- [x] 确认：任务 5 单测覆盖失败面 — `systemone.test.ts` 22 个用例，含 D2 的决定性用例
  `:95-107`（响应同时带 `probabilities` 与 `confidence` 时必须取选项概率）、`:130-192` 的
  未配置/枚举外/非 2xx/非法 JSON/缺字段/连接拒绝/超限/单选项/超时 九条"无结论"路径、
  `:194-265` 的链式降级与"模型答案进缓存、`rules` 答案不进缓存"。
- [x] 确认：任务 7 文档具备机器约束 — `README.md:742-784` 的 §5.9.1 含 yaml 样例（`:748-752`）、
  三条写死语义（`:759-766`）、模型可行性表（`:772-777`：`clef-flash` 11.54 GiB ❌ /
  `clef` 15.89 GiB ❌ / `nimble` 8.87 GiB ✅ / `tev1:0.8b` ✅ 仅冒烟）、以及
  "512 MiB 是 MLX 固定保留、与系统空闲内存无关"这条已证伪路径的运行提示。
- [x] 确认：任务 9 主干可配落地，且默认值未变 — `src/config.ts:92,212,277`（默认 `'main'`）、
  `src/index.ts:180` 传入 `LifecycleServiceImpl`、`service.ts:143-144` getter（`?? 'main'` 兜底保留）、
  `:341`/`:368` 的 trunk 判定、`:397` 的 `worktree.create({ … mainBranch })` 透传。
  这正是让本提案能走完自己生命周期的前置（`main` 存的是已归档的 Helmsman）。
- [x] 确认：任务 6 真机 7 节点全部有量测，且**两次独立运行逐位一致** —
  载体 `scripts/systemone-acceptance.mjs`（`:86` 显式 `timeoutMs: 120_000`），
  两次运行 choice 与 certainty 完全相同、概率逐位相同（例：`risk-tier` 0.6741195199271034 ×2、
  `search-rerank` 0.7289146753460605 ×2），符合 `temperature 0` 的确定性预期，
  说明单次量测即可复现，不是抽样噪声。

  | 节点 | choice | certainty | 首轮 latencyMs |
  |---|---|---|---|
  | decision-consistency | contradicts | 0.9975 | 18617（含冷加载） |
  | review-severity | HIGH | 0.4263 | 2051 |
  | injection-risk | risky | 0.9859 | 959 |
  | task-satisfied | unsatisfied | 0.5312 | 945 |
  | risk-tier | medium | 0.6741 | 1209 |
  | search-rerank | none | 0.7289 | 1408 |
  | module-match | decision | 0.9936 | 1189 |

- [x] 确认：**经出货的 `DecisionService` 走同一批题目**，动作落在设计预期档位 —
  `act`（decision-consistency / injection-risk / module-match）、`review`（risk-tier / search-rerank）、
  `abstain`（review-severity / task-satisfied）；provider 全程 `jev`、阈值 0.8/0.6。
  注意：这与"provider 裸调用"是两条不同的证据链，后者才是插件实际装配的那条。
- [x] 确认：**D2 有可证伪的反事实证据**（本次审查最有力的一条）— 同一 state 的真实响应里
  `probabilities` 与 `confidence` 并存，改用 `confidence` 会把 2/7 个节点的动作**整体降档**：

  | 节点 | choice | P(choice) → 动作 | `confidence` → 动作 |
  |---|---|---|---|
  | risk-tier | medium | 0.6741 → `review` | 0.2250 → `abstain` |
  | search-rerank | none | 0.7289 → `review` | 0.5656 → `abstain` |

  即"读 `confidence`"不是等价的另一种写法，而是**静默取消两次 `review` 档判断**。
  另实测 `noul` 响应根本不含该字段（`{"type":"noul","noul":0.9859363729567544}`），
  所以这条分歧只存在于 `choice` 节点上，D2 的取舍是正确的。
- [x] 确认：**D9 的上限与降级行为实测成立** — `state=60 000 B` → HTTP 200；
  `65 000 B` → HTTP 400 `prompt 0 has 8283 tokens; expected 1–8192 (input is never truncated)`；
  `65 536 B` → HTTP 413 `text and schema must not exceed 64 KiB`。
  三档都经 provider 归为"无结论"并留痕，符合"超限即弃权、不截断"。
  同时实测**生产 7 个节点的 state 只有 76–236 B**（最大 `risk-tier` 236 B），
  距上限三个数量级 —— 该守卫当前是防御性冗余，不是在用路径（见 `LOW-1`）。
- [x] 确认：`decision-consistency` 对**本提案生产的真实 state** 不构成阻断 —
  用 `src/index.ts:709-717` 的 state 构造方式（既有决策清单 + decision-7 + 理由，**不带** `supersedes`）
  回放，本机模型给 `consistent`、`P=0.9669`、动作 `act` → `src/index.ts:733` 的
  "矛盾但未声明 supersedes" 分支**不会**触发。这条同时验证了判断层在真实门禁路径上的行为，
  而不只是题目形状对得上。
- [x] 确认：归一化实验说明"省略 supersedes"不是可回避项 — 把一份明确推翻既有决策的 state
  分别以"未声明 supersedes"与"已声明 `supersedes=decision-1`"两次投喂，
  `contradicts` 概率分别为 0.9972 / 0.9975（均 `act`）：**当前题型里模型无法区分**这两者，
  所以 `src/index.ts:733` 的机械拒绝（要求调用方补 `supersedes`）是这条链上唯一的裁决点，
  判断层本身不提供该类信息。属实现现状的正确理解，非缺陷。
- [x] 确认：**切换 `decisionProvider: jev` 不会放松任何审批门** — `merging`/`archiving` 仍由
  `approvalsRequired`（`src/config.ts:273`）与 `allowAgentApproval: false`（`:274`）把守，
  `assertApproval`（`src/features/archive/service.ts:227-262`）的判据是**确定性的 `proposal.risk`
  与配置**，不读 provider、不读判断层；审查门仍按未解决 `CRIT` 计数阻断。
  与 `openspec/specs/decision-layer/spec.md:41`"判断层只收紧不放松"一致 ——
  该条是**行为要求**（不得放行门禁本会拒绝的操作），不是按 provider 名做的白名单。
- [x] 确认：验收命令全绿（真产物判定，非退出码）— `pnpm typecheck`（host + client 两个 program）无输出错误；
  `pnpm test` → `Test Files 41 passed (41)`、`Tests 363 passed (363)`；
  `pnpm verify` → `[contract] ok`、`[toolchain] ok`（host baseline 0.2.1-alpha.1）、
  `[host-compat] ok`、`[client-gate] ok — id 'workmate4dsh', apply: function, inject: array,
  externals: react, react/jsx-runtime`。
- [x] 确认：回滚路径完整 — 无状态迁移；`decisionProvider` 切回 `agent` 即回到变更前行为
  （缓存按 provider 名隔离），彻底回滚再删 `systemone.ts` 与 4 个配置键（`design.md:90-92`）。
- [x] 确认：变更面与声明一致 — `git diff --name-status feat/workmate...feature/add-systemone-decision-provider`
  恰为 9 个文件：`README.md`、`src/config.ts`、`src/config.test.ts`、`src/index.ts`、
  `src/features/decision/{systemone.ts,systemone.test.ts}`、`scripts/systemone-acceptance.mjs`、
  变更目录内的 `tasks.md` 与 `specs/decision-layer/spec.md`。**未新增运行时依赖、未触碰 `.claude/**`**，
  符合 `tasks.md:4` 的范围声明。
- [x] 确认：`HIGH-1` **已在本次审查中修复**（决策 `decision-8`）— `src/config.ts` 的
  interface 注释 / schema `description` / `CONFIG_DEFAULTS` 三处同步从 `20000` 提到 `60000`，
  provider 自身 `DEFAULTS.timeoutMs` 同步为 `60_000`（`systemone.ts:59-67`），
  `src/config.test.ts` 断言同步更新；`README.md:535` 与 §5.9.1 补上"首判会冷加载 + 本超时只覆盖响应头"的说明。
  修复后复测：卸载模型 → 用新默认 `60000` 发一次冷启动判断 → **成功返回、不再降级**（见下方 HIGH-1 处置）。
  该修复只改默认值与文案，不触碰 provider 逻辑与任何降级语义。
- [x] 确认：provider 的消费方清单完整（静态核验，GitNexus 不可用）— 全仓 `SystemOneProvider` 仅出现于
  `src/index.ts:33`（import）、`:150`（实例化）与该 provider 自身及其测试；
  `decisionSystemone*` 除 `src/config.ts` 外只在 `src/index.ts:151-154` 与 `src/config.test.ts` 出现。
  无遗漏消费方，`DecisionService` 抽象未被绕过。

## 疑问项

- [x] HIGH-1 **已修复**（原报告：`decisionSystemoneTimeoutMs` 的出厂默认 `20 000 ms` 压不住冷启动）。
  证据：`src/config.ts:234` 的字段描述写着 `Per-request timeout for the jev provider (cold model load)`，
  而 `D8`/`D5` 明确把"冷启动读约 9 GB 磁盘"作为既定代价（`design.md:69`）。
  实测 TTFB（响应头到达）**23 034 ms**；两次验收运行的首个节点为 18 617 / 21 793 ms
  （那两次用的是脚本里的 `timeoutMs: 120_000`，所以成功）。
  决定性对照：先把模型卸载（`keep_alive: 0`，`/api/ps` 确认为空），再用**出厂默认 `timeoutMs=20000`** 发一次判断
  → `ask()` 返回"无结论"，耗时 20 020 ms，诊断留痕
  `{"provider":"jev","model":"nimble","failure":"aborted after 20012ms (timeout 20000ms)"}`。
  → 冷启动 TTFB（18.6–23.5 s）**跨在 20 s 两侧**，同一台机器上首次判断时好时坏，
  失败即静默降级到 `agent`，使用者只会看到"本地模型没生效"。
  **处置（决策 `decision-8`）**：默认值提到 `60000`（`src/config.ts` 三处 + `systemone.ts:62` 的
  `DEFAULTS.timeoutMs`），`README.md:535` 与 §5.9.1 补"首判会冷加载 + 本超时只覆盖响应头"的运维提示。
  **修复后复测**：卸载模型确认 `/api/ps` 为空 → 用新默认 `60000` 发同一题 → 返回 `low`、耗时 **23 742 ms**、
  **未降级**（修复前同条件为 20 020 ms 超时降级）。两次实测夹住了 20 s 这个旧默认值。
  该修复只改默认值与文案，不触碰 provider 逻辑与任何降级语义（超时仍返回无结论）。
  > 残余风险（`LOW-11`）：修复后 23 742 ms 已用掉 60 s 预算的 40%，机器更繁忙时仍有降级可能；
  > 想彻底稳就走预热，而不是无限加大超时。
- [ ] MED-1 **超时只覆盖响应头，body 读取不受 `timeoutMs` 约束；外部 `AbortSignal` 也不生效。**
  代码事实：`timer` 在 `src/features/decision/systemone.ts:126` 设置，`finally` 在 `:146-149`
  **同一函数体内**就 `clearTimeout(timer)` 并 `removeEventListener('abort', …)`，而
  `await response.json()` 在 `:165` 才执行 —— 即超时与取消都只覆盖 `fetch` 的"拿到响应头"阶段。
  证伪实验（本地服务端先发 200 + 半截 JSON，然后**永不 `res.end()`**）：
  ① `timeoutMs=3000` 时 `ask()` **301 387 ms** 才返回"无结论"（上界由 undici 默认 `bodyTimeout` 300 s 决定，不是 `timeoutMs`）；
  ② `timeoutMs=10000` 且 t+500 ms 触发**外部 abort**（模拟 `exec.signal` / 归档编排取消）
  → 8 000 ms 观测窗内仍未返回；
  ③ 对照实验：不经 provider、直接对同一 URL 的 `fetch` 在 body 读取中途 `abort()`
  → **511 ms 抛 `AbortError`**，证明"body 阶段可被 abort 中断"是原生能力，
  ②失效是被 `:148` 移除监听所致，而非底层限制。
  影响：`decision.decide()` 的调用点包含 `workmate_assess_risk`、`workmate_proposal_decide`
  与归档编排（审查归级 / 任务判定）。本机 Ollama 若在生成中途卡死，一次归档可能被拖住约 5 分钟，
  且编排的取消信号无法脱身。修复方向：把 `clearTimeout`/`removeEventListener` 移到 body 读取与解析之后
  （或为之单独设账），并把 abort 监听保留到函数退出。属**既有实现的边界缺陷**，非本变更引入，故不阻断。
- [ ] LOW-2 **`review-severity` 在生产选项顺序下处于精确平局，只是靠字典序裁决。**
  实测同一请求连发两次（另加 6 次抽样）：`choice=HIGH`、`probabilities`
  `{CRIT 0.0397, HIGH 0.4263, MED 0.4263, LOW 0.1078}`，`HIGH` 与 `MED` **完全相等**
  （0.42628397323929507）。把 options 顺序换成 `['CRIT','MED','HIGH','LOW']` 后同一 state 给出 `choice=MED`
  （`MED 0.4647` / `HIGH 0.4101`）—— 裁决由条目顺序而非语义决定。
  缓解：该值 (0.4263) 低于 `review` 阈值 0.6 → 动作为 `abstain`（本次真机即 `abstain`），
  按 D2 不写任何事实，所以**当前无害**；但任何分布抖动都可能把它推过阈值并翻档。
  影响：`src/features/archive/orchestrate.ts:88-91` 的审查归级输入。
  修复方向：平局（差值小于某 epsilon）时返回无结论，把裁决交回确定性规则。不阻断归档。
- [ ] LOW-3 未打标签的开放审查条目在 `review-severity` 上**也不会被归级** ——
  实测该主题（"归档前未校验 writes 与工作区实际改动是否一致"）给出平局 0.4263 → `abstain`，
  而 `gradeUntaggedFindings`（`orchestrate.ts:77-106`）只消费 `action === 'act'`。
  影响：该 filter 内未打标签的开放条目对归档门是静默的（这正是本次审查给所有开放条目都打标签的原因）。
  属设计如此（不猜严重度），仅记录口径。不阻断归档。

## 建议补充项

- [ ] MED-3 **三个实现提交缺 `[proposal:<id>]` 标记，导致工件账本与漂移度量失真。**
  实测：`git log --all --grep "[proposal:add-systemone-decision-provider]"` 只命中
  `3cbc9e4`（规划）、`a263f3d`（主干前置）；而 `533d5f6`（provider 实现，8 个文件）、
  `cef52d4`、`e3979dc`（验收脚本）**均无标记**（`cef52d4` 与 `e3979dc` 本次审查时已补上，
  `533d5f6` 仍缺）。`collectProjectDrift`（`orchestrate.ts:601-608`）的 `actual` 只取标记提交
  触及的文件 → `workmate_plan_drift` 报 `driftRatio 0.4`、`undeclared: [src/config.test.ts,
  src/features/archive/trunk.test.ts]`，并把只存在于 worktree 的
  `specs/**`、`systemone.ts`、`systemone.test.ts`、`review.md`、`README.md` 一并列入 `missing`。
  即：**该漂移报告度量的是提交记号缺失，不是真的计划漂移**。
  影响：`workmate_plan_drift` 的证据可靠性；`planDriftGate` 默认 false（`src/config.ts:276`，profile 未覆盖），
  故不阻断归档。修复方向：实现提交补标记（`533d5f6` 已在主干前，可只对后续提交守纪律），
  或让度量回退到"工作区变更 vs 声明"而非只认标记提交。
- [ ] MED-4 **`tasks.md` 第 9 项引用的行号与实际落点不符。**
  第 9 项写"替换 `src/features/archive/service.ts:327`/`:353` 的 `'main'` 字面量"，
  实测这两行不是 `'main'` 字面量；真正被替换的是 `:341`/`:368` 的 `const trunk = this.mainBranch`
  与 `:397` 的 `worktree.create({ … mainBranch })`，`:144` 的 `?? 'main'` 兜底**有意保留**。
  影响：后续维护者按行号定位会找不到目标。修复方向：改成符号名引用（`this.mainBranch`）而非行号。
  不阻断归档。
- [ ] MED-5 **`README.md:783` 的"云 Jev 按部署要求配 key 即可"与实现不符。**
  证据：`systemone.ts:132` 的请求头只有 `content-type`，全文件无 `Authorization`/key/bearer；
  配置面也无凭据字段（`src/config.ts:121-134` 只有 url/model/keep_alive/timeout）。
  实测云端 `POST https://api.typesafe.ai/v1/systemone` 无凭据返回
  HTTP 403 `{"error_type":"authentication_error","message":"Must supply an API key!"}`。
  → 有鉴权的云端部署按当前实现**无法直连**，需要新增凭据透传（或由本机反代承担）。
  影响：文档承诺 > 实现能力（本机 Ollama 路径不受影响，它确实无需 key）。
  修复方向：把该行改成"云 Jev 需新增凭据透传（当前实现仅覆盖免鉴权端点）"，或明确列为后续变更。
  不阻断归档。
- [ ] LOW-4 `state=65 000 B` 的失败**不是** 64 KiB 上限而是 8 192 token 上限（HTTP 400，
  报文 `8283 tokens; expected 1–8192`）。D9 的守卫只按字节数（`DEFAULT_MAX_STATE_BYTES = 64*1024`），
  对"字节内、token 超"的输入靠服务端 400 兜住 —— 降级结果正确（无结论 + 留痕），
  但 provider 侧给出的诊断是 `http 400`，与真实原因（token 预算）在留痕里不可区分。
  建议：把 400 的响应体 `detail` 一起写进诊断（当前 `:152-159` 已截 400 字符，只需确认在文案里可读）。
  不阻断归档。
- [ ] LOW-5 `noul` 题型不返回 `confidence`（实测 `{"type":"noul","noul":0.9859363729567544}`），
  所以 D2 的分歧面只在 `choice` 节点。属实测发现的事实澄清，无需改动，建议并入 §5.9.1 的三条语义注脚。

## 未验证项（明确没验什么）

- [ ] LOW-6 **云 Jev 端点完全未验证** — 无凭据实测 403，且实现不发凭据（见 `MED-5`）。
  `README.md:748-752` 的 yaml 只覆盖本机 URL，`design.md:26` 的"云 Jev 与本机 Ollama 走同一个实现"
  在本轮**只有理论依据（官方文档"follows TypeSafe's Jev API"），无实测支持**。
- [ ] LOW-7 **未在真实 DSH harness 会话里以 `decisionProvider: jev` 跑过一次真判断。**
  本轮全部证据来自带外直接调用 provider（`scripts/systemone-acceptance.mjs`）与出货的
  `DecisionService`（`/tmp/svcrun`，provider 链手工注入）。本机 profile
  （`~/.dsh/profiles/web/cordis.patch.yml`）仍是 `decisionProvider: agent`，即**装配路径未以 jev 真跑**。
  `pnpm verify:client` 只证明装载契约，不覆盖该路径。
- [ ] LOW-8 **agent 侧对比的基线 ≠ 生产基线。** `agent` 对照用 ESP 网关 `deepseek-v4-pro`（3 采样、
  20 s 超时、强制 `answer` 工具），而插件在生产路由里首选项是 `deepseek-account`，
  诊断留痕显示该 provider 实际大量失败（`finish:error`、`ACCOUNT_SIGN_IN_REQUIRED`、`empty stream`）。
  对比结果：choice 一致 **3/7**、action 一致 **4/7**、agent 侧 21 个采样中 3 个 20 s 超时被丢弃
  （丢弃后 certainty 是"成功票的多数占比"，与出货 `AgentProvider` 的语义一致）。
  分歧集中在 `decision-consistency`（`consistent` vs `contradicts`）、`review-severity`
  （`MED` vs `HIGH`）、`task-satisfied`（`satisfied` vs `unsatisfied`，两者均 `abstain`）、
  `search-rerank`（`1` vs `none`）；一致项为 `injection-risk`、`risk-tier`（choice 同、动作 `act` vs `review`）、
  `module-match`。**该对比只能说明两套判据分布不同，不能作为任何一侧正确性的判据**，
  也不构成 D7 的阈值校准结论。
- [ ] LOW-9 **阈值未校准（D7 显式推迟）** — 0.8/0.6 是为 `agent` 多采样一致率定的，
  与本机模型校准概率分布不同（官方模型卡亦警告任一阈值需在自有数据上验证）。
  本轮未产出校准数据，`workmate_bands` 也未观察到切换后的漂移（因为尚未切换）。
- [ ] LOW-10 **wiki 模块页仍为 0。** 本机 vault 导出（`iterations: 71`、`modules: 0`、`pages: 0`）已落
  `WorkMate/dsh-Helmsman/iterations/add-systemone-decision-provider.md`，但 `modules: 0` 使
  `task 8` 里"顺带确认迭代笔记能链接到受影响模块"这一半**无从验证**（无模块页可链）。
  当前迭代笔记反映的是导出时点的状态（`status: implementing`、`提交：（无标记提交）`，
  后者与 `MED-3` 同源），归档编排第 8 步会再自动导出一次。
- [ ] LOW-11 **`HIGH-1` 的修复是缓解而非根治**（残余风险）— 修后实测冷加载 **23 742 ms**，
  已占 60 s 预算的约 40%；机器负载更高或缓存更冷时仍可能触顶降级。
  真正的根治是"首判前预热"（运维动作）或把冷加载与推理拆成两笔账（代码改动，超出本变更范围）。
  建议把"归档前先预热本机判断模型"写进运维提示，而不是继续加大超时。

## 范围外发现（本变更不修，逐条取证，供开新提案）

- [ ] MED-6 **归档后的 worktree 回收必然被拒** — `src/features/archive/service.ts:461-467` 调
  `worktree.remove({ projectRoot, proposalId })` **不传 `mainBranch`**，`manager.ts:223` 于是落回 `'main'`，
  回收守卫（`:228-230`）以"`feature/<id>` 未合入 `main`"拒绝；而 `features/archive/service.ts:397` 的
  `worktree.create` **已**正确透传（本变更任务 9 的成果之一）。实测 `git worktree list` 至今仍列出
  `/Users/fredlee/Documents/workspace/dsh-Helmsman/.workmates/fix-panel-scroll`（该提案已 archived）。
  一行修复：`remove({ … mainBranch: this.mainBranch })`。
  与 `fix-panel-scroll` 归档审查记录里的 `MED-3`（审批记录回退不清理）、`MED-4`
  （`workmate_proposal_status` 取不到已注册项目根，实测该工具对已 `archived` 提案仍返回
  `commits: []`）同属"归档收尾"一类，建议合并为一个"归档收尾健壮性"提案，
  否则本提案归档后同样会留下一个无法回收的 worktree。

> 审查结论：任务 1–5、7、9 逐条有落点、有单测；任务 6 的 7 个节点在真机上有可复现量测
> （两次运行逐位一致），且经出货 `DecisionService` 复核；D2 与 D9 各有反事实/边界实验支撑，
> **D2 的反事实证据（改用 `confidence` 会让 2/7 节点静默降档）是本次审查最强的结论**。
> 唯一的交付层阻断候选 `HIGH-1` 已在本次审查中修复（决策 `decision-8`）并复测通过，
> 故**无未解决 CRITICAL、无未解决 HIGH**，不阻断归档。
> 剩余开放项均为非阻断记录：`MED-1`（超时/取消不覆盖 body，既有实现边界缺陷）、
> `MED-3`（提交标记缺失，属流程记号，`planDriftGate` 默认关闭）、
> `MED-4`（`tasks.md` 第 9 项行号引用过时）、`MED-5`（README 的"云 Jev 配 key 即可"与实现不符）、
> `LOW-1`–`LOW-11`（证据等级与文档澄清），以及**明确未验证的三项**：云 Jev 端点、
> 真机 harness 以 `provider: jev` 装配、阈值校准（`LOW-6`–`LOW-9`）。
> 优先处理的**范围外**项是 `MED-6`：`worktree.remove` 不透传 `mainBranch`，
> 直接决定本提案归档后能否收回自己的 worktree（`fix-panel-scroll` 已实测被卡住）。
