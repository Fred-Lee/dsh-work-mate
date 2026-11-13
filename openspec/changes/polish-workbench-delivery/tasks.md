# 任务：工作台交付打磨

## P0 计数与证据

- [ ] T1 KPI「提案总数」→「活跃提案」，顶栏徽标「N 条提案（含已归档）」，失败时「—」
- [ ] T2 隐藏计数分开数已归档与已终止，合并文案
- [ ] T3 status.ts 读 `## Why`（含归档回退），payload 投影 `why`
- [ ] T4 抽屉「做了什么」段：Why + 每项目提交 + HEAD/dirty + 归档 diffStat

## P1 反馈质量

- [ ] T5 事件行时间戳 + kind 中文标签
- [ ] T6 提案列表失败横幅带前缀与重试，顶栏不再显示假 0
- [ ] T7 空态区分「还没有」与「被筛掉」，后者给「清空筛选」
- [ ] T8 新提案第 1 步：标题前置校验、注册区独立小节、单项目根折叠
- [ ] T9 控制带 note 中文化（bands.ts + 控制台渲染 note）

## P2 可达性与对比度

- [ ] T10 任务卡片 tabIndex=0
- [ ] T11 Pill 输出 aria-pressed
- [ ] T12 `--wm-border-strong` 用于输入控件边框
- [ ] T13 新提案模态 dialog 语义与 label 关联

## 门禁

- [ ] T14 单测覆盖：口径文案、隐藏计数、goBranches 校验、抽屉证据渲染、bands note
- [ ] T15 `pnpm typecheck && pnpm test && pnpm verify && pnpm build` 全绿
- [ ] T16 真机浏览器回归（人的操作）：全部修复项过一遍并截图存档
