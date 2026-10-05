# lifecycle-state-machine Specification

## Purpose
TBD - created by archiving change add-lifecycle-worktree-wiki. Update Purpose after archive.
## Requirements
### Requirement: 八态生命周期状态机

提案 SHALL 遵循 `draft → proposing → reviewing → ready → implementing → merging
→ archiving → archived` 八态生命周期：`transition(id, to)` SHALL 拒绝非相邻转移
（不跳步），前进转移 SHALL 校验前置条件（proposing：提案文件存在；reviewing：
提案分支存在；ready：提案分支已合并进 main；implementing：worktree 已创建；
merging：wiki 声明类型已覆盖；archiving：实现分支已合并进 main；archived：归档
编排成功），相邻回退 SHALL 允许（全程可逆）。旧四态记录 SHALL 经 normalize
迁移。REST SHALL 提供 `POST /:id/advance` 与 `POST /:id/transition`；工具
`workmate_proposal_archive` 的 mode SHALL 接受目标状态名。

#### Scenario: 跳步被拒

- **WHEN** 从 proposing 直接 transition 到 implementing
- **THEN** 400 并提示相邻合法目标

#### Scenario: 前置校验阻断

- **WHEN** 提案分支未合并进 main 时推进 reviewing→ready
- **THEN** 转换失败并说明「等待提案分支合并进 main」

### Requirement: worktree 生命周期自动管理

ready→implementing 的转换 SHALL 自动创建 worktree 并完成四件事（串行锁下
`git worktree add`、端口注入 .env、copyFiles 配置复制、包管理器安装——无
package.json 跳过），worktreePath/portRange/featureBranch SHALL 记录到提案；
archived 转换 SHALL 自动清理（合并确认 → 释放端口 → `git worktree remove`）。
端口分配 SHALL 保证并发创建互不冲突（BASE_PORT + 空闲 index * portStep），
创建段 SHALL 串行化。

#### Scenario: 并发创建端口互斥

- **WHEN** 同项目依次创建 3 个提案的 worktree
- **THEN** 三份端口段互不相同且被记录

#### Scenario: 归档后回收

- **WHEN** 提案进入 archived
- **THEN** `git worktree list` 不再含该 worktree，端口表中条目被释放

### Requirement: WeKnora Wiki 关联

tasks.md 任务 SHALL 可声明 `<!-- wiki: true; type: technical|business|both -->`；
Agent 经 `workmate_wiki_link` 登记 WeKnora 页面引用（url/pageType/version/commit/
taskId），pageType SHALL ∈ concept|synthesis|entity。implementing→merging 的
前置校验 SHALL 确认每个声明 wiki 的任务已有引用且类型覆盖
（technical→concept|synthesis；business→entity|concept）。归档编排 SHALL 生成
`wiki.md`（按技术方案/业务规则分组）与 `commits.md` 写入 change 目录。
WeKnora 服务不可用时 SHALL 记录警告；`weknoraWikiRequired=false` 且未配置
知识库时 SHALL 跳过关联检查。

#### Scenario: 类型覆盖校验

- **WHEN** 任务声明 wiki_type: technical 但只登记了 entity 页面
- **THEN** merging 转换被拒并列出缺失类型

#### Scenario: 归档留痕

- **WHEN** 提案完成归档
- **THEN** `changes/archive/<date>-<id>/` 内出现 wiki.md 与 commits.md

