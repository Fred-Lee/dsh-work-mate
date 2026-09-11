# Helmsman 安全审计报告

- 日期：2026-09-03（Workbench 增量更新：2026-09-04）
- 范围：Helmsman 自研插件（13 个包）+ 3 个被复用的社区插件 + 依赖面
- 结论：**自研代码通过审计**；社区插件存在**中风险注意事项**（详见 §2），
  建议仅在受信任的个人/内网 profile 中使用，安装时保持第 7.1 节的检查习惯。

## 1. 自研插件代码审查（PRD §7.2 清单）

### 1.1 child_process（exec / spawn）

| 位置 | 方式 | 评估 |
|---|---|---|
| worktree `src/git.ts` | `execFile('git', args[])`，argv 数组 | ✅ 无 shell；超时/maxBuffer 上限 |
| worktree `src/service.ts`（merge） | patch 经 `proc.stdin.end()` 传入 `git apply` | ✅ 不落临时文件、不经 shell、不进 argv |
| adapter-* `src/index.ts` | `spawn(command, args[], {cwd: worktree})` | ✅ 无 shell；prompt 作为单个 argv 传入，**任何引号/分号/反引号都不会被解释** |
| adapter kill | SIGTERM → 5s 后 SIGKILL（`unref` 定时器） | ✅ 超时/取消都会终止子进程树 |

- 提示词注入面：agent CLI 收到任务 prompt 后**在其 worktree 内执行任意代码**，
  这是此类工具的固有属性（与直接使用 claude/codex 相同）。缓解：每个 agent
  独立 worktree，恶意/失控改动只存在于隔离副本，合并且显式操作 + 二次确认。
- 命令注入：adapter 的 `command`/`args` 来自 profile 配置（管理者可控），
  非 HTTP 输入；HTTP API 从不接受 command 字段。

### 1.2 文件读写

| 位置 | 评估 |
|---|---|
| worktree：id/branch 强制 `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`（`sanitizeSegment`），路径 `assertInsideRoot` 限定在 `rootDir` 内，拒绝 `..` 穿越 | ✅ 有测试覆盖 |
| topology store：文件名 `encodeURIComponent(group)`，CJK 安全；`normalizeTopology` 双侧清洗，坏 JSON 降级 null | ✅ |
| scan-rest：realpath 父目录比对，允许 macOS `/var→/private/var` 这类根符号链接，阻断根内部符号链接逃逸；深度 8 / 3000 文件 / 512KB 上限 | ✅ 有测试 |
| UI 静态服务：`normalize` + `startsWith(assetsDir)` 越界检查，403/404 | ✅ |
| knowledge-tolaria vault：路径由服务端配置/常量拼出（`~/.helmsman/vault/<固定子目录>/<id>.md`），归档接口对 `draftId` 强制 `^[a-z0-9-]+$` 校验，无用户可控路径段 | ✅ |
| workbench drafts/commands：仅读写 `~/.helmsman/workbench/` 下固定文件（`commands.json` 结构化清洗后落盘） | ✅ |

### 1.3 网络请求

- 自研插件**零直接出站网络调用**（无 fetch/http）。唯一网络面是
  `webServer.register` 的本地路由（dashboard/diff/workbench 的 REST API）。
- **Deep Research 豁免（Workbench 新增，显式声明）**：`@helmsman/ui-workbench`
  的生成引擎通过 `ctx.agents.create` 启动**DSH 原生 agent 会话**（挂 Helmsman
  预设）。模型推理请求由 **DSH 自身的 LLM 栈**发出——这与用户在 DSH 里正常
  聊天的外发完全同面、同凭据（用户自己配置的 provider/key），Helmsman 不新增
  任何网络端点、不接触密钥、不自带搜索工具。生成会话可选启用且需用户在面板
  显式触发。
- Tolaria vault 读写为**纯本地文件**（`~/.helmsman/vault/`），无 MCP/网络调用。

### 1.4 动态执行

- 无 `eval`、`new Function`、`vm`。✅
- `@helmsman/ui-workbench` 生成引擎在运行时 `import('@deepseek-ai/dsh-brand')`
  等 **harness 官方包**（createRequire 锚定 cwd 解析后动态 import）——仅加载
  宿主自带的官方模块，非任意代码执行面。

### 1.5 环境变量与敏感信息

- 只读取 `DSH_HOME`（尊重 DSH home 约定）与 `HELMSMAN_HOME`（存储路径覆盖），不记录、不上报。
- API 密钥完全由各 agent CLI 自行管理（DSH credentials 插件 / CLI 登录态），Helmsman 不接触密钥。

### 1.6 HTTP API 面

- Dashboard/Diff API 挂载在 DSH webserver（默认绑定 **127.0.0.1**）。
- 风险（中，缓解）：插件路由不经过宿主页面的浏览器 token 认证（与社区插件
  Visual-Workflow 的 GUI API 同一面）。同机任意本地进程可调用 API。**本变更已把
  「任意本机进程都能静默破坏舰队状态」这一部分关掉**：merge / discard / cancel /
  worktree 清理 / topology 删除等破坏性操作全部经过服务核心的两阶段确认门控
  （`request → decide → execute(一次性作用域令牌)`，`~/.helmsman/policy.json` 配置每类
  操作是 `confirm-required` 还是 `auto-grant`）；REST 路由、注册工具与内部服务调用都走
  同一个门控，无法绕过；令牌一次性、绑定操作+作用域、默认 300s TTL，过期/复用/换作用域
  均被拒绝。只读操作（任务状态/日志/事件时间线/冲突 dry-run/审计查询）不产生门控开销。
  剩余缓解：默认 loopback + 默认端口仅在 3080；不要以 `--host 0.0.0.0` 暴露
  （DSH 本身也拒绝 0.0.0.0）。多用户主机上建议用防火墙规则限制 3080 端口。
- **审计**：每个被门控的决定在副作用发生**之前** fsync 落盘到
  `~/.helmsman/audit/audit.jsonl`（追加式 JSONL），日志写不进去即中止该操作（fail-closed）；
  合并裁决载荷、headless 中止冲突清单与每次运行到达终态也追加记录。只有只读查询面
  （`GET /api/audit`），不存在追加/编辑/删除端点。
- 请求体上限 5MB（`readJsonBody`）；JSON 解析失败 → 500 JSON 错误，不崩溃。
- 无 CORS 头 → 浏览器同源策略天然阻止其他源读取响应。

### 1.7 依赖审查（PRD §7.3）

运行时依赖（`dependencies`）：

| 包 | 用途 | 评估 |
|---|---|---|
| `@deepseek-ai/dsh-tools`（orchestrator、memory-topology） | defineTool + 类型 | 官方 harness 包（0.1.1-rc.2），与宿主同源 |
| （其余 8 个包） | 无 | 零运行时第三方依赖 |

- React/esbuild/typescript/vitest 均为 devDependencies，只在构建期使用，
  **不进入 profile 安装树**（cross-package 类型引用用 `workspace:*` devDep，运行时
  只依赖 profile 内已安装的包）。供应链面极小。

## 2. 社区插件审计（PRD §7.1/7.2）

审计方式：GitHub 源码审阅（2026-09-03，main/master 分支）+ 本地沙箱 profile
（`helmsman-test`）安装观察。

### 2.1 dsh-virtual-workspace (KevinWen7415, v1.2.2)

- 高危模式扫描：有文件读写与状态文件 `<workspaceRoot>/.vws-workspaces.json`；
  工具带沙箱分级（`workspace-write` / 越界需 `sandbox_permissions` 一次性审批），
  写操作走会话沙箱边界与 DSH 审批流。**未发现 eval、无出站网络。**
- 注意（中）：`add-dir` 接受任意目录路径——把它注册进工作区的目录即对 agent
  可见。Helmsman 只以**程序生成的 worktree 路径**调用 `vws.add`，不受此影响。

### 2.2 dsh-memory-manager (MoonlitDropOfBlood, v1.2.0 tgz)

- 记忆写入范围限定 `$DSH_HOME/memories/`（projectKey 经过 `sanitizeSegment`）；
  无 shell、无 eval、无出站网络。前端设置页走 Typert RPC。
- 注意（低）：`importZCode` 默认读 `~/.zcode/cli/memories`——只读导入，可接受。

### 2.3 dsh-memory-palace (lovezi0, v1.6.2-alpha.4)

- 写入 `~/.deepseek-harness/MEMORY.md`、项目 `.deepseek-harness/`、桥接目录
  `.workbuddy/`；删除经 `tools/pre-execute` 硬闸门 + 原生确认弹窗；hybrid 重组织
  有双门禁。无 shell/eval/出站网络。
- 注意（低）：往项目目录写 `.deepseek-harness/` 与 `.workbuddy/` 桥接目录——
  对 monorepo 是新增的未跟踪目录，提交前注意 gitignore。

### 2.4 项目健康度（PRD §7.1 快检）

| 仓库 | 维护 | 安全 issue | 备注 |
|---|---|---|---|
| dsh-virtual-workspace | 活跃（1.2.2，有 releases） | 未发现 | 安装时要求 allowBuilds（prepare 脚本），pnpm 审批机制兜底 |
| dsh-memory-manager | 活跃（v1.3.3 已发布；本次按 PRD 固定 v1.2.0 tgz） | 未发现 | PRD 指定版本偏旧，升级时重新走一遍本审计 |
| dsh-memory-palace | 活跃（1.6.2-alpha.4） | 未发现 | peer 依赖版本与 harness alpha 线对齐警告，非安全问题 |

### 2.5 沙箱验证（PRD §7.4）

- 全部社区插件与 Helmsman 插件首先装入独立 profile `helmsman-test`（非 `web`），
  观察启动日志（各插件仅注册服务/工具，无异常外联）、`--dump-config` 输出与
  E2E 行为，验证通过后才建议进入日常 profile。

## 3. 威胁模型小结与缓解状态

| 威胁 | 缓解 |
|---|---|
| 恶意/失控 agent 破坏主仓库 | worktree 隔离 + 显式合并（`git apply` 原子，冲突不动主仓库，headless 遇真实冲突整体中止）+ `discardTask` 清理；合并/放弃等破坏性操作经两阶段确认门控并写审计 |
| 提示词注入让 agent 泄露本机文件 | 文件仍受运行 agent 的常规沙箱/审批约束（DSH 沙箱策略 + 各 CLI 权限系统）；Helmsman 不放大权限（不传 `--dangerously-skip-permissions` 类参数） |
| 本地非浏览器进程滥用 API | loopback 绑定 + **代码级确认门控**（confirm-required 操作需一次性作用域令牌，工具/REST/内部调用统一强制）+ 审计日志 fail-closed；文档明确多用户主机限制 |
| 依赖投毒 | 零第三方运行时依赖；devDeps 锁定 semver 范围；社区插件仅 3 个且经审计 |
| 路径穿越 / 计划任务注入 | 字符集白名单 + realpath + normalize；无 cron/定时器注册 |
| 生成引擎递归分叉（生成的 agent 调 helmsman_* 生成工具 → 无限 fork 会话烧 token） | AsyncLocalStorage 递归闸门：生成 turn 内的嵌套调用直接拒绝并返回自解释错误（实测模型收到后改为自己作答）；单 turn 240s 超时熔断 + agent.cancel。实测修复前曾 fork 100+ 会话，修复后单会话稳定完成 |
| DSH client 模块注入面（ui-workbench client bundle 进网页壳） | bundle 只含自家组件与样式注入，经 slot 系统声明式注册（`shell.overlay`/`sidebar.footer.action`），不触碰页面其他区域；模块表 externals 仅 react/cordis 官方行 |

## 4. 遗留建议

1. `pi` / `oh-my-pi` 适配器默认参数按常见 CLI 约定预设，正式使用前确认实际
   二进制的非交互 flag（在 profile patch 中覆盖 `command`/`args`）。
2. 若需将 Helmsman API 暴露给非本机使用，务必前置反向代理加认证。
3. 社区插件升级时重跑 §2 的检查（commits/releases、高危模式 grep、
   `pnpm audit`）。
