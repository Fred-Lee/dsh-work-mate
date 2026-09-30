# Design — Harden DSH Plugin Fit

## D1 可选服务一律 `ctx.inject([...])`，不用 `ctx.get`

`ctx.get(name)` 是**一次性快照**：在 `apply` 期间取不到就永久错过（profile 装载顺序不保证
webServer 一定先于本插件就绪）。第一方惯例是 reactive inject——`ctx.inject(['connection',
'webServer'], …)`（`packages/api/gateway/src/index.ts:239`），依赖就绪时回调执行、缺失时
回调不执行且不阻塞主 fiber。

因此：

```ts
export const inject = ['tools'] as const            // 常驻：agent 工具面
…
ctx.inject(['webServer'], (scope) => {
  mountWorkmateApi(scope.get('webServer') as WebServerLike, deps)
})
```

客户端同理：`export const inject = [] as const`，tab 走 `ctx.inject(['betterSidebar'], …)`，
两个 slot 入口走 `ctx.inject(['slots'], …)`——三者互不牵连。

> 兼容性：cordis `inject(deps, callback)` 在缺失依赖时不执行回调但**不 park 父 fiber**，
> 所以 `inject = ['tools']` 的宿主半在任何 profile 都 ACTIVE。

## D2 `openspecRoot` 走依赖注入，默认值保留在服务内部

`LifecycleDeps.openspecRoot?: string`，服务内部 `get openspecRoot()` 回落 `'openspec'`。
这样：`src/index.ts` 传 `resolved.openspecRoot`（真实修复），既有嵌入方（测试、其他宿主）
不传也不会炸。替换点共 5 处（proposing 前置校验、merging 的 `readWikiTasks`、archiving 的
changeDir、`runArchive` 的 orchestrate options）——全部同一来源，不允许再出现字面量。

## D3 注册表 fail-closed：复用 `StoreCorruptError`

`ProjectRegistry.read()` 与 `ProposalStore.load()` 采用同一套语义：`ENOENT` → `[]`；其他
读错误 → 抛出；JSON 非法或非数组 → `StoreCorruptError`。写路径（`upsert`/`remove`）先读后写，
读失败即写失败，因此损坏文件永不被覆盖。

代价：`projects.json` 损坏时 `list()` 会对 UI/工具报错，而不是显示"未注册"。这是有意的——
注册表是用户手工积累的数据，静默清空比报错严重得多（board warmUp 教训）。

`mkdir(join(file, '..'))` 顺带改为 `dirname(file)`。

## D4 面板流转：状态机仍是唯一真源

服务端 `buildProposalStatus` 增加 `lifecycle: { status, hint, prev?, next? }`（由
`state-machine.ts` 的 `PROPOSAL_STATES` 派生，新增 `prevState()`），客户端不再自己复制
八态顺序。面板按 `prev/next` 渲染「‹ 回退到 X / 推进到 Y ›」，`archiving` 额外给
「完成归档」，上一次归档失败（错误里含审查门/编排信息）时给「强制归档」。

`force` 的语义：只跳过**审查门**（`review.md` 缺失或存在未解决 CRITICAL），不跳过
openspec archive 与 gitnexus 步骤，也不改变"仅 archiving 可归档"的前置。REST body
`{force: true}` 与工具参数 `force` 是同一开关，落到
`orchestrateArchive(..., { reviewGate: false })`。

## D5 回退即真实回退：`archived → archiving` 触发 `orchestrateReopen`

`orchestrateReopen` 此前从未被调用（死代码），导致状态回退后 change 目录仍留在
`changes/archive/`。现在 `transition` 在 `direction === 'backward' && from === 'archived'`
时调用它，步骤写进 `TransitionOutcome.orchestration`（REST 与工具都会返回）。
`orchestrateReopen` 自身"永不抛"的约定保持不变：目录搬回失败只记录 `skipped`/`failed`
步骤，**不阻断状态回退**（状态字段是最不该丢的东西）。

## D6 取消传导：只声明能兑现的 `timeoutMs`

`defineTool` 文档明确：声明 `timeoutMs` 即断言该工具把 `exec.signal` 转发给可协作的
实现。因此本变更先把 signal 打通，再声明超时：

| 层 | 改动 |
|---|---|
| `worktree/git.ts` | `gitExec(args, cwd, timeoutMs, signal?)` |
| `worktree/manager.ts` | `create({signal?})` / `remove({signal?})`，`runCommand` 转发 signal（pnpm install） |
| `knowledge-bridge/gitnexus.ts` | `gitnexusRun` / `gitnexusAnalyze` 接受 signal |
| `knowledge-bridge/weknora.ts` | `fetch` 接受 signal |
| `archive/orchestrate.ts` | `execCli(..., signal?)`；options 增加 `signal?` |
| `archive/service.ts` | `advance/transition/runArchive(id, { signal?, force? })` |
| `index.ts` | `execute(args, exec)` 把 `exec.signal` 传下去 |

只在这些工具上声明 `timeoutMs`（值取各层既有超时之和 + 余量）：
`workmate_proposal_archive`（worktree create 含 install 默认 300s + openspec archive 60s +
gitnexus 120s → 15 分钟）、`workmate_knowledge_query`（120s）。纯 fs 工具不声明——
不声明就是"无 deadline"，比虚报一个无法兑现的预算诚实。

`isConcurrencySafe: () => true` 只给只读工具：`workmate_proposal_status`、
`workmate_wiki_links`、`workmate_knowledge_query`、`workmate_knowledge_search`。写工具保持
默认（独占），因为 `proposals.json` 是读改写单文件。

## D7 非目标（本变更明确不做）

- `Config` 改 Schemastery（需新依赖 `@deepseek-ai/schemastery`，且要找一条与 alpha.5
  共存的版本矩阵）——留给后续变更。
- 质量资产从 `.claude/**` 迁到 DSH skill provider（会改变用户项目里的既有行为，需要单独
  的迁移与验收）。
- REST 改原生 `@Remote`/`ctx.remote` RPC（需要 rc 线类型包，架构替换级别）。
- 归档编排改原生 jobs。
- 渲染意图（`presentCall`/`presentResult`）：需要设计每张卡片的形状，单独做。
