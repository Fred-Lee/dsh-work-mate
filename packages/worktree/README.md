# @helmsman/worktree

Helmsman 的 Worktree 调度服务（封装层）。为每个「任务 × Agent」组合创建独立的
git worktree，使多个 Agent 可以在同一个仓库的隔离副本中并行修改代码；任务结束后
收集 diff、按需合并回主仓库、清理现场。

## 复用策略

按 PRD 要求复用社区插件 [`dsh-virtual-workspace`](https://github.com/KevinWen7415/dsh-virtual-workspace)：
当 profile 中已安装该插件（cordis 服务名 `vws`）时，每个创建的 worktree 会同步注册为
一个命名虚拟工作区，Agent 可通过 `vws` 工具以 `worktree-id:/相对路径` 的形式访问。
该集成是**惰性 + 尽力而为**的：`vws` 不存在或调用失败都不影响 worktree 核心功能。

## 提供的服务

```ts
ctx.get('helmsman.worktree') // WorktreeService
```

| 方法 | 说明 |
|------|------|
| `createWorktree({ taskId, agent, repoPath })` | 在根目录下创建 `git worktree`，分支名 `helmsman/<taskId>-<agent>`，记录 baseSha |
| `removeWorktree(id)` | 移除 worktree、删除分支、清理记录 |
| `listWorktrees(taskId?)` | 列出全部 / 某任务的 worktree |
| `getDiff(id)` | 收集 worktree 相对 baseSha 的全部变更（含未跟踪文件），按文件返回 unified diff 与增删行数 |
| `mergeWorktree({ worktreeId, files?, commitMessage? })` | 以 patch（stdin）方式把变更应用回主仓库并提交；失败时主仓库保持原状并返回冲突文件 |
| `removeTaskWorktrees(taskId)` | 清理某任务的全部 worktree |
| `getChangedRanges(id)` | 每个文件变更行号区间，用于多 Agent 冲突检测 |

## 配置

在 profile 的 `cordis.patch.yml` 中：

```yaml
- insert:
    - id: helmsman-worktree
      name: '@helmsman/worktree'
      config:
        rootDir: ~/.helmsman/worktrees
```

## 安全设计

- 所有 id / 分支 / 路径组件经过严格字符集校验（`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`）；
- worktree 路径强制限定在 `rootDir` 内（防路径穿越）；
- git 全程通过 `execFile` + argv 数组调用，**从不经过 shell**；合并 patch 通过 stdin 传入，不落临时文件。
