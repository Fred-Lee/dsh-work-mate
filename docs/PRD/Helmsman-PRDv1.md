# 🚢 Helmsman：基于 DeepSeek Harness 的 Agent 舰队指挥中心

## — 完整开发任务书 v4.0（最终完整版）

## 一、项目背景与核心定位

**Helmsman** 是一个基于 DeepSeek Harness (DSH) “一切皆插件”架构的 ADE（Agent Development Environment），让开发者在一个看板上同时指挥 Claude Code、Codex、Pi、oh-my-pi 等多个 AI 编程 Agent，在独立的 Git Worktree 中并行执行任务，并对比结果择优合并。

**核心理念**：**不是从零开发全部功能，而是充分利用 DSH 现有插件生态进行组装和扩展**。

**DSH 插件开发规范**（必须严格遵守）：

- 使用**具名导出**（`export const name`、`export const inject`、`export const Config`、`export function apply`），**禁止 `export default`**
- 通过 `inject` 声明依赖，在 `apply(ctx)` 注册能力
- 使用 `ctx.effect()` 管理资源
- 遵循 Cordis 插件生命周期

## 二、技术架构与插件拆解（含复用策略）

| 序号 | 插件名（npm scope）            | 类型          | 复用策略                                                                                      |
| ---- | ------------------------------ | ------------- | --------------------------------------------------------------------------------------------- |
| 1    | `@helmsman/worktree`         | Service       | **直接复用** `dsh-virtual-workspace`，仅做轻量封装                                    |
| 2    | `@helmsman/memory-topology`  | Service       | **直接复用** `dsh-memory-manager` + `dsh-memory-palace`，扩展项目拓扑数据模型       |
| 3    | `@helmsman/orchestrator`     | Service/Tool  | **参考** `dsh-Visual-Workflow` 和 `kalifun/helmsman` 的编排架构，开发自定义调度引擎 |
| 4    | `@helmsman/adapter-claude`   | Agent Adapter | **从零开发**（社区无现成统一适配层）                                                    |
| 5    | `@helmsman/adapter-codex`    | Agent Adapter | **从零开发**                                                                            |
| 6    | `@helmsman/adapter-pi`       | Agent Adapter | **从零开发**                                                                            |
| 7    | `@helmsman/adapter-oh-my-pi` | Agent Adapter | **从零开发**                                                                            |
| 8    | `@helmsman/ui-dashboard`     | Web UI        | **参考** `kalifun/helmsman` UI 设计，从零开发                                         |
| 9    | `@helmsman/ui-diff`          | Web UI        | **从零开发**（社区无现成多 Agent 并排 Diff 组件）                                       |
| 10   | `@helmsman/bundle`           | Bundle        | 组合所有插件                                                                                  |

## 三、各模块详细实现要求

### 3.1 `@helmsman/worktree` — Worktree 调度服务

> **🔁 复用策略：直接复用 `dsh-virtual-workspace`**

| 策略项                      | 说明                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **复用插件**          | `dsh-virtual-workspace` — 将多个项目目录分组到同一名称下，支持跨项目读/搜索/写                                                                        |
| **GitHub 地址**       | https://github.com/KevinWen7415/dsh-virtual-workspace                                                                                                    |
| **安装方式**          | `dsh plugin --profile <你的profile名> add github:KevinWen7415/dsh-virtual-workspace`                                                                   |
| **Helmsman 新增内容** | 封装一层统一 API：`createWorktree()`、`removeWorktree()`、`listWorktrees()`、`getDiff()`，内部调用 `dsh-virtual-workspace` 的 `vws` 工具能力 |
| **代码量**            | 约 150-200 行（封装层）                                                                                                                                  |

**实现要求**：

```typescript
// @helmsman/worktree/src/index.ts
import { Context } from '@deepseek-ai/cordis';

export const name = '@helmsman/worktree';
export const inject = [] as const;

export function apply(ctx: Context) {
  ctx.provide('helmsman.worktree', {
    createWorktree: async (params) => { /* 调用 vws add / add-dir */ },
    removeWorktree: async (path) => { /* 调用 vws remove */ },
    listWorktrees: async (taskId) => { /* 调用 vws list */ },
    getDiff: async (path) => { /* 执行 git diff */ }
  });
}
```

### 3.2 `@helmsman/memory-topology` — 项目拓扑记忆

> **🔁 复用策略：直接复用 `dsh-memory-manager` + `dsh-memory-palace`**

| 策略项                      | 说明                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **复用插件 A**        | `dsh-memory-manager` — 移植自 ZCode 的项目记忆，Markdown 格式落盘                                                                            |
| **GitHub 地址**       | https://github.com/MoonlitDropOfBlood/dsh-memory-manager                                                                                        |
| **安装方式**          | `dsh plugin --profile web add https://github.com/MoonlitDropOfBlood/dsh-memory-manager/releases/download/v1.2.0/dsh-memory-manager-1.2.0.tgz` |
| **复用插件 B**        | `dsh-memory-palace` — 用户级 + 工作区级双层记忆，每轮自动注入提示词                                                                          |
| **GitHub 地址**       | https://github.com/lovezi0/dsh-memory-palace                                                                                                    |
| **安装方式**          | `dsh plugin --profile <你的profile名> add github:lovezi0/dsh-memory-palace`                                                                   |
| **Helmsman 新增内容** | 在记忆模型中增加项目拓扑数据结构（`ProjectTopology`），新增 `scanMavenParent()`、`scanRestApis()`、`getDownstream()` 三个 API           |
| **代码量**            | 约 200-300 行（扩展层）                                                                                                                         |

**数据模型**：

```typescript
interface ProjectTopology {
  projectGroupId: string;
  projects: { [id: string]: { name: string; repoUrl: string; localPath: string; type: 'maven'|'npm'|'gradle'|'other' } };
  services: { [id: string]: { name: string; projectId: string; techStack: string[]; apiEndpoints: ApiEndpoint[] } };
  mavenParents: { [id: string]: { pomPath: string; managedDependencies: Record<string,string>; children: string[] } };
  restDependencies: { [from: string]: { toServiceId: string; endpoints: string[]; method: string }[] };
}
```

### 3.3 `@helmsman/orchestrator` — 多 Agent 调度引擎

> **🔁 复用策略：参考 `dsh-Visual-Workflow` 和 `kalifun/helmsman` 架构，从零实现调度核心**

| 策略项                      | 说明                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| **参考项目 A**        | `dsh-Visual-Workflow` — 可视化多 Agent 工作流编排，零代码拖拽连线                        |
| **GitHub 地址**       | https://github.com/GZX2211/dsh-Visual-Workflow                                              |
| **安装方式**          | `dsh plugin --profile web add GZX2211/dsh-Visual-Workflow`                                |
| **参考项目 B**        | `kalifun/helmsman` — 任务型 AI 工作台：“任务即会话、评论即控制”                        |
| **GitHub 地址**       | https://github.com/kalifun/helmsman                                                         |
| **参考方式**          | `git clone https://github.com/kalifun/helmsman.git` 研究其设计                            |
| **Helmsman 新增内容** | 从零实现`runParallelTask()`、`cancelTask()`、`getTaskStatus()`、`registerAdapter()` |
| **代码量**            | 约 400-600 行                                                                               |

**核心 API**：

```typescript
interface OrchestratorService {
  registerAdapter(adapter: AgentAdapter): void;
  runParallelTask(params: { prompt: string; agents: AgentType[]; projectGroupId: string; cascade?: boolean; timeout?: number }): Promise<TaskResult>;
  cancelTask(taskId: string): Promise<void>;
  getTaskStatus(taskId: string): Promise<TaskStatus>;
}
```

### 3.4 `@helmsman/adapter-*` — Agent 适配器（4 个）

> **🔁 复用策略：从零开发（社区无现成统一适配层）**

| 策略项                      | 说明                                                          |
| --------------------------- | ------------------------------------------------------------- |
| **参考**              | 各 Agent 的 CLI 官方文档                                      |
| **Helmsman 新增内容** | 4 个独立适配器，每个实现`checkInstalled()` 和 `execute()` |
| **代码量**            | 每个约 80-120 行                                              |

**实现模板**（以 claude 为例）：

```typescript
// @helmsman/adapter-claude/src/index.ts
export const name = '@helmsman/adapter-claude';
export const inject = ['helmsman.orchestrator'] as const;

export function apply(ctx: Context) {
  const orchestrator = ctx.helmsman.orchestrator;
  orchestrator.registerAdapter({
    name: 'claude',
    checkInstalled: async () => { try { await execAsync('which claude-code'); return true; } catch { return false; } },
    execute: async ({ prompt, worktreePath, timeout = 300 }) => {
      const proc = spawn('claude-code', ['--prompt', prompt, '--workdir', worktreePath]);
      // 返回 stdout/stderr 和退出码
    }
  });
}
```

### 3.5 `@helmsman/ui-dashboard` — 主控面板 UI

> **🔁 复用策略：参考 `kalifun/helmsman` 的 UI 设计，按 DSH WebUI 规范从零实现**

| 策略项                      | 说明                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| **参考项目**          | `kalifun/helmsman` — 同名项目的 UI 布局和交互模式                 |
| **Helmsman 新增内容** | Dashboard React 组件：项目群切换、任务输入、Agent 卡片网格、用量追踪 |
| **代码量**            | 约 600-900 行                                                        |

### 3.6 `@helmsman/ui-diff` — Diff 对比视图

> **🔁 复用策略：从零开发（社区无现成多 Agent 并排 Diff 组件）**

| 策略项                      | 说明                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| **参考**              | Git diff 格式标准，可用`diff` 库或 `monaco-editor` diff 组件 |
| **Helmsman 新增内容** | 多 Agent Diff 并排对比、冲突标注、行级批注、一键合并             |
| **代码量**            | 约 500-700 行                                                    |

### 3.7 `@helmsman/bundle` — 组合包

```json
{
  "name": "@helmsman/bundle",
  "dsh": { "bundle": { "plugins": [
    "@helmsman/worktree", "@helmsman/memory-topology", "@helmsman/orchestrator",
    "@helmsman/adapter-claude", "@helmsman/adapter-codex", 
    "@helmsman/adapter-pi", "@helmsman/adapter-oh-my-pi",
    "@helmsman/ui-dashboard", "@helmsman/ui-diff"
  ] } }
}
```

## 四、UI 交互流程与设计系统规范（完整版）

> **这是 ZCode 开发 UI 时必须严格遵循的完整规范，包含交互规则、数据流、视觉设计和边缘情况。**

### 4.1 全局状态管理与数据流

Helmsman 的 UI 状态由 DSH 的**前端状态管理**驱动，采用 **单向数据流**，确保 Dashboard 和 Diff 视图状态同步。

```typescript
// 全局状态定义
interface HelmsmanState {
  currentProjectGroup: string | null;
  tasks: Map<string, Task>;
  selectedTaskId: string | null;
  agentsStatus: {
    [agentName: string]: {
      installed: boolean;
      version?: string;
      apiKeyConfigured: boolean;
    }
  };
  ui: {
    isExecuting: boolean;
    sidebarCollapsed: boolean;
    diffViewMode: 'split' | 'unified' | 'side-by-side';
    activeAgentFilter: string[];
  };
}
```

**数据流转规则**：

| 触发事件             | 数据流向                                           | UI响应                                    |
| :------------------- | :------------------------------------------------- | :---------------------------------------- |
| 用户切换项目群       | Dashboard →`topology.loadTopology()`            | 清空当前任务列表，刷新Agent卡片           |
| 用户点击“并行执行” | Dashboard →`orchestrator.runParallelTask()`     | 立即显示所有Agent的“Loading”状态卡片    |
| 单个Agent完成        | Orchestrator 推送事件 → Dashboard 监听            | 对应卡片从 🟡 变为 🟢，进度条跳转至100%   |
| 用户点击“查看Diff” | Dashboard → Diff 视图 (传递 taskId)               | 右侧滑出 Diff 面板，加载各 Agent 代码变更 |
| 用户点击配置按钮     | Dashboard → 打开配置面板                          | 右侧滑出配置面板，加载当前项目群拓扑      |
| 用户保存配置         | 配置面板 →`topology.saveTopology()`             | 写入磁盘，关闭面板，刷新 Dashboard        |
| 用户导入架构         | 配置面板 → 解析文件 →`topology.saveTopology()` | 批量创建服务和依赖，刷新面板和 Dashboard  |

### 4.2 任务执行全流程状态机

每个 Task 的生命周期包含以下状态，UI 必须在每个状态提供明确的视觉反馈：

```
[IDLE] 
   │ 用户点击“并行执行”
   ▼
[CREATING_WORKTREES] (每个Agent独立创建)
   │ UI显示: 每个Agent卡片显示“🔄 准备环境...” (进度条动画)
   ▼
[RUNNING] (Agent正在执行)
   │ UI显示: 实时流式输出终端日志 (每个卡片可展开查看)
   │ 进度条: 模拟进度 (0-100%) 或通过stdout解析进度
   ▼
[AGGREGATING] (收集diff)
   │ UI显示: 顶部出现“📊 正在对比结果...” 的横幅
   ▼
[COMPLETED] / [PARTIAL_FAILED] / [ALL_FAILED]
   │ UI显示: 
   │  - 成功: 🟢 绿色卡片 + “✅ 完成” 徽章 + 变更行数
   │  - 失败: 🔴 红色卡片 + “❌ 失败” + [重试]按钮
   │  - 超时: 🟡 黄色卡片 + “⏰ 超时” + [重试]按钮
```

**超时与取消机制**：

- 每个 Agent 任务默认超时：**300 秒**，UI 端设置倒计时进度条。
- 用户可随时点击卡片右上角的 **“✕ 取消”**，前端发送取消信号给 Orchestrator。

### 4.3 核心交互流程

#### 4.3.1 项目群切换交互规范

左侧边栏的“项目群切换”是最高频操作：

| 用户操作                             | 系统响应                                                       | 加载状态                             |
| :----------------------------------- | :------------------------------------------------------------- | :----------------------------------- |
| 点击左侧项目群名称（如“订单中台”） | 调用`topology.loadTopology("订单中台")`                      | 顶部出现“🔄 加载中...”的全局进度环 |
| 加载完成                             | 右侧 Dashboard 刷新为该群下的所有服务和历史任务                | 平滑淡入动画 (300ms)                 |
| 加载失败                             | 弹出 Toast 提示：“❌ 无法加载项目拓扑，请检查网络或配置文件” | 保留上次可用缓存数据                 |

#### 4.3.2 Diff 对比与合并交互规范

**视图切换**：支持三种模式

- `split`：左右并排（Git 默认风格）
- `unified`：统一格式（+ / - 行内混合）
- `side-by-side`：多 Agent 并排（最多 4 个）

**行级交互**：

1. **悬停**：鼠标悬停在某行 diff 上 → 该行高亮，出现“💬 评论”图标
2. **点击评论图标** → 底部展开评论输入框（Markdown 支持）
3. **冲突解决**：当多个 Agent 修改同一行时，该行用“⚡ 冲突”标签标注，并弹出下拉选择框：

```
┌──────────────────────────────────────────┐
│  ⚡ 代码冲突 (3个Agent不同修改)          │
│  ○ 采用 Claude 的方案 (简洁)            │
│  ○ 采用 Codex 的方案 (更健壮)           │
│  ● 手动编辑 (自定义合并)                │
└──────────────────────────────────────────┘
```

**合并操作**：

- **单Agent合并**：点击卡片底部 **[✅ 合并此Agent]** → 弹窗二次确认 → 执行 `git merge` → 返回结果 Toast
- **部分合并**：用户在不同 Agent 的 diff 中勾选特定文件 → 点击 **[🔀 合并所选]** → 生成混合 commit

### 4.4 设计系统规范

#### 4.4.1 品牌色与语义色

| 类型                  | 颜色值 (HEX) | 用途                        |
| :-------------------- | :----------- | :-------------------------- |
| **品牌主色**    | `#1A8CD8`  | 按钮、链接、主要图标        |
| **品牌辅助**    | `#0D9488`  | 选中状态、进度条轨道        |
| **成功**        | `#10B981`  | Agent完成、合并成功         |
| **警告**        | `#F59E0B`  | 超时、部分失败、重试提醒    |
| **错误**        | `#EF4444`  | Agent执行失败、合并冲突     |
| **运行中**      | `#8B5CF6`  | 正在执行的Agent卡片边框动画 |
| **空闲/未启用** | `#9CA3AF`  | 未选中的Agent，不可用       |

#### 4.4.2 Agent 卡片状态视觉规范

每个 Agent 卡片（尺寸：`280px x 160px`）必须包含以下元素：

| 状态             | 边框色                       | 背景色      | 进度条颜色           | 附加标记                      |
| :--------------- | :--------------------------- | :---------- | :------------------- | :---------------------------- |
| `idle`         | `#E5E7EB`                  | `#F9FAFB` | 无                   | 显示“⚪ 待命”               |
| `running`      | `#8B5CF6` (带呼吸光晕动画) | `#F5F3FF` | 紫色渐变动画         | 显示“🔄 执行中 Xs” (计时器) |
| `completed`    | `#10B981`                  | `#ECFDF5` | 全满，翠绿色         | 显示“✅ 完成 +N/-M行”       |
| `failed`       | `#EF4444`                  | `#FEF2F2` | 红色，定格在当前进度 | 显示“❌ 失败: [错误摘要]”   |
| `timeout`      | `#F59E0B`                  | `#FFFBEB` | 黄色，定格在80%      | 显示“⏰ 超时 (300s)”        |
| `rate-limited` | `#F59E0B`                  | `#FFFBEB` | 黄色，定格在当前进度 | 显示“⏱️ 限流中 剩余 X次”  |
| `auth-failed`  | `#EF4444`                  | `#FEF2F2` | 无                   | 显示“🔐 认证失效”           |

#### 4.4.3 排版与间距

- **字体**：系统字体栈 `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
- **字号层级**：
  - 页面标题：`24px / 700` (加粗)
  - 卡片标题 (Agent名)：`16px / 600` (半粗)
  - 正文 (Prompt预览)：`14px / 400`
  - 辅助信息 (时间/行数)：`12px / 400`
- **间距基准**：采用 **4px 网格系统**（即 `padding: 8px`, `gap: 12px`, `margin: 16px` 等均为 4 的倍数）

#### 4.4.4 暗色主题适配

**所有 UI 组件必须使用 CSS 变量**，而非硬编码颜色值：

| CSS变量                  | 亮色值      | 暗色值      | 用途             |
| :----------------------- | :---------- | :---------- | :--------------- |
| `--hls-bg-primary`     | `#FFFFFF` | `#1F2937` | 主背景           |
| `--hls-bg-secondary`   | `#F3F4F6` | `#111827` | 卡片背景、侧边栏 |
| `--hls-text-primary`   | `#111827` | `#F9FAFB` | 主要文字         |
| `--hls-text-secondary` | `#6B7280` | `#9CA3AF` | 辅助文字         |
| `--hls-border`         | `#E5E7EB` | `#374151` | 分割线、卡片边框 |

**暗色模式验证标准**：

- [ ] 卡片在暗色模式下有微弱的 `box-shadow: 0 1px 3px rgba(0,0,0,0.3)`
- [ ] Diff 代码高亮在暗色模式下使用类似 `github-dark` 的配色
- [ ] 所有 SVG 图标使用 `currentColor` 或 CSS 变量控制颜色

#### 4.4.5 响应式布局要求

- **桌面优先**：最小支持分辨率 `1280 x 800`，Dashboard 采用 **3列网格** 展示 Agent 卡片
- **平板适配**：`768px ~ 1024px` 时，Agent 卡片变为 **2列网格**，Diff 视图自动收起侧边栏
- **移动端**：通过移动伴侣 App 实现，主 UI 在移动浏览器中仅显示只读状态（不允许新建任务）

### 4.5 UI 组件交互状态清单

| 组件                      | 状态列表                                                              | 交互反馈                                          |
| :------------------------ | :-------------------------------------------------------------------- | :------------------------------------------------ |
| **Prompt输入框**    | `default`, `focused`, `disabled` (执行中), `error` (内容为空) | 聚焦时边框变为品牌色；错误时红色抖动动画          |
| **Agent多选开关**   | `checked`, `unchecked`, `disabled` (该Agent未安装)              | 选中时显示✅；未安装显示“⚠️ 未安装”提示       |
| **[并行执行] 按钮** | `default`, `loading` (执行中), `disabled` (无选中Agent)         | 加载时显示旋转动画 + “执行中...”                |
| **项目群下拉菜单**  | `collapsed`, `expanded`                                           | 展开时显示带 🕸️ 拓扑图标的服务列表              |
| **Diff行号**        | `default`, `hover`, `selected`                                  | hover 时显示蓝色竖条；点击时复制该行代码          |
| **合并确认弹窗**    | `idle`, `processing` (合并中), `success`, `error`             | 处理时不可关闭；成功后自动关闭并刷新页面          |
| **Toast通知**       | `info`, `success`, `warning`, `error`                         | 从右上角滑入，3秒后自动淡出 (error级别需手动关闭) |

### 4.6 UI 线稿参考

ZCode 开发时须参考以下线稿实现：

#### Dashboard 主界面布局

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ⚓ Helmsman  │  [项目群: 订单中台 ▼]  │  🔍 搜索  │  👤 Profile          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  📝 新任务                                                          │  │
│  │  ┌─────────────────────────────────────────────────────────────┐    │  │
│  │  │  Prompt: [___请在此输入你的需求________________________]    │    │  │
│  │  └─────────────────────────────────────────────────────────────┘    │  │
│  │  Agents: [✓ Claude] [✓ Codex] [ ] Pi [ ] oh-my-pi                 │  │
│  │  [▶ 并行执行]  [💾 保存为模板]                                    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐         │
│  │  🟡 Claude   │ │  🟢 Codex    │ │  🔴 Pi      │ │  🟡 oh-my-pi │         │
│  │  2 min ago   │ │  1 min ago   │ │  Error      │ │  30 sec ago  │         │
│  │  ████████░░  │ │  ██████████  │ │  ████░░░░░░ │ │  ██████░░░░  │         │
│  │  80%         │ │  100% ✅     │ │  ❌ Failed  │ │  60%         │         │
│  │  [查看]      │ │  [查看Diff]  │ │  [重试]    │ │  [查看]      │         │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘         │
│                                                                             │
│  📊 用量: Claude 2.3K/5K  │ Codex 1.8K/5K  │ Pi 0.9K/3K                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Diff 对比视图布局

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ← 返回  │  任务: "修复登录验证"  │  📁 涉及 2 个服务                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                              │
│  │  Claude    │ │  Codex    │ │  Pi       │                              │
│  │  [+23/-7]  │ │  [+31/-5] │ │  [+18/-3] │                              │
│  └───────────┘ └───────────┘ └───────────┘                              │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  📄 src/components/LoginForm.tsx                                     │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │  │
│  │  │ 1  │  import React from 'react'                                │ │  │
│  │  │ 2  │  + const validateEmail = (email) => { ... }  ← Claude    │ │  │
│  │  │ 3  │  - const validateInput = (input) => { ... }  ← Codex     │ │  │
│  │  │ 4  │  ~ const handleSubmit = (e) => { ... }     ← 冲突        │ │  │
│  │  └─────────────────────────────────────────────────────────────────┘ │  │
│  │  Legend:  ─── 共同  │  + Claude  │  - Codex  │  ~ 冲突            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  [✅ 合并 Claude]  [✅ 合并 Codex]  [🔀 合并选择]  [❌ 全部放弃]           │
└─────────────────────────────────────────────────────────────────────────────┘
```

你说得对，项目群配置是 Helmsman 的**核心管理功能**，没有它就无法创建和管理微服务拓扑。下面补充 **项目群配置界面** 的完整 UI 描述，请将其作为 **第 4.7 节** 插入到提示词的第 4 章末尾。

---

### 4.7 项目群配置界面（Project Group Configuration）

#### 4.7.1 功能定位

项目群配置是 Helmsman 的 **“设置中心”** ，用户在这里完成以下操作：

1. **创建/删除/重命名** 项目群（对应微服务架构中的一个业务域）
2. **添加/移除/配置** 服务（每个服务对应一个 Git 仓库）
3. **声明依赖关系**（REST 调用、Maven 父 POM 继承）
4. **导入现有架构**（从 `docker-compose.yml`、`K8s manifest` 或 `OpenAPI` 导入）

#### 4.7.2 入口位置

项目群配置入口位于 Dashboard **左上角项目群切换器的右侧**：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ⚓ Helmsman  │  [订单中台 ▼]  ⚙️  │  🔍 搜索  │  👤 Profile          │
│                 ↑                  ↑                                       │
│              切换器            配置按钮                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**交互规则**：

- 点击 **⚙️ 配置按钮** → 右侧滑出配置面板（`width: 640px`，覆盖在主内容上方）
- 若当前没有选中任何项目群，配置面板自动进入“新建项目群”模式

#### 4.7.3 配置面板布局

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ⚙️ 项目群配置                                    [✕ 关闭]                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  选择项目群:  [订单中台 ▼]  [🗑️ 删除]  [📋 复制]  [➕ 新建]        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  📋 基本信息                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  名称:   [订单中台________________________]                         │  │
│  │  描述:   [订单全生命周期管理，包含下单、支付、履约]                │  │
│  │  默认分支: [main ▼]                                                  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  📦 服务列表 (3)                                  [➕ 添加服务]  [📥 导入] │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │  │
│  │  │  api-gateway    │  https://github.com/org/api-gateway.git     │ │  │
│  │  │  项目类型: [Maven ▼]  │  技术栈: Java 17, Spring Boot 3       │ │  │
│  │  │  [✏️ 编辑] [🗑️ 移除] [🔄 扫描 API]                           │ │  │
│  │  └─────────────────────────────────────────────────────────────────┘ │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │  │
│  │  │  user-service   │  https://github.com/org/user-service.git    │ │  │
│  │  │  项目类型: [Maven ▼]  │  技术栈: Java 17, Spring Boot 3       │ │  │
│  │  │  [✏️ 编辑] [🗑️ 移除] [🔄 扫描 API]  ✅ API 已扫描 (12个端点)  │ │  │
│  │  └─────────────────────────────────────────────────────────────────┘ │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │  │
│  │  │  order-service  │  https://github.com/org/order-service.git   │ │  │
│  │  │  项目类型: [Maven ▼]  │  技术栈: Java 17, Spring Boot 3       │ │  │
│  │  │  [✏️ 编辑] [🗑️ 移除] [🔄 扫描 API]  ⏳ 扫描中...              │ │  │
│  │  └─────────────────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  🕸️ 依赖拓扑                                     [➕ 添加依赖]             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  REST 依赖:                                                    │  │  │
│  │  │  user-service ──GET /api/users/{id}──► order-service          │  │  │
│  │  │  order-service ──POST /api/orders──► payment-service          │  │  │
│  │  │  [✏️ 编辑] [🗑️ 删除]                                          │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  Maven 父 POM:                                                 │  │  │
│  │  │  root-pom ──parent of──► api-gateway, user-service, order-svc  │  │  │
│  │  │  [✏️ 编辑] [🗑️ 删除]  [📂 选择 pom.xml]                       │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  [💾 保存]  [📥 导出配置]  [🔄 重新扫描全部]                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 4.7.4 “添加/编辑服务”弹窗

点击“添加服务”或某服务的“编辑”按钮，弹出模态框：

```
┌─────────────────────────────────────────────────────────────────┐
│  ✏️ 编辑服务: user-service                    [✕]              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  服务名称:  [user-service_____________________________]        │
│  Git URL:    [https://github.com/org/user-service.git  ]      │
│  本地路径:   [~/workspace/order-platform/user-service   ]      │
│  项目类型:   [Maven ▼]  (Maven / NPM / Gradle / Other)        │
│  技术栈:     [Java 17, Spring Boot 3, MyBatis          ]      │
│  默认分支:   [main ▼]                                          │
│                                                                 │
│  ☑️ 启用 API 自动扫描                                           │
│  扫描配置:   [@RestController, @RequestMapping         ]        │
│                                                                 │
│  ☑️ 启用 Maven 父 POM 继承                                      │
│  父 POM 路径: [../pom.xml______________________________]        │
│                                                                 │
│  ──────────────────────────────────────────────────────────────  │
│                                                                 │
│  已扫描的 API 端点 (12 个):                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  GET    /api/users/{id}    →  user-service            │   │
│  │  POST   /api/users         →  user-service            │   │
│  │  PUT    /api/users/{id}    →  user-service            │   │
│  │  ... (展开查看全部)                                     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  [📱 手动添加端点]  [🔄 重新扫描]                              │
│                                                                 │
│  [💾 保存]  [🗑️ 删除此服务]                                    │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.7.5 “添加依赖”弹窗

点击“添加依赖”按钮，弹出依赖配置模态框：

```
┌─────────────────────────────────────────────────────────────────┐
│  ➕ 添加依赖关系                                [✕]              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  依赖类型:   [REST API ▼]  (REST API / Maven Parent / gRPC)   │
│                                                                 │
│  ──────────── REST API 依赖 ────────────────                   │
│  调用方服务: [user-service ▼]                                  │
│  被调用方服务: [order-service ▼]                               │
│  HTTP 方法:  [GET ▼]  (GET / POST / PUT / DELETE / PATCH)     │
│  端点路径:    [/api/users/{id}/orders________________]         │
│  描述:        [获取用户的所有订单_____________________]         │
│                                                                 │
│  ☑️ 此依赖为关键路径 (影响级联调度优先级)                       │
│                                                                 │
│  ──────────── Maven 父 POM ─────────────────                    │
│  父 POM:     [root-pom ▼]                                      │
│  子模块:     ☑️ api-gateway  ☑️ user-service  ☑️ order-svc    │
│              ☐ payment-service                                 │
│                                                                 │
│  [💾 添加]  [取消]                                             │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.7.6 “导入架构”功能

点击服务列表上方的 **“📥 导入”** 按钮，弹出导入向导：

```
┌─────────────────────────────────────────────────────────────────┐
│  📥 导入架构                                        [✕]        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  选择导入源:                                                    │
│  ○ docker-compose.yml  (解析 services 定义)                    │
│  ○ Kubernetes Manifest (解析 Deployment + Service)             │
│  ○ OpenAPI / Swagger   (解析 API 定义)                        │
│  ● 手动配置            (从头开始)                              │
│                                                                 │
│  ──────────────────────────────────────────────────────────────  │
│  选择文件:  [📂 选择 docker-compose.yml]                       │
│                                                                 │
│  预览解析结果:                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  发现 5 个服务:                                         │   │
│  │  ☑️ api-gateway    (image: nginx:latest)              │   │
│  │  ☑️ user-service   (image: user-service:1.2.0)        │   │
│  │  ☑️ order-service  (image: order-service:1.2.0)       │   │
│  │  ☑️ payment-service (image: payment-service:1.1.0)    │   │
│  │  ☑️ redis          (image: redis:7.0)                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ☑️ 自动推断服务间依赖关系 (基于容器名称和环境变量)            │
│                                                                 │
│  [📥 导入]  [取消]                                            │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.7.7 “导出配置”功能

点击 **“📥 导出配置”** 按钮，导出项目群拓扑为可移植的 JSON 或 YAML 格式：

```yaml
# helmsman-topology.yaml
projectGroup:
  name: "订单中台"
  description: "订单全生命周期管理"
  defaultBranch: "main"

services:
  - name: "api-gateway"
    repoUrl: "https://github.com/org/api-gateway.git"
    type: "maven"
    techStack: ["Java 17", "Spring Boot 3"]
  - name: "user-service"
    repoUrl: "https://github.com/org/user-service.git"
    type: "maven"
    techStack: ["Java 17", "Spring Boot 3"]

restDependencies:
  - from: "user-service"
    to: "order-service"
    endpoints: ["/api/users/{id}/orders"]
    method: "GET"

mavenParents:
  - parent: "root-pom"
    path: "./pom.xml"
    children: ["api-gateway", "user-service", "order-service"]
```

#### 4.7.8 配置面板交互规则

| 用户操作     | 系统响应                                   | UI反馈                                       |
| :----------- | :----------------------------------------- | :------------------------------------------- |
| 创建新项目群 | 在`~/.helmsman/topologies/` 下创建空配置 | 面板清空，进入编辑状态                       |
| 切换项目群   | 加载对应的拓扑配置                         | 面板内容刷新，显示该群的服务和依赖           |
| 添加服务     | 校验 Git URL 是否有效                      | 成功：服务出现在列表中；失败：红色错误提示   |
| 扫描 API     | 在后台执行`scanRestApis()`               | 按钮显示“⏳ 扫描中...”，完成后显示端点数量 |
| 保存配置     | 验证拓扑完整性后写入磁盘                   | 右上角 Toast：“✅ 配置已保存”              |
| 删除项目群   | 弹窗二次确认                               | 确认后从磁盘删除，返回空状态                 |
| 导入架构     | 解析文件，生成服务列表预览                 | 用户确认后批量导入，合并到现有配置           |

#### 4.7.9 空状态设计

当没有任何项目群时，Dashboard 显示空状态引导：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ⚓ Helmsman  │  [未选择项目群 ▼]  ⚙️  │  🔍 搜索  │  👤 Profile          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                          📭 还没有项目群                                    │
│                                                                             │
│              创建第一个项目群，开始指挥你的 Agent 舰队                      │
│                                                                             │
│                     ┌──────────────────────┐                               │
│                     │  ➕ 创建项目群       │                               │
│                     └──────────────────────┘                               │
│                                                                             │
│          或者从现有架构导入:                                                │
│          [📂 导入 docker-compose.yml]  [📂 导入 K8s manifest]              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 五、边缘情况 UI 降级方案

### 5.1 设计原则

1. **分层处理**：根据错误类型（超时、限流、网络断开、模型异常）采用不同策略
2. **降级不崩溃**：当依赖失败时，降级到可用的功能子集，而不是完全失败
3. **保持可见**：网络断开后，**保留最后一次已知的有效数据**，不清空页面
4. **可恢复**：每个错误状态必须包含：(a) 发生了什么，(b) 为什么发生，(c) 用户可以做什么

### 5.2 七种核心边缘状态

| 状态                   | 触发条件                       | UI 表现                         |
| :--------------------- | :----------------------------- | :------------------------------ |
| **Loading**      | 首次加载，无缓存数据           | 骨架屏（Skeleton）动画占位      |
| **Empty**        | 加载完成，但无数据             | 空状态提示 + 操作引导           |
| **Populated**    | 数据加载成功                   | 正常内容展示                    |
| **Error**        | 服务器/网络错误，无缓存数据    | 错误卡片 + 重试按钮             |
| **Offline**      | `navigator.onLine === false` | 顶部离线横幅 + 缓存数据继续展示 |
| **Rate-limited** | API 返回 429                   | 限流卡片 + 倒计时               |
| **Degraded**     | 部分数据可用，部分失败         | 警告样式 + 部分数据展示         |

### 5.3 各边缘场景详细降级方案

#### 场景一：网络断开（Offline）

**UI 表现**：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ⚡ 网络已断开，当前显示本地缓存数据（最后更新: 2分钟前）  [🔄 重连]    │  ← 顶部固定横幅
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                         │
│  │  ⚪ Claude   │ │  ⚪ Codex    │ │  ⚪ Pi      │                         │
│  │  离线模式    │ │  离线模式    │ │  离线模式    │                         │
│  │  [查看缓存]  │ │  [查看缓存]  │ │  [查看缓存]  │                         │
│  └─────────────┘ └─────────────┘ └─────────────┘                         │
│                                                                             │
│  💾 离线队列: 2 个待同步任务  [📤 网络恢复后自动同步]                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**行为规范**：

- 用户输入的 Prompt 自动保存到 `localStorage`，网络恢复后自动恢复
- 显示“已保存到本地” / “同步中” / “已同步” 三种状态
- “并行执行”按钮置灰，Tooltip 提示“网络已断开，请连接后重试”
- 历史任务的 Diff 结果缓存在本地，离线仍可查看

#### 场景二：API 限流（Rate Limit - 429）

**UI 表现**：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ⚠️ API 限流中  │  Claude: 剩余 12/100 次  │  Codex: 已耗尽，2分钟后重置  │
│  建议: 降低并发数或等待限流恢复  [🔄 切换模型] [⏳ 稍后重试]              │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                         │
│  │  🟡 Claude   │ │  🔴 Codex    │ │  🟢 Pi      │                         │
│  │  限流警告    │ │  配额耗尽    │ │  正常运行   │                         │
│  │  剩余 12次   │ │  ⏱ 2:34 后重置│ │  进行中 67% │                         │
│  │  [切换模型]  │ │  [等待]      │ │  [查看]     │                         │
│  └─────────────┘ └─────────────┘ └─────────────┘                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

**行为规范**：

- 自动从任务中移除被限流的 Agent，继续执行其他 Agent
- 提供“切换模型提供商”入口（如从 Claude 切换到 DeepSeek）
- 限流错误自动使用指数退避策略重试

#### 场景三：Agent 执行失败（超时/错误码/认证失效）

**UI 表现**：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ⚠️ 部分 Agent 执行失败 (2/4 成功)                                         │
│  失败原因: Pi 执行超时 (300s)  │  oh-my-pi 返回错误: "API key invalid"    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐         │
│  │  🟢 Claude   │ │  🟢 Codex    │ │  🔴 Pi      │ │  🔴 oh-my-pi │         │
│  │  ✅ 完成     │ │  ✅ 完成     │ │  ❌ 超时    │ │  ❌ 失败     │         │
│  │  [查看Diff]  │ │  [查看Diff]  │ │  [重试]    │ │  [配置密钥]  │         │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘         │
│                                                                             │
│  [✅ 合并成功的 Agent]  [🔄 重试失败的 Agent]  [📋 查看全部日志]          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**行为规范**：

- 部分成功模式：成功的 Agent 结果仍然可用
- 断路器模式：同一 Agent 连续失败 5 次后，30 秒内不再调用
- 缓存回退：若有缓存结果，展示并标注“⚠ 缓存数据”

#### 场景四：DSH 插件加载失败

**UI 表现**：启动时显示“部分功能不可用”面板，明确列出可用和不可用功能，提供“查看详情”、“重新加载”、“复制错误报告”和“继续使用可用功能”按钮。

### 5.4 边缘状态视觉规范

| 状态                   | 主色              | 图标        | 横幅位置       | 用户操作                        |
| :--------------------- | :---------------- | :---------- | :------------- | :------------------------------ |
| **Loading**      | 品牌蓝`#1A8CD8` | 🔄 旋转动画 | 内容区骨架屏   | 无（等待）                      |
| **Offline**      | 琥珀`#F59E0B`   | ⚡          | 顶部固定       | “重连”按钮                    |
| **Rate-limited** | 琥珀`#F59E0B`   | ⏱️        | Agent 卡片内   | 倒计时 + “切换模型”           |
| **Error**        | 赤红`#EF4444`   | ❌          | 内容区错误卡片 | “重试”按钮                    |
| **Degraded**     | 琥珀`#F59E0B`   | ⚠️        | 内容区顶部     | “重试失败部分” + “跳过继续” |
| **Auth-failed**  | 赤红`#EF4444`   | 🔐          | Agent 卡片内   | “更新密钥”按钮                |
| **Empty**        | 灰色`#9CA3AF`   | 📭          | 内容区         | 操作引导 CTA                    |

### 5.5 实现参考

**网络状态监听**：

```typescript
import { useOffline } from 'next/client';
function HelmsmanApp() {
  const isOffline = useOffline();
  return (<>{isOffline && <OfflineBanner />}<Dashboard data={isOffline ? cachedData : liveData} /></>);
}
```

**错误边界**：

```typescript
class HelmsmanErrorBoundary extends React.Component {
  componentDidCatch(error, errorInfo) { this.setState({ hasError: true, error }); }
  render() { if (this.state.hasError) return <DegradedFallback error={this.state.error} />; return this.props.children; }
}
```

**缓存回退模式**：

```typescript
async function fetchWithFallback<T>(cacheKey: string, fetcher: () => Promise<T>): Promise<{ data: T; fromCache: boolean }> {
  try {
    const data = await fetcher();
    localStorage.setItem(cacheKey, JSON.stringify(data));
    return { data, fromCache: false };
  } catch (error) {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return { data: JSON.parse(cached), fromCache: true };
    throw error;
  }
}
```

## 六、可选增强插件

| 插件                           | 用途                               | GitHub 地址                              | 安装方式                                          |
| ------------------------------ | ---------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| **`dsh-llm-failover`** | 限流或配额耗尽时自动切换模型提供方 | https://github.com/HB00/dsh-llm-failover | `dsh plugin --profile web add dsh-llm-failover` |
| **`dsh-doctor`**       | 插件升级与排障工具                 | https://github.com/bruc3van/dsh-doctor   | `npx skills add bruc3van/dsh-doctor`            |

## 七、安全审计要求

ZCode 在集成任何社区插件前，**必须执行以下安全检查**：

### 7.1 项目健康度检查

- [ ] 检查 `commits` 和 `releases` 更新频率，优先选择近期有维护的项目
- [ ] 检查 `Issues` 和 `Pull Requests`，确认无严重或未处理的安全问题
- [ ] 参考 `Stars` 和 `Forks` 数量评估社区活跃度

### 7.2 代码审计（重点检查以下高危模式）

- [ ] `child_process.exec` / `spawn` — 执行系统命令，确认参数可控
- [ ] `fs.writeFile` / `fs.readFile` — 文件读写，确认路径不可注入
- [ ] `http.request` / `fetch` — 网络请求，检查目标地址合法性
- [ ] `eval` / `Function` — 动态执行代码，**风险极高，原则上禁止**
- [ ] `process.env` — 环境变量读取，确认无敏感信息泄露

### 7.3 依赖审查

- [ ] 检查 `package.json` 中的 `dependencies`，警惕来源不明、版本过旧或命名可疑的包

### 7.4 沙箱验证

- [ ] 先在测试 profile 中安装插件，观察行为，确认无误后再用于正式环境

## 八、开发步骤（ZCode 执行顺序）

### 第 1 步：安装依赖的社区插件（不要自己重写！）

```bash
dsh plugin --profile web add github:KevinWen7415/dsh-virtual-workspace
dsh plugin --profile web add https://github.com/MoonlitDropOfBlood/dsh-memory-manager/releases/download/v1.2.0/dsh-memory-manager-1.2.0.tgz
dsh plugin --profile web add github:lovezi0/dsh-memory-palace
dsh plugin --profile web add dsh-llm-failover          # 可选
npx skills add bruc3van/dsh-doctor                      # 可选
```

### 第 2 步：创建 Helmsman 自己的插件（使用脚手架）

```bash
npx create-dsh-plugin @helmsman/orchestrator -t tool
npx create-dsh-plugin @helmsman/adapter-claude -t tool
npx create-dsh-plugin @helmsman/adapter-codex -t tool
npx create-dsh-plugin @helmsman/adapter-pi -t tool
npx create-dsh-plugin @helmsman/adapter-oh-my-pi -t tool
npx create-dsh-plugin @helmsman/ui-dashboard -t webui
npx create-dsh-plugin @helmsman/ui-diff -t webui
npx create-dsh-plugin @helmsman/bundle -t events

# 注意：@helmsman/worktree 和 @helmsman/memory-topology 是封装层，手动创建
```

### 第 3 步：实现封装层插件

```bash
mkdir @helmsman/worktree && cd @helmsman/worktree
# 编写 index.ts，封装 dsh-virtual-workspace 为 Helmsman API

mkdir @helmsman/memory-topology && cd @helmsman/memory-topology
# 编写 index.ts，扩展记忆模型 + 新增扫描器
```

### 第 4 步：实现核心插件（按顺序）

1. `@helmsman/orchestrator` — 多 Agent 调度引擎
2. `@helmsman/adapter-*` — 4 个 Agent 适配器
3. `@helmsman/ui-dashboard` — Dashboard UI（**严格遵循第 4 章规范**）
4. `@helmsman/ui-diff` — Diff 对比 UI（**严格遵循第 4 章规范**）

### 第 5 步：构建与安装

```bash
pnpm run build
dsh plugin --profile web add ./@helmsman/worktree
dsh plugin --profile web add ./@helmsman/memory-topology
dsh plugin --profile web add ./@helmsman/orchestrator
# ... 依次安装，或安装 bundle
dsh plugin --profile web add ./@helmsman/bundle
```

### 第 6 步：测试验证

```bash
dsh web --profile web
dsh --dump-config          # 验证所有插件加载成功
dsh --profile headless "使用 Helmsman 执行任务：..."
```

### 第 7 步：安全审计

- [ ] 对社区插件执行第 7 章的安全审计
- [ ] 对自研插件执行代码审查
- [ ] 在测试 profile 中验证所有功能

### 第 8 步：克隆参考项目（仅用于研究）

```bash
# 仅用于学习设计思想，不直接复用代码
git clone https://github.com/kalifun/helmsman.git
git clone https://github.com/GZX2211/dsh-Visual-Workflow.git
```

## 九、交付物清单

| 交付物                         | 类型       | 代码量     | 说明                          |
| ------------------------------ | ---------- | ---------- | ----------------------------- |
| `@helmsman/worktree`         | 封装层插件 | ~150-200行 | 调用`dsh-virtual-workspace` |
| `@helmsman/memory-topology`  | 封装层插件 | ~200-300行 | 扩展`dsh-memory-manager`    |
| `@helmsman/orchestrator`     | 核心插件   | ~400-600行 | 参考`dsh-Visual-Workflow`   |
| `@helmsman/adapter-claude`   | 适配器     | ~80-120行  | 从零开发                      |
| `@helmsman/adapter-codex`    | 适配器     | ~80-120行  | 从零开发                      |
| `@helmsman/adapter-pi`       | 适配器     | ~80-120行  | 从零开发                      |
| `@helmsman/adapter-oh-my-pi` | 适配器     | ~80-120行  | 从零开发                      |
| `@helmsman/ui-dashboard`     | UI 插件    | ~600-900行 | 遵循第 4 章 UI 规范           |
| `@helmsman/ui-diff`          | UI 插件    | ~500-700行 | 遵循第 4 章 UI 规范           |
| `@helmsman/bundle`           | 组合包     | ~20行      | 聚合所有插件                  |
| README + 文档                  | 文档       | —         | 安装、配置、使用说明          |
| 单元测试 + 集成测试            | 测试       | —         | 核心服务覆盖                  |
| 安全审计报告                   | 文档       | —         | 所有依赖插件的审计结果        |

**总代码量估算**：约 **2400-3400 行** Helmsman 专有代码

## 十、ZCode 执行指令（总结）

**请 ZCode 严格按照以下顺序执行：**

1. **阅读并理解本任务书的全部内容**（特别是第 4 章 UI 规范和复用策略）
2. **第 1 步**：安装依赖的社区插件，**不要自己重写这些插件**
3. **第 8 步**：克隆参考项目（仅用于研究设计思想，不直接复用代码）
4. **第 2 步**：使用 `create-dsh-plugin` 生成需要从零开发的插件骨架
5. **第 3 步**：实现封装层插件（内部调用社区插件 API）
6. **第 4 步**：从零开发 `orchestrator` + 4 个 `adapter-*` + 2 个 `ui-*`
7. **构建、安装、测试、审计**（第 5-7 步）

**遇到问题时**：

- 参考 `dsh-Visual-Workflow` 的编排架构
- 参考 `kalifun/helmsman` 的“任务即会话”设计
- 使用 `dsh --dump-config` 调试配置加载问题
- 使用 `dsh-doctor` 诊断插件问题
