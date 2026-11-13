# 设计：工作台交付打磨

## 背景

真机实测（2026-11-11）确立的原则：**面板数字必须说清自己数的是什么**。同一界面
上两个「提案数」口径不同却不标注，比数字错了更有害——用户会据此做错判断。

## 决策

### D1：计数口径——改标签而不是改数字

顶栏 19 条（含归档/终止）与 KPI 11 条（活跃）都是**对的**，错的是同名。改法：

- KPI 标签「提案总数」→「活跃提案」；值保持 `非终止 perProposal 行数 || metrics.proposals`
  兜底不变（f46bbe7 已把分母口径修对，这里只修标签）。
- 顶栏 `{proposals.length} 条提案` → `{proposals.length} 条提案（含已归档）`；
  加载失败且列表为空时显示「— 条提案（加载失败）」，不再让 0 假装成数据。

不引入第三个数字：归档数 KPI 已有「近 7/30 天归档」，顶栏不再细分。

### D2：隐藏计数——两个桶分开数，合并展示

已归档（status=archived 且非终止）与已终止（abandonedAt + archived）都默认隐藏，
但语义不同（可归档重开 vs 可撤销终止）。`visibleProposals` 已把终止滤掉
（不连坐修复，2026-11-11），所以：

- `hiddenArchived` = 可见集合里 status=archived 的条数（现口径，天然不含终止）；
- `hiddenTerminated` = **全量** proposals 里 `abandonedAt!==undefined && status==='archived'`
  且被隐藏的条数（从全量数，不从可见集合数）；
- 文案合并：「已隐藏 N 条（M 条已归档 + K 条已终止）」；某桶为 0 时不提该桶。

### D3：Why 从盘上读，不进聚合存储

`buildProposalStatus` 的 `collectProject` 已在读 change 目录（review.md 含归档回退）。
复用同一模式读 `proposal.md` 的 `## Why` 段：

- 抽 `readChangeDoc(root, openspecRoot, changeId, 'proposal.md')`（含归档目录回退），
  review 改走它，proposal.md Why 解析 `## Why` 到下一个 `## ` 之间，压成单段文本；
- `ProjectDetail.why?: string`，主项目投影到顶层 `why`（与 commits 同法）；
- 404/解析失败静默缺省——Why 是证据增强，不是门禁，不因它报错。

### D4：事件行格式

`EVENT_KIND_LABEL` 映射 8 个 kind（含 3 个历史 team-*）→ 中文；行格式
`MM-DD HH:mm · 标签 · from→to · reason · detail`。detail 是宿主拼好的可读串
（编排摘要），原样保留；`task-settled` 分支保留现有语义。

### D5：新提案第 1 步——校验前置、注册分区

- `goBranches` 先查 `title.trim()===''` → `setLocalError('先填标题')` 并停留第 1 步
  （submit 已有同判，双保险）；「下一步」在标题为空时不 disable（保留可点可见错误，
  不做静默吞点击）。
- 注册区独立小节（标题「没有想要的仓库？现场注册」），四输入纵向排、注册按钮右对齐，
  与关联多选之间留白 + 分隔；成功后自动勾选（现状保留）。
- label 隐式关联：`wm-field` 的 `<label>` 直接包裹控件；模态补
  `role="dialog" aria-modal="true" aria-label="新建提案"`，遮罩层
  `role="presentation"`（对齐 `controls.tsx` 的 Modal）。
- 「单项目根」折叠进 `<details>`（默认收起），标题注明仅旧流程需要。

### D6：控制带 note 中文化

host note：`基线样本不足：至少 ${min} 条，当前 ${baselineSamples} 条`。既有测试
`bands.test.ts:146` 与 `app.test.tsx:587` 的断言同步改。语义不变：仍
`insufficient-data`、不判越界。

### D7：可达性与对比度

- `--wm-border-strong`：浅色 `rgba(15,23,42,.30)`，深色沿用 `--dsw-alias-border-l3`；
  仅用于输入类控件边框，卡片/分隔线不动（避免整屏变重）。
- 任务卡片 `<article tabIndex={0}>`，focus 落入后内部 `wm-task-open` 按钮可 Enter 触发。
- `Pill` 组件输出 `aria-pressed={active}`（全部 pill 受益，不止「显示已归档」）。

## 风险

- 顶栏文案变化会碰到 `app.test.tsx:120`（「3 条提案」）——断言同步为含「含已归档」。
- Why 解析对缺 `## Why` 段的历史 change 静默缺省，不新增失败路径。
- 其余全部为展示层，不触状态机与门禁。
