# @helmsman/adapter-claude

Claude Code 适配器。将 `helmsman.orchestrator` 分派的任务以 **非交互 print 模式**
在隔离的 git worktree 中执行：

```bash
claude -p "<prompt>" --output-format text   # cwd = worktree 路径
```

## 配置（可选）

```yaml
- id: helmsman-adapter-claude
  name: '@helmsman/adapter-claude'
  config:
    command: claude          # 二进制名
    args: ["-p", "{prompt}", "--output-format", "text"]  # {prompt} 占位符
    env: {}                  # 额外环境变量
```

## 语义约定

- **无 shell**：`spawn` + argv 数组，prompt 中的任何字符都不会被 shell 解释。
- **超时**：到达 `timeoutSec` 后先 SIGTERM、5s 后 SIGKILL，返回 `timedOut: true`；
  失败分类（超时/限流/认证失效）由 orchestrator 统一判定（单一事实源）。
- **取消**：监听 `AbortSignal`，取消时立即终止子进程。
- **流式输出**：stdout/stderr 实时经 `onOutput` 回调推送给 orchestrator 的任务日志。
