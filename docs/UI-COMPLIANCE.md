# UI 规范符合性矩阵（PRD 第 4/5 章 → 实现）

对照 PRD v4.0 第 4 章「UI 交互流程与设计系统规范」与第 5 章「边缘情况 UI 降级方案」。
证据截图见 [docs/screenshots/](screenshots/)。

## 4.1 全局状态与数据流

| PRD 要求 | 实现 | 位置 |
|---|---|---|
| 单向数据流 HelmsmanState | `useReducer` + Action 联合类型，状态形状与 PRD 字段对应（currentProjectGroup/tasks/agentsStatus/ui） | `ui-dashboard/src/client/App.tsx` |
| 切换项目群 → 清空任务、刷新卡片 | `selectGroup` action 置空 tasks 并重载 | App.tsx |
| 点击并行执行 → 立即 Loading 卡片 | runTask 后立即 selectTask + 1.5s 轮询 | App.tsx |
| Agent 完成 → 卡片 🟡→🟢 | 状态机由后端驱动，卡片按 `state` 渲染 | App.tsx AgentCard |
| 查看Diff → 传递 taskId | 跳转 `/helmsman-diff/?task=<id>` | AgentCard |

## 4.2 任务状态机

| 状态 | UI 反馈 | 实现 |
|---|---|---|
| CREATING_WORKTREES | 卡片「准备环境」/ idle→running 过渡 + status 徽章 | TaskHeader badge |
| RUNNING | 计时器「执行中 Xs」+ 紫色渐变进度条 + 可展开实时日志（1.5s 轮询日志端点） | AgentCard |
| AGGREGATING | 顶部「📊 正在对比结果...」横幅 | TaskHeader |
| COMPLETED / PARTIAL_FAILED / ALL_FAILED | 🟢+N/-M行 / ⚠️ 部分失败横幅(成功率) / ❌ 全部失败横幅 | TaskHeader + AgentCard |
| 超时 | 默认 300s，倒计时进度（elapsed/timeout），⏰ 超时定格 80% | AgentCard |
| 取消 | 卡片 ✕ 取消 → `POST /api/task/:id/cancel` → AbortSignal 杀进程树 | AgentCard + orchestrator |

## 4.3 交互流程

- **项目群切换**：下拉菜单带 🕸️ 图标；加载失败 Toast「❌ 无法加载项目拓扑…」并保留上次数据（ConfigPanel catch 分支）。
- **Diff 三视图**：split / unified / side-by-side（多 Agent 最多 4 列）切换按钮。
- **行级交互**：悬停高亮 + 💬 评论图标 → 行内输入框；行号点击复制该行。
- **冲突**：⚡ 冲突徽章 + PRD 同款下拉（采用 Claude/Codex 方案 / 手动编辑）；选择影响「合并所选」的 agent 集合。
- **单 Agent 合并**：[✅ 合并 X] → 二次确认（放弃操作）→ 后端 patch 合并 → 结果 Toast。
- **部分合并**：文件列表勾选 → [🔀 合并所选]。

## 4.4 设计系统

| PRD | 实现 |
|---|---|
| 品牌色/语义色 7 色板 | CSS 变量 `--hls-brand/accent/success/warning/error/running/idle` 与 PRD HEX 一致 |
| 卡片 280×160 七状态视觉（边框/背景/进度/标记） | `.agent-card.{idle,running,completed,failed,timeout,rate-limited,auth-failed}` + 呼吸光晕动画（running） |
| 系统字体栈、24/16/14/12 字号层级 | styles.css |
| 4px 网格 | padding/gap 全部 4 的倍数 |
| CSS 变量双主题 + 暗色验证三项 | `:root[data-theme='dark']`；暗色阴影 0 1px 3px rgba(0,0,0,.3)；Diff 用 github-dark 系配色变量；图标用 emoji/currentColor |
| 响应式 3列→2列→1列，1280 最小支持 | media query 1024/768；<768 隐藏执行入口（只读） |

## 4.5 组件交互状态

| 组件 | 状态覆盖 |
|---|---|
| Prompt 输入框 | default / focus（品牌色边框）/ disabled（执行中）/ error（红边+抖动动画） |
| Agent 多选 | checked ✅ / unchecked / disabled + 「⚠️ 未安装」 |
| 并行执行按钮 | default / loading（旋转 spinner +「执行中...」）/ disabled（无选中 Agent 或离线） |
| 项目群下拉 | collapsed / expanded（🕸️ 列表） |
| Diff 行号 | hover 蓝色竖条 + 点击复制 |
| 合并确认 | confirm 弹窗；处理中按钮 disabled |
| Toast | info/success/warning/error；右上滑入，3s 自动淡出，error 手动关闭 |

## 4.6/4.7 线稿

- Dashboard 布局（顶栏/新任务卡/卡片网格/用量条）：`dashboard-light.png`、`dashboard-dark.png`
- Diff 布局（返回/任务/Agent chips/文件树/代码块/Legend/合并栏）：`diff-view.png`
- 配置面板 640px 右滑（基本信息/服务列表/依赖拓扑/保存导出/导入）：`config-panel.png`
- 空状态（📭 还没有项目群 + 创建 CTA + 导入入口）：`EmptyState` 组件

## 5.x 边缘状态

| PRD 状态 | 实现 |
|---|---|
| Loading 骨架屏 | `SkeletonScreen`（shimmer 动画） |
| Empty | 空状态引导 CTA |
| Populated | 正常渲染 |
| Error | Toast(error) + 卡片错误摘要 + [重试] |
| Offline | `navigator.onLine` 监听 → 顶部 ⚡ 横幅 + [重连]；执行按钮置灰 + Tooltip；prompt 草稿与模板存 localStorage |
| Rate-limited | 卡片 ⏱️ 限流中 + 自动指数退避重试（2s/8s/32s）+ [稍后重试] |
| Degraded | ⚠️ 部分 Agent 执行失败 (n/m 成功) 横幅，成功结果仍可用 |
| Auth-failed | 卡片 🔐 认证失效 + [配置密钥] |
| 断路器 | 连续 5 次失败 → 30s 快速失败，卡片显示倒计时原因 |

## 深链参数（实现附加）

- `?panel=config`：打开配置面板（验收/分享用）
- `?theme=dark`：强制暗色（默认跟随系统）
