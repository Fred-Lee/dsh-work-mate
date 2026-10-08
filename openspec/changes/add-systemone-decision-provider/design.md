# Design — 本机 System One 判断模型接入（Jev 占位落地）

<!-- 关键决策、权衡、替代方案。非平凡变更必填。 -->
<!-- files: src/features/decision/systemone.ts, src/features/decision/types.ts, src/config.ts, src/index.ts, README.md -->

外部契约来源（Ollama 官方文档，属参考而非代码事实）：
https://docs.ollama.com/api/systemone 、 https://docs.ollama.com/capabilities/decision 、 https://ollama.com/library/nimble

## 接口同构性（本设计的前提）

| WorkMate（`src/features/decision/types.ts:23`） | System One |
|---|---|
| `state: string` | `state`（字符串，或 JSON 对象/数组） |
| `question: string`（一行） | `instructions` |
| `options: readonly string[]` | `choice.criteria`：`{选项名: 描述}`，2–26 项 |
| 二值节点 | `noul`（可选 `{"true":…,"false":…}` 描述） |
| 有序刻度节点 | `score.criteria`：字符串数组，最低在前，档位从 0 计 |
| `DecisionAnswer.choice` | `answers[<key>].choice` / `.noul` / `.score` |
| `DecisionAnswer.certainty` | **不是** `confidence`（见 D2），取选项概率 |

响应外形（官方示例，实测待第 6 项任务确认）：
`{"model":…,"answers":{"<key>":{"type":"choice","choice":…,"probabilities":{…},"confidence":…}},"usage":{"input_tokens":…,"output_tokens":…}}`

## D1 承载位置：实现 `jev`，不新增 provider 名

- **决策**：`DecisionProvider.name = 'jev'`；`DecisionConfig.provider` 枚举保持 `'agent' | 'rules' | 'jev'` 不变。baseUrl 可配，云 Jev 与本机 Ollama 走同一个实现。
- **理由**：Ollama 的 `/v1/systemone` 就是 TypeSafe Jev API 的实现（官方原文 "follows TypeSafe's Jev API"）。`README.md:738` 与 `openspec/specs/decision-layer/spec.md:9` 已把这条路径写死为"实现一个适配器即可，调用方一行不改"。新增 `systemone` 名字要同时改 spec、Config 描述与 `src/index.ts:138` 白名单三处，并把同一协议拆成两套实现。
- **替代方案**：新增 `systemone` provider 名 —— 否决（维护面翻倍；且 `src/index.ts:138` 的白名单会把未知值静默吞成 `agent`，多一个名字就多一个静默失效点）。

## D2 certainty 取选项概率，**不用** `confidence`

- **决策**：`choice` → `certainty = max(probabilities)`，`choice = argmax`；`noul` → 比较 `noul` 与 `0.5` 选边，`certainty = max(noul, 1 - noul)`。
- **理由**：Ollama 官方明确 `confidence` 是"分布的集中度"，原文 **"It isn't the chance that the answer is right"**（docs/capabilities/decision）。而 WorkMate 的 `act/review` 阈值是"该不该行动的置信度闸门"（`src/features/decision/service.ts:166`）。用 `confidence` 会让阈值判据静默换成另一种语义——正是判断层最容易"看起来在判、其实换了判据"的失效模式。名字上 `confidence` 更接近 Jev 的 `certainty`，所以这是个**必须显式写下来**的决定。
- **替代方案**：直接用 `confidence` 当 certainty —— 否决（阈值语义漂移且不可审计）。

## D3 现有 7 个节点全部映射为 `choice`，不用 `score`

- **决策**：`options` → `criteria` 对象（选项名 → 描述）；哨兵项（`none`）也作为一个候选。
- **理由**：Ollama 官方公开基准 **choice 81.6% vs score 54.6%**（score 的准确率口径是"最高档完全命中"）。WorkMate 的 options 本来就是标签枚举（`CRIT/HIGH/MED/LOW`、`low/medium/high`、`benign/risky`、模块 slug + `none`），没有连续刻度语义；用 score 还要多一步"分数 → 档位四舍五入"，引入不可审计的中间步骤。
- **替代方案**：`review-severity`/`risk-tier` 用 score 保留有序性 —— 否决（精度损失约 27pp，换来的有序性在阈值动作里用不上）。

## D4 二值节点用 `noul`

- **决策**：`injection-risk`（benign/risky）、`task-satisfied` 声明为二值节点，走 `noul`。
- **理由**：noul 直接给"true 的概率"，打分面比 choice 少一半；官方 boolean 类 80.2% 与 choice 的 81.6% 差距很小。
- **替代方案**：一律 choice —— 可接受，但实现上两种都支持、由节点表声明，成本很低。

## D5 落地模型 = `nimble` 9B；`clef-flash` 在本机不可用

- **决策**：本机 profile 配 `decisionSystemoneModel: nimble`。
- **理由**：`clef-flash` 权重 11.5 GiB + MLX 固定保留 0.5 GiB = 12.0 GiB > Metal 工作集上限 11.8 GiB（`iogpu.wired_limit_mb=0` → 自动约 75% 内存）。实测 `OLLAMA_GPU_OVERHEAD=0` 不改变那 512 MiB 保留，系统空闲内存也与之无关——**默认配置下永远加载不了**。`nimble` 8.87 GiB 可容纳，公开基准 75.7% ≈ Jev 1.13 的 76.0%。
- **替代方案**：`sudo sysctl iogpu.wired_limit_mb=13312` 硬上 clef-flash —— 否决（需要 root、16 GiB 机器只剩 ~4 GiB 给系统而 swap 已 92%，属机器运维负担而非代码问题）；`tev1:0.8b`（63.5%、约 0.6 GiB）—— 保留为**链路验证用的小模型**，不作长期判断模型。

## D6 可用性探测与降级：不设常驻健康检查

- **决策**：`available()` 返回"配置了 URL 与模型名即可用"；真正的失败（连接拒绝/超时/非 2xx/无结论）由 `ask()` 抛出或返回 `undefined`，交给现有 provider 链降级到 `agent` → `rules`，并由 `decision` 事件的 `degraded`/`reason` 留痕。
- **理由**：与 `AgentProvider.available()`（只看 `llm()` 是否存在，`src/features/decision/agent.ts:82`）同风格；判断层已有失败留痕纪律，不需要新机制。Ollama 可能在本 harness 启动之后才起来，启动期探测并缓存会永久误判。
- **替代方案**：启动期探测 + 缓存 —— 否决（陈旧可用性判定）。也不新起常驻进程（对齐 M21 的"无游离进程"教训）。

## D7 阈值首版不动，用影子期校准

- **决策**：首版沿用 `act 0.8 / review 0.6`，但把"阈值校准"列为显式后续动作：对比 `agent` 与本地模型在同一批题目上的 `choice`/`certainty` 分歧，再用 `workmate_bands` 观察切换 provider 后的漂移。
- **理由**：0.8/0.6 是为 `agent` 的多采样一致率定的（`README.md:706`），而 System One 给的是校准概率，两者分布不同。官方也警告："A probability of 0.9 doesn't mean the answer is right 90% of the time on your data. Test any threshold on your own data."（nimble 模型卡）。
- **纪律**：本机模型不参与 merging/archiving 放行（`openspec/specs/decision-layer/spec.md:39`）。

## D8 常驻内存：短 `keep_alive`，不预加载

- **决策**：请求体带可配的 `keep_alive`（首版建议 60s，待实测），不做模型预热。
- **理由**：nimble 常驻 8.87 GiB，本机 16 GiB 且 swap 已接近打满；判断节点是低频突发（一次归档最多 `reviewGradeMax`=5 条 review 归级 + 3 条任务判定），不值得为它常驻近 9 GiB。代价是冷启动要读约 9 GB 磁盘。

## D9 state 长度必须设上限

- **决策**：provider 侧对 `state` 做长度上限，超限即返回无结论（降级），**不静默截断**。
- **理由**：官方说明"每题都带完整 state + 全部题目一起打分"，nimble 上下文 8192 token，超限报错 `state has %d tokens; limit is %d with this question`。`risk-tier` 的 state 含声明范围与改动文件列表、`search-rerank` 含 8 个候选片段（`src/index.ts:270` 已 `slice(0,160)` 裁剪），长度是真实风险。静默截断会让判断依据与留痕不一致，所以选择"明确弃权"。

## D10 提案↔项目 wiki 的关联方式：以 vault 为准，不启用 Wiki 门

- **决策**：关联以 **vault 导出**为准 —— `iterations/<id>.md` 的 `depends_on`/`supersedes` + `index.md` + `changelog.md`，并用 `relatesTo: add-decision-layer` 让依赖成为真实数据；**不**在 `tasks.md` 声明 `<!-- wiki: true -->`（保留 `wikiLinks` 门的现状）。
- **理由**：证据见 `proposal.md` 的「Wiki 关联」——本仓库 0/69 使用过该门；门的实现仍是 WeKnora 措辞，而 WeKnora 已于 2026-10-07 被放弃；门是 `type` 级覆盖（`technical` 需 `concept`+`synthesis`），而本项目 `modules: 0` 使 `concept` 无从诚实满足；且该门**不可 force 跳过**。
- **替代方案**：① 声明 `wiki: true; type: technical` —— 否决（需先生成模块页，否则等于登记假 URL，并留下一道不可跳过的闸）；② 把 `wikiLinks` 的 `pageType` 语义改绑到 vault 笔记类 —— 保留为**独立后续变更**，不在本提案范围内。
- **维护动作**：变更落地后重跑 vault 导出，使迭代笔记反映最终状态（列为 tasks 第 8 项）。

## D11 主干可配（本仓库落地的前置，不是可选项）

- **决策**：新增 `Config.lifecycleMainBranch`（默认 `'main'`，本机配 `'feat/workmate'`），替换 `src/features/archive/service.ts:327`/`:353` 的 `'main'` 字面量，并透传给 `worktree.create({ … mainBranch })`。
- **理由（代码事实）**：本仓库主干是 `feat/workmate`（AGENTS.md：`main` 存的是已归档的 Helmsman）。而 `service.ts:378` 调 `worktree.create` 时**不传** `mainBranch`，`manager.ts:142` 落回 `'main'` → `implementing` 会执行 `git worktree add -b feature/<id> <path> main`，**从过期的 main 起分支**；`archiving` 的 `isMergedInto(..., 'main')`（`service.ts:353`）也永远不满足。不修这一处，本提案**走不完自己的生命周期**。
- **替代方案**：① 把 `feat/workmate` 合进 `main` 让 main 成为真主干 —— **用户已否决**（明确要继续在 `feat/workmate` 开发）；② 不推进 `implementing`、绕过八态 —— 否决（等于放弃这套流程）。
- **影响面**：`src/config.ts`（新字段）、`src/features/archive/service.ts`（两处字面量）、`src/index.ts`（构造 `LifecycleServiceImpl` 时传入）。`WorktreeManager` 的默认值不动，只做透传。

## 回滚

无状态迁移。回滚 = `decisionProvider` 切回 `agent`（缓存按 provider 名隔离，无需清理）；彻底回滚再删除 `systemone.ts` 与三个配置字段。规格改动同步回退到"接口占位"表述。
