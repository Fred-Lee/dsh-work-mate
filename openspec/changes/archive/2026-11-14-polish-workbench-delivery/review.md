<!-- reviewer: dsh-worker@deepseek-v4.1-flash shadow -->

# Review — 工作台交付打磨（真机缺陷收尾）

> 交叉一致性审查报告。四节标题为机器可读约定，禁止改名或增删。
> `## CRITICAL 问题` 中的每个条目是 checkbox：`- [ ]` = 未解决（阻断归档），
> `- [x]` = 已解决。

## 确认项

- [x] 确认（requirement↔task）：`openspec/changes/polish-workbench-delivery/specs/workbench-panel/spec.md` 与
  `openspec/changes/polish-workbench-delivery/specs/feedback-loop/spec.md` 两份 delta 的每条需求都能映射到
  tasks.md 的 T1–T13；T14/T15/T16 是测试、门禁与真机回归。`openspec validate polish-workbench-delivery` 通过，
  任务全部勾选。
- [x] 确认（计数口径）：顶栏徽标为「N 条提案（含已归档）」，列表加载失败且为空时退成「— 条提案」；
  控制台 KPI 标签为「活跃提案」（`src/client/App.tsx`）。两个数字不再同名不同义。
- [x] 确认（隐藏计数）：已归档与已终止分开计数；已终止从全量 proposals 数，不受 visibleProposals 的
  不连坐过滤影响（`src/client/App.tsx`）。真机实测看板渲染「已隐藏 18 条（10 条已归档 + 8 条已终止）」。
- [x] 确认（抽屉证据）：`src/features/proposal/status.ts` 抽出 readChangeDoc（含归档目录回退）并让 review.md
  与 proposal.md 读取复用，新增 whyFromProposalMd 解析 `## Why` 段；客户端抽屉渲染 Why、每项目 HEAD 与
  未提交变更数、标记提交（无则如实写「还没有标记提交」）与归档 manifest 的 diffStat（`src/client/App.tsx`）。
- [x] 确认（事件可读化）：EVENT_KIND_LABEL 覆盖 transition / gate-failed / band-breach / approval / decision /
  advance-scan / task-settled 及 3 个历史 team-* kind；事件行以 MM-DD HH:mm 开头，reason/detail 原文保留。
- [x] 确认（错误态/空态）：提案列表失败时横幅带「提案列表加载失败：」前缀与「重试」按钮；空态区分
  「还没有提案」与「没有匹配的提案」两种情况，后者给「清空筛选」出口。
- [x] 确认（新提案第 1 步）：goBranches 先校验标题为空 → 就地提示「先填标题」并停留第 1 步；模态
  role=dialog + aria-modal + aria-label「新建提案」，遮罩 role=presentation；label 包裹控件（隐式关联）；
  「没有想要的仓库？现场注册」独立成 `<details>` 小节；旧「单项目根」折叠进 `<details>`。
- [x] 确认（可达性与对比度）：Pill 的唯一使用点是「显示已归档」开关（`src/client/controls.tsx`，仅
  `src/client/App.tsx` 使用），aria-pressed 语义正确，未误加到普通动作按钮；任务卡片是
  `<article tabIndex={0}>`；输入类控件边框改用 --wm-border-strong。
- [x] 确认（feedback-loop）：`src/features/metrics/bands.ts` 的 insufficient-data note 为
  「基线样本不足：至少 N 条，当前 M 条」，控制台行渲染该 note；语义不变，仍不判越界。
- [x] 确认（设计可实现性）：design.md 的 D1–D7 与实现逐条对应，未发现互相矛盾、缺失的数据流或未声明依赖。
- [x] 确认（回滚）：全部为展示层/文案改动；why 读盘现算、不进聚合存储，无持久化形状变更、无迁移、
  无破坏性副作用。回滚 = revert 实现提交，无额外清理。
- [x] 确认（模块复用）：readChangeDoc 抽取后同时服务 review.md 与 proposal.md（design D3 落实），
  未引入与既有实现职责重叠的新抽象。
- [x] 确认（决策链）：提案 decisions 为空，无 supersedes 链需要核对。
- [x] 确认（归档前置）：本报告即归档审查门所需的 review.md；tasks 全部勾选（任务门通过）、变更目录无
  TASKS.json（团队证据门通过）、计划漂移门未配置开启。合并 → 归档所需的人工批准已记录。
- [x] 确认（验证方式与结果）：复审实测 `pnpm typecheck`、`pnpm test`（74 个文件 802 例全过）、`pnpm build`、
  `pnpm verify`（含 verify:test 自证）全绿；对运行中宿主 3080 跑 `scripts/ui-regression.mjs` 8/8 PASS，
  覆盖顶栏计数、aria-pressed、空态清空、隐藏计数、抽屉「做了什么」与事件行、KPI 活跃提案与 bands 中文
  note、新提案校验、任务卡片 tabindex。
- [x] 确认（消费方完整性）：改动集中在 UI 展示层与两个宿主侧纯函数（whyFromProposalMd、bands note）。
  消费方为面板组件、提案列表 REST（/workmate/api/proposals）载荷与 workmate_proposal_status 工具输出；新增字段 why
  在 `src/client/types.ts` 为可选，status.ts 条件投影，旧客户端/旧载荷不受影响。

## 疑问项

- 证据边界（非阻断）：GitNexus 索引停留在 2026-11-09，早于本变更（11-14）的提交，无法用 impact 查询
  机检消费方；上面的消费方清单来自静态阅读 + typecheck。归档编排的 `gitnexus analyze --force` 会在
  归档时重建索引。
- 视觉证据边界（非阻断）：本次复审用 ui:regress 的 8 条断言 + 截图复核用户路径；14 项缺陷中
  「边框对比度、模态视觉分区」等纯视觉项未逐像素比对（真机回归由人执行，T16 已勾选）。

## 建议补充项

- [ ] LOW-1 实现提交未带 [proposal:polish-workbench-delivery] 标记（6670263、ead923b、8f2ebbb、904a048），
  归档 manifest 的 commits 因此为空（`openspec/changes/polish-workbench-delivery/commits.md` 现为「（无）」），
  面板「做了什么」对该提案只能落到「还没有标记提交」。建议今后实现提交带标记；本次不改写既有提交。
- [ ] LOW-2 design D1 写的是加载失败时显示「— 条提案（加载失败）」，实现显示「— 条提案」并由错误横幅给出
  原因；spec 只要求「—」，不构成不符，建议下次对齐文案。

## CRITICAL 问题

<!-- 每条一个 checkbox，未勾选即阻断归档。 -->

- [x] 无未解决 CRITICAL 问题。