# Design — Add Lifecycle State Machine, Worktree and Wiki Links

## D1 PR 语义本地化

proposing/reviewing/merging 的进入条件按指令是「PR 已提交/已合并」，但 WorkMate 的
真实环境常为本地仓库（无远程、无 PR）。进入条件统一用 **git 合并事实**：

- proposing：openspec change 目录存在且 `proposal.md` 可读（提案文件已生成）。
- reviewing：提案分支存在（`git rev-parse --verify` 通过）。
- ready：提案分支是 main 的祖先（`git merge-base --is-ancestor <branch> main`）
  ——分支内容已进 main（merge/rebase/fast-forward 皆可），本地 merge 即等效 PR 合并。
- merging：实现分支（提案记录的 featureBranch）是 main 的祖先。

有 gh CLI 的项目未来可叠加 PR 状态检查，本变更不引入远程依赖。

## D2 状态机形状

相邻转移矩阵（前进 + 回退均合法，前进校验前置，回退自由）：
`draft↔proposing↔reviewing↔ready↔implementing↔merging↔archiving→archived`
（archiving→archived 前进 = 归档编排成功；archived 相邻回退到 archiving 等价
既有 reopen 语义，保留）。跳步 = 非相邻转移，拒绝并给出相邻目标提示。
旧四态迁移：draft→draft、reviewing→reviewing、executing→implementing、
archived→archived（normalize）。

## D3 worktree 实现纪律

- **串行锁**：WorkMate 是宿主内单进程插件，进程内 promise 链式 mutex 即可
  （跨进程不存在）；`.git/config` 竞争来自并发 `git worktree add`，mutex 保证
  创建段串行，创建完成后的执行/提交天然并行。
- **端口表**：`ports.json`（`{ [proposalId]: { base, ports: number[] } }`），
  分配 `basePort + index * portStep` 的 portStep 个端口段；清理释放；分配前
  扫描已用偏移取第一个空闲 index。
- **.env 注入**：worktree 根 `.env` 追加 `WORKMATE_PORTS=...,WORKMATE_PROPOSAL=...`
  （已有 .env 追加不覆盖；无则创建）。配置复制清单 `copyFiles` 从主工作区逐个
  复制（缺失跳过并记录）。
- **install**：`<pm> install` 仅当 worktree 内存在 package.json；超时 300s；
  失败记录进提案（不阻断 worktree 创建——环境问题由面板提示）。
- worktree 路径：`<项目根>/.workmates/<proposal-id>`（gitignore 由 manager 追加）。

## D4 WeKnora 集成边界（对指令的修正）

1. **插件与 patch**：`@wxg-prc-cpg/dsh-weknora@0.1.0` 已核实存在于 npm 且自带
   bundle 声明（id: weknora，配置走 WEKNORA_* 环境变量）。但本机 profile 未安装
   ——patch 声明未安装插件会断链 profile 装载（Helmsman 契约笔记 A 级教训），
   故 **patch 暂不声明**；启用路径（`dsh plugin --profile web add`）写入 AGENTS.md。
2. **host 不调用 WeKnora 工具**：`weknora_search` 等四个是注册给 Agent 的会话内
   工具，host 进程无法调用。指令三.7 的「调用 weknora_search 检索」改由 Agent
   在会话中执行；host 的职责是：解析 tasks 的 wiki 声明 → 校验登记引用的类型
   覆盖 → 归档生成 wiki.md。检索不到/服务不可用时记录警告，不阻断
   （`weknoraWikiRequired=true` 时 merging 前置校验从严：无引用即失败）。
3. **引用登记**：`workmate_wiki_link`（proposalId + url + pageType + version +
   commit? + taskId?）→ 存入 `proposal.wikiLinks`；校验 pageType ∈
   {concept, synthesis, entity}；类型覆盖检查在 implementing→merging。

## D5 归档编排扩展

archiving 状态的编排（transition 到 archived 时触发）在现有步骤上追加：
- `commits.md`（关联提交清单，复用关联扫描）与 `wiki.md`（已登记引用按
  技术方案/业务规则分组）写入 change 目录，随 openspec archive 入 archive/。
- worktree 清理（若提案记录了 worktreePath）：合并确认 → 释放端口 → remove。
- GitNexus 重建与审查门保持既有位置（review-gate / openspec-archive /
  gitnexus-analyze）。

## D6 配置与响亮失败

新增配置经 `resolveConfig` 默认值补全；`weknoraKbId` 为空且
`weknoraWikiRequired=true` 属矛盾配置，apply 时 console.error 响亮提示
（不抛——宿主配置错误中断整个 profile 装载的代价过大，M1 已验证形态）。
