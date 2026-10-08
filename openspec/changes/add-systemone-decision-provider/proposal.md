# 本机 System One 判断模型接入（Jev 占位落地）

## Why

<!-- 为什么做这个变更（提案 add-systemone-decision-provider 由 WorkMate 创建） -->

判断层（M16）预留的 `jev` provider 至今是接口占位；README 与 openspec 都写明"只需实现一个 DecisionProvider 适配器（POST /v1/systemone，state + 类型化题目 → 选项概率）"。本机 Ollama 0.40.0 原生实现了 TypeSafe Jev 的 System One API，因此不需要云端 key 就能把这条路径落地。

现场证据（2026-10-08 实测）：
- GET http://127.0.0.1:11434/v1/systemone → 405，Allow: POST；改 POST 后通过参数校验（questions 1–64 字段、type ∈ choice|noul|score、choice/score criteria 2–26 项）。
- clef-flash（9.5B / mxfp8 / 11.5 GiB 权重）在本机 MacBookPro18,3（M1 Pro / 16 GiB）加载失败：model requires 11.5 GiB but only 11.3 GiB are available (after 512.0 MiB overhead)。该 512 MiB 是 MLX 固定保留，OLLAMA_GPU_OVERHEAD 实测无效；真实天花板是 Metal 工作集上限 11.8 GiB（iogpu.wired_limit_mb=0 → 自动约 75%），与系统空闲内存无关 → clef-flash 在默认配置下不可用。
- 落地模型改用 nimble 9B（8.87 GiB，Ollama 官方公开基准 75.7%，Jev 1.13 为 76.0%，choice 81.6/82.9、boolean 80.2/84.6、score 54.6/50.1）。

## 来源 / Provenance

- source: `spec`
- 外部参考（只作参考，不是代码事实）：
  - Ollama System One API：https://docs.ollama.com/api/systemone
  - Ollama Decision 能力与题型表：https://docs.ollama.com/capabilities/decision
  - nimble 模型卡（基准数字与注意事项）：https://ollama.com/library/nimble

### intent 形状

- **Problem**：判断层的 `jev` provider 只有名字没有实现（`src/features/decision/types.ts:72` 声明枚举，仓库内无任何 HTTP 适配器）。因此 M30 之后全部判断节点仍走 `agent`（宿主 LLM）：每次判断是一次秒级、按量计费的模型往返，且依赖宿主 provider 可用。本机已有等价的本地判断端点却没有接上。
- **Proposed outcome**：实现 `jev` provider = configurable baseUrl 的 TypeSafe System One 客户端（默认云 Jev，本机指向 Ollama）。判断链变为 `jev → agent → rules`；阈值、动作、留痕、缓存、降级纪律**一行不改**。
- **Affected users and systems**：判断层 7 个节点（`decision-consistency` / `risk-tier` / `review-severity` / `injection-risk` / `task-satisfied` / `module-match` / `search-rerank`）；`Config`（新增字段）；本机 `~/.dsh/profiles/web/cordis.patch.yml`。
- **Constraints**：
  - 本机 Metal 工作集上限 11.8 GiB → 判断模型权重必须 ≤ ~11.3 GiB（留 MLX 0.5 GiB 保留）。
  - 判断层"只收紧不放松"（`openspec/specs/decision-layer/spec.md:39`）——本机模型不得进入 merging/archiving 放行路径。
  - 动作永远由 `DecisionService` 按阈值算，provider 只给选项与概率（`src/features/decision/service.ts:159`）。
  - 不引入新运行时依赖（Node 内置 fetch 足够）。
- **Open questions**（见 design 的对应决策）：
  1. 阈值 0.8/0.6 是给 `agent` 多采样一致率调的，换成校准概率后是否需要重标？（D7）
  2. 复用既有 `wikiVaultOllamaUrl` 还是新增独立 URL 字段？（D2）
  3. `keep_alive` 取多少，才不至于让 8.87 GiB 常驻与本机 16 GiB 的日常负载打架？（D8）

## What Changes

1. **新 provider**：`src/features/decision/systemone.ts` —— 实现 `DecisionProvider`，把 `{node, state, question, options}` 映射为 `POST {baseUrl}/v1/systemone` 的单题请求，把响应概率映射回 `DecisionAnswer`。
2. **Config**：新增 `decisionSystemoneUrl` / `decisionSystemoneModel` / `decisionSystemoneKeepAlive`（interface 与运行时 Schemastery schema 两份都要，缺运行时导出就没有校验与配置界面）。
3. **接线**：`src/index.ts:134` 的 provider 数组加入新实例；**并修 `src/index.ts:138`** —— 当前白名单是 `resolved.decisionProvider === 'rules' || === 'jev' ? … : 'agent'`，任何其它值会被静默吞成 `agent`。本变更保持 `jev` 名字，所以这一行**不用改**，但必须作为回归点确认（D1 的另一条理由）。
4. **规格**：`decision-layer` 的 provider 要求从"`jev`（接口占位，未配置即不可用）"改成"`jev`（TypeSafe System One 客户端，baseUrl 可配：云或本机 Ollama）"。
5. **测试**：映射（choice/noul 两种题型）、枚举外答案视为无结论、非 2xx、超时/abort、响应缺字段与非法 JSON。
6. **前置：主干可配**（本仓库落地的必要条件，见 design D11）——新增 `Config.lifecycleMainBranch`（默认 `'main'`，本机配 `'feat/workmate'`），替换 `src/features/archive/service.ts:327`/`:353` 的 `'main'` 字面量并透传给 `worktree.create`。不加这一项，`implementing` 会用 `git worktree add -b feature/<id> <path> main` 从**过期的 main**（Helmsman 存档线）起分支，`archiving` 的 `isMergedInto(…, 'main')` 也永远不满足——本提案走不完自己的生命周期。

## Impact

- **受影响符号**：`DecisionProvider`（新增一个实现，接口不变）、`DecisionAnswer`（复用）、`Config`（新增字段）、`DecisionConfig.provider`（枚举不变）；另加 `LifecycleServiceImpl` 的主干支来源（`src/features/archive/service.ts:327/353`）——这是让本提案能在 `feat/workmate` 上走完流程的前置。
- **不改的 git 语义**：`WorktreeManager` 的 `mainBranch` 默认值仍是 `'main'`（只新增透传），所以未配置该字段的其它项目行为完全不变。
- **不改的**：`DecisionService.decide/chain/toOutcome`、`DecisionCache`（缓存键已含 `route.provider`，见 `src/features/decision/cache.ts:35`，切 provider 不会污染旧缓存）、全部门禁语义。
- **消费方（静态阅读，逐处已核）**：`src/index.ts:134`（构造）、`src/index.ts:209`（归档 decide 钩子）、`src/index.ts:268`（search-rerank）、`src/index.ts:384`（module-match）、`src/index.ts:1103`（risk-tier）、`src/api.ts:416`（injection-risk）、`src/features/archive/orchestrate.ts:86`（review-severity）。它们只调 `decision.decide()`，**一行不改**。
- **知识查询不可用**：`workmate_knowledge_query(impact, DecisionProvider)` 返回 `note: VECTOR extension unavailable`，且 `.gitnexus/` 索引时间戳为 2026-09-19（落后于 10-07 的 M30 提交）→ 上述消费方清单**基于静态阅读**（grep `decision.decide` + 逐文件读源码），已在每条给出 文件:行。审查阶段若索引重建，应重跑 upstream impact 复核。
- **机器约束（运维面）**：本机落地模型为 `nimble`；`clef-flash` 在 16 GiB / 默认 `iogpu.wired_limit_mb` 下不可用（证据见 Why）。这条不是代码问题，但必须写进文档，否则下一个使用者会重踩。
- **回滚**：`decisionProvider` 改回 `agent` 即可恢复原状（provider 链与缓存按 provider 名隔离）；删除新增文件与配置字段即完全还原。无数据迁移、无破坏性变更。

## Wiki 关联（本提案 ↔ 项目 wiki）

这张脸有**两套**机制，实际状态如下（2026-10-08 核实，非推测）：

| 机制 | 实现 | 本提案 |
|---|---|---|
| **vault 导出** | `workmate_wiki_export` → `WorkMate/dsh-Helmsman/iterations/<id>.md` + `index.md` + `changelog.md`；`depends_on` 来自 `relatesTo`，`supersedes` 来自决策的 `supersedes`（`src/features/wiki/vault.ts:89`） | **已建立**：已导出，本提案出现在迭代索引与 changelog 中；声明 `relatesTo: add-decision-layer` → wiki 里一条真实的 `depends_on` 边 |
| **`wikiLinks` + merging 门** | tasks.md 声明 `<!-- wiki: true; type: … -->` → `implementing→merging` 前必须被 `workmate_wiki_link` 登记的页面类型覆盖（`src/features/archive/service.ts:340`） | **不声明**，理由见下 |

**为什么不声明 `wiki: true`（证据，不是偏好）**：

- 本仓库 69 个归档提案中，声明数 **0**、`wiki.md` 产物数 **0** —— 这道门在本仓库从未被使用过。
- 门的实现仍是 **WeKnora 形状**（`src/features/wiki/links.ts:1` 的注释、`src/features/archive/service.ts:346` 的用户提示都是 WeKnora 措辞），而 2026-10-07 已决策**放弃 WeKnora**、知识面改为本地 vault。
- 门是 **`type` 级覆盖**：`technical` 要求同时登记 `concept` 与 `synthesis` 两种页面类型。而本项目当前 **`modules: 0`**（`.gitnexus/wiki/` 不存在）——没有任何 `concept` 语义的笔记可以诚实指向；硬满足等于登记假 URL，比不声明更糟。
- merging 门**不可 force 跳过**，所以声明它等于给自己上一道当时无法诚实完成的闸。

若要让这道门真正接上 vault（把 `wikiLinks` 的 `pageType` 语义从 WeKnora 页类改绑到 vault 笔记类），那是**另一个变更**，不在本提案范围内。

**当前短板（如实记录，不粉饰）**：

- 迭代笔记只带 `depends_on`/`supersedes`，**不带决策依据**：本提案刚落下的 5 条方向性决策在 wiki 里看不到。
- `modules: 0`：本项目没有模块层，迭代笔记无法链接到受影响模块，导出结果 `classify.unanswered = 70`。
