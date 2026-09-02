# Helmsman 使用手册

## 1. 日常工作流

1. **创建项目群**：Dashboard 左上 ⚙️ → ➕ 新建 → 填名称（如「订单中台」）。
2. **登记服务**：服务列表 → ➕ 添加服务 → 填服务名与本地 git 仓库路径 →
   🔄 扫描 API（自动发现 Spring/NestJS/Express 端点）→ 💾 保存。
   也可以 📥 导入 docker-compose.yml / K8s manifest / OpenAPI JSON 批量创建。
3. **派发并行任务**：新任务卡输入 Prompt → 勾选 Agent（未安装的会标注 ⚠️）→
   ▶ 并行执行。每个 Agent 在主仓库的独立 `git worktree` 中执行互不干扰。
4. **观察执行**：Agent 卡片实时显示状态机（准备环境 → 执行中(计时+日志) →
   完成/失败/超时/限流），进度条与超时倒计时同步。
5. **对比与合并**：完成的卡片点击「查看Diff」进入对比视图：
   - 左右并排 / 统一格式 / 多 Agent 并排三种视图；
   - ⚡ 冲突文件给出方案选择（采用某个 Agent / 手动）；
   - 💬 行级评论（存本地 localStorage）；
   - 底部操作：✅ 合并单个 Agent、🔀 合并所选文件、❌ 全部放弃。

## 2. 状态参考

### Agent 卡片状态

| 状态 | 含义 | 可用操作 |
|---|---|---|
| ⚪ 待命 | worktree 已创建，排队中 | — |
| 🔄 执行中 | agent CLI 正在运行（计时/流式日志） | ✕ 取消 |
| ✅ 完成 | 退出码 0，diff 已收集 | 查看Diff |
| ❌ 失败 | 非零退出（错误摘要见卡片） | 重试 |
| ⏰ 超时 | 超过 timeoutSec（默认 300） | 重试 |
| ⏱️ 限流中 | CLI 报 429/rate limit，自动指数退避重试（最多 3 次） | 稍后重试 |
| 🔐 认证失效 | 401/invalid api key，不自动重试 | 配置密钥后重试 |

### 任务级状态

`CREATING_WORKTREES → RUNNING → AGGREGATING → COMPLETED | PARTIAL_FAILED | ALL_FAILED`
（RUNNING 中可取消 → CANCELLED）。部分失败时成功的 Agent 结果照常可用。

## 3. Agent 工具（headless 驱动）

Helmsman 同时注册了一组 agent 工具，可以在 `dsh --profile <p> "…"` 会话里直接指挥舰队：

- `helmsman_run_parallel {prompt, agents, projectGroupId?, repoPath?, cascade?, timeoutSec?}`
- `helmsman_task_status {taskId, withLog?}`
- `helmsman_cancel_task {taskId}`
- `helmsman_merge_task {taskId, mode?: merge|discard, agents?, files?, discardAfterMerge?}`
- `helmsman_topology_get_downstream {projectGroupId, serviceId}`
- `helmsman_topology_scan_rest_apis {localPath}`
- `helmsman_topology_list_groups`

示例：`dsh --profile headless "使用 Helmsman 执行任务：用 claude 和 codex 并行给 user-service 加一个修改密码接口，然后合并 claude 的结果"`。

## 4. 配置

所有插件都接受 profile patch 层的 config 覆盖（`~/.dsh/profiles/<p>/cordis.patch.yml`，
同 id 行 = 覆盖配置，改完自动热重载）：

```yaml
# 覆盖 claude 适配器的命令与参数
- id: helmsman-adapter-claude
  config:
    command: claude
    args: ["-p", "{prompt}", "--output-format", "text"]
    env: {}

# orchestrator 策略
- id: helmsman-orchestrator
  config:
    defaultTimeoutSec: 300
    maxRateLimitAttempts: 3
    circuitBreakerThreshold: 5
    circuitBreakerCooldownMs: 30000

# worktree 存储位置
- id: helmsman-worktree
  config:
    rootDir: ~/.helmsman/worktrees

# dashboard 挂载路径
- id: helmsman-ui-dashboard
  config:
    mountPath: /helmsman-dashboard
```

数据目录：`~/.helmsman/topologies/`（项目群 JSON）、`~/.helmsman/worktrees/`
（任务 worktree，任务合并/放弃后自动清理）。

## 5. 验证安装

```bash
dsh --profile web --dump-config | grep helmsman      # 9 个 helmsman-* 条目
curl -s localhost:3080/helmsman-dashboard/api/state  # {"groups":[...],"agents":{...}}
open http://127.0.0.1:3080/helmsman-dashboard/
```

深链参数：`?panel=config` 直接打开配置面板；`?theme=dark` 强制暗色。

## 6. 常见问题

- **提示「no repoPath」**：项目群下没有任何服务配置 localPath；在配置面板给
  服务填本地 git 仓库路径，或调用工具时直接传 `repoPath`。
- **「⚠️ 未安装」**：对应 agent CLI 未在 PATH 中（`claude` / `codex` / `pi` /
  `oh-my-pi`）；安装后刷新页面。
- **限流**：被限流 Agent 自动退避重试；也可在配置面板调整策略，或先只勾选
  未限流的 Agent。
- **合并冲突**：`git apply` 失败时主仓库保持原状；在 Diff 视图用冲突方案选择
  （只采纳一个 Agent 的冲突文件）后重新「合并所选」。
