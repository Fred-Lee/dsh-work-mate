# Add Lifecycle State Machine, Worktree and Wiki Links

## Why

同一项目并行多提案需要三层硬约束：流程不跳步（状态机）、环境自动隔离与回收
（worktree 生命周期）、知识沉淀入生命周期（WeKnora Wiki 关联）。核心思路：
环境隔离与流程纪律从开发者手动操作变为 WorkMate 编排层自动执行。

## What Changes

1. **八态状态机替换**：`draft → proposing → reviewing → ready → implementing →
   merging → archiving → archived`，`transition(id, to)` 校验相邻性与前置条件
   （不跳步），`advance(id)` 自动推进，相邻回退保持全程可逆。旧四态经 normalize
   映射迁移（draft→draft、reviewing→reviewing、executing→implementing、
   archived→archived）。
2. **PR 语义本地化**（design D1）：proposing/reviewing/merging 的进入条件用
   **git 合并检查**（分支存在 / is-ancestor main）替代 GitHub PR API——本地
   仓库（无远程）同样可用。
3. **worktree 生命周期**（`src/features/worktree/`）：`port-allocator.ts`
   （BASE_PORT + index*10 端口表，落 `$DSH_HOME/workmate/ports.json`）与
   `manager.ts`（创建四件事：串行锁下 `git worktree add` → .env 注入端口 →
   gitignore 配置文件复制 → `pnpm install`（无 package.json 跳过）；清理：
   合并检查 → 释放端口 → `git worktree remove`）。ready→implementing 的
   transition 自动创建（记录 worktreePath/portRange 到提案），archived 达成
   自动清理。
4. **WeKnora Wiki 关联**（`src/features/wiki/`）：tasks.md 任务行支持
   `<!-- wiki: true; type: technical -->` 声明；Agent 经新工具
   `workmate_wiki_link` 登记 WeKnora 页面引用（URL/PageType/版本/提交），
   `workmate_wiki_links` 返回已登记清单；implementing→merging 的前置校验 =
   声明 wiki 的任务类型覆盖（technical→concept|synthesis，business→entity|
   concept）；归档编排生成 `wiki.md` 与 `commits.md` 随 change 入 archive。
   插件 `@wxg-prc-cpg/dsh-weknora@0.1.0` 已核实存在于 npm——但本机 profile
   未安装，**patch 暂不声明**（引用未安装插件断链 profile）；`weknora_search`
   等检索由 Agent 直接调用该插件工具，host 只做登记与校验。
5. **配置**：`basePort`(3000)/`portStep`(10)/`copyFiles`(['.env','.env.local'])/
   `packageManager`('pnpm')/`weknoraEnabled`(true)/`weknoraKbId`('')/
   `weknoraWikiRequired`(false)。
6. **面板**：卡片显示当前状态与下一步动作提示、worktree 路径与端口、「推进」
   按钮（advance）、Wiki 关联分组展示。

## Capabilities

### 新增能力

- `lifecycle-state-machine`：八态转换与前置校验。
- `worktree-lifecycle`：端口分配、创建四件事、串行锁、清理回收。
- `wiki-links`：wiki 任务声明、引用登记、类型覆盖校验、归档 wiki.md/commits.md。

### 修改能力

- `proposal-middleware`：状态字段迁移与 REST/工具/面板适配。

## Impact

- 新增 `state-machine.ts`、`worktree/{manager,port-allocator}.ts`、`wiki/links.ts`；
  `store/service/api/index` 大面积适配；client 卡片重排。
- **cordis.patch.yml 保持 workmate 一行**（swarm/mcp-client/weknora 均未实际
  安装进 profile，声明即断链）；三者各自的就绪路径写入 AGENTS.md。
- 归档编排新增 wiki.md/commits.md 生成与 worktree 清理步骤。
