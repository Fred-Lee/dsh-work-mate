# WorkMate 插件 DSH 适配度评估

**评估对象**：`workmate4dsh@0.1.0`（`feat/workmate` @ `4b359b2`）
**宿主基线**：本机 harness 源码树 `0.1.7-rc.2`（`/Users/fredlee/Documents/workspace/deepseek-harness`），
profile `web` 实装 `@deepseek-ai/dsh-tools@0.1.2-alpha.5`（见 `toolchain.json`）
**评估日期**：2026-09-30

---

## 0. 结论

功能面完整、工程纪律好（5,940 行源码、71 个测试全绿、typecheck 干净、原子写 + fail-closed
存储、契约门禁齐备）。**问题不在"做得少"，而在"适配层停留在 Helmsman 时代"**：宿主与 UI
的通道是自建 HTTP + `fetch` + 5 秒轮询 + 手写 ambient 类型，而 DSH 现在提供的是
**类型化 RPC（`@Remote` / `ctx.remote`）、原生 jobs、skills provider、systemPrompt 贡献、
Schemastery `Config`、声明式 slot 契约**。四条 P0 不是风格问题，是会真实掉功能的缺陷：

1. `inject = ['tools', 'webServer']` → **非 web profile 下 10 个 agent 工具全部不可用**；
2. 客户端 `inject = ['betterSidebar']` → **第三方侧栏插件缺失时对话入口一起消失**；
3. `Config` 只有类型没有运行时值 → **宿主既不做校验，也不出配置 UI**；
4. `Config.openspecRoot` 在生命周期路径上被硬编码 `'openspec'` 覆盖 → 配置改了不生效。

---

## 1. 验证基线

| 项 | 结果 | 证据 |
|---|---|---|
| `pnpm typecheck` | 通过（host + client 两个 program） | 本机执行 |
| `pnpm test` | 14 files / 71 tests 全绿，3.56s | 本机执行 |
| 客户端半声明形态 | **正确**：`dsh.client.platform === 'web'` + `exports["./client"]` 与宿主加载器完全一致 | `/Users/.../deepseek-harness/packages/client/modules/src/index.ts:839-847` |
| bundle 声明 | 正确：`dsh.bundle.patch` + `cordis.patch.yml` 单条 insert | AGENTS.md 契约段 |
| `$DSH_HOME` 解析 | **与宿主一致**：宿主 `DSH_HOME_ENV = 'DSH_HOME'`、默认 `~/.dsh` | `/Users/.../deepseek-harness/packages/util/home-paths/src/index.ts:18,61`；`src/features/proposal/store.ts:86-88` |

> AGENTS.md 里"env 名待与宿主 `dsh-home-paths` 核对"这条**可以结案**：`DSH_HOME` 正确，
> 默认目录 `.dsh` 也一致。
>
> `dsh.plugin.json`（`dsh-outline` 等社区包里有）在宿主全仓**零引用**，不是宿主要求，
> 不必补。

---

## 2. P0 — 宿主适配缺陷（真 bug，建议先修）

### P0-1 工具面耦合 web UI：非 web profile 下 10 个工具全部消失

`src/index.ts:37`：

```ts
export const inject = ['tools', 'webServer'] as const
```

`webServer` 由 `@deepseek-ai/dsh-host-webserver` 提供，而它**只在 web-app bundle 里装载**：

```
headless  webserver:0    acp-app  webserver:0
sdk-app   webserver:0    sdk-minimal webserver:0
web-app   webserver:3    ← 唯一提供方
```
（`/Users/.../deepseek-harness/packages/bundle/{headless,acp-app,sdk-app,sdk-minimal,web-app}/cordis.patch.yml`；
服务定义在 `packages/host/webserver/lib/types/index.d.ts:17`）

cordis 的 `inject` 是硬依赖，缺失即 fiber 永久 PENDING（AGENTS.md 契约段自己写了这条）。
后果：headless / acp / sdk / 任何不带 web 的 profile 里，**`workmate_*` 10 个工具一个都不注册**——
agent 侧完全看不到 WorkMate，与 UI 是否可用无关。

**修法**：`export const inject = ['tools'] as const`，UI 面惰性挂载：

```ts
const webServer = ctx.get('webServer')
if (webServer) mountWorkmateApi(webServer as ..., deps)
```

### P0-2 客户端半硬依赖第三方侧栏插件

`src/client/index.tsx:23`：`export const inject = ['betterSidebar'] as const`

`betterSidebar` 是社区插件 `dsh-better-sidebar@0.22.1` 注册的服务（其 `lib/types/client/service.d.ts:4-6,451-454`），
**不是 DSH 一等服务**。它一旦被停用/未装/改名，workmate 的整个 client half 永久 PENDING——
包括只依赖一等 `slots` 的「🚀 转为提案」两个对话入口（`src/client/index.tsx:36-62`）。

**修法**：client 半零硬依赖；tab 走 `ctx.inject(['betterSidebar'], …)` 惰性注册，slots 两个入口
无条件注册（两者互不牵连）。若想彻底摆脱第三方依赖，可改用一等座位
`shell.overlay`（`dsh-outline` 的做法：`~/.dsh/profiles/web/node_modules/dsh-outline/src/client/index.tsx:8-11,34`）。

### P0-3 `Config` 没有运行时值 → 无校验、无配置 UI

`src/index.ts:39-40` 只有 `export type`：

```ts
export type { Config, ResolvedConfig } from './config.ts'
```

宿主采集插件配置 schema 时读的是**运行时导出的 `Config`**，且必须是 native Schemastery schema，
否则标记 `unsupported` 并报 "Config is not a native Schemastery schema"：

`/Users/.../deepseek-harness/packages/boot/app-boot/src/config-schema/collect.ts:203-208`

第一方写法（`packages/jobs/tool-jobs/src/index.ts:12,59`）：

```ts
import z from '@deepseek-ai/schemastery'
export const Config: z<Config> = z.object({ weknoraBaseUrl: z.string().default(''), ... })
```

后果：`src/config.ts` 里 13 个配置项**在宿主的插件配置页里看不到、写错也不报错、默认值只能靠
插件自己 `resolveConfig` 兜**。Design 文档 §3.1.1 原本写的就是 Schemastery，后来按"真机验证"
改成 interface（`src/config.ts:1-6` 注释）——那条结论现在已经被宿主源码推翻。

### P0-4 `Config.openspecRoot` 在生命周期路径上被硬编码覆盖

`src/features/archive/service.ts` 有 5 处写死 `'openspec'`，完全绕过 `Config.openspecRoot`：
`:143`（merging 前置校验读 tasks）、`:195-199`（写 wiki.md / commits.md）、`:218`
（`runArchive` 传给 orchestrate 的 `{ openspecRoot: 'openspec' }`）。
而 `src/api.ts` 走的是 `deps.openspecRoot`（`src/api.ts:95,209`）。

后果：用户把 `openspecRoot` 配成 `.openspec` / `spec` 后，**创建目录在 A、归档编排查 B**，
表现为"提案文件明明在，却说找不到"。

### P0-5 REST 面没有任何鉴权/Origin 围栏，而它做的事很重

`src/api.ts:64-77` 把 `/workmate/*` 直接挂在 `webServer` 前缀上，路由里有 **归档编排、worktree
创建、写目标项目文件**（`:102-180`）。DSH 自己的 `/api/*` 有 Origin 围栏 + 令牌，插件路由是
明确的信任边界例外（`docs/DSH-INTEGRATION-NOTES.md:43-45`）。

CSRF 风险因 `content-type: application/json` 会触发预检、而插件不返回 CORS 头而**大幅降低**，
所以这不是"立刻可被攻破"，而是：**只要将来任何一个面板/代理把 DSH 反代到别的源，或 webServer
绑定到非 loopback，这条路由就是无鉴权的高危写入口**。根治办法见 P1-1（改走原生 RPC，认证由
宿主连接层统一处理：`packages/client/connection/lib/types/rpc-host.d.ts:6-15`）。

### P0-6 项目注册表 fail-open，与存储层的 fail-closed 纪律相反

`src/features/project/registry.ts:35-43`：`read()` 把**所有**异常（含 JSON 损坏）吞成 `[]`；
紧接着 `upsert`/`remove` 会拿这个空数组原子写回（`:45-50,61-82`）。
即 **projects.json 一损坏，下一次注册任何项目就把整张表静默清空**。
对照 `src/features/proposal/store.ts:114-141`：ProposalStore 对同样情形是抛 `StoreCorruptError`
且永不覆盖。两者必须一致，且注册表同样是"用户手工积累的数据"。

### P0-7 面板 ↔ 路由契约漂移（死代码 + 不生效参数）

- `src/client/api.ts:36-66` 的 `startProposal` / `stopProposal` / `reopenProposal` 打到
  `/start`、`/stop`、`/reopen` —— **服务端从没有这三个路由**（`src/api.ts:80-186`）。三个函数无调用者，纯死代码。
- `archiveProposal(id, force)` 发 `{force}`（`src/client/api.ts:47-52`），服务端 `/archive`
  连 body 都不读（`src/api.ts:117-120`）→ **review.md 缺失时面板无法强制归档**，只能吃报错。
- `src/client/App.tsx:92-107` 的 `act()` 支持 `advance`，但 UI 只在 `status === 'archiving'`
  时渲染"完成归档"（`:316-325`）——**面板不能推进状态**，八态生命周期只能靠 agent 工具或 REST。
  这与"看板驱动流程"的产品定位不符。

---

## 3. P1 — 架构适配：该用原生扩展点却自建

### P1-1 自建 HTTP + fetch + 轮询 ⟶ 原生 `connection` / `@Remote` / `ctx.remote.$on`

自建层规模：`src/http.ts` 164 行 + `src/api.ts` 253 行 + `src/client/api.ts` 82 行 + `App.tsx` 的
`POLL_MS = 5_000` 轮询（`src/client/App.tsx:23,64-78`）。

DSH 原生形态（`packages/client/ui-goal/src/client/index.ts:112-140`）：

```ts
return ctx.remote.goals.get(sessionId)
subscribeActivation: listener => ctx.remote.$on('goal/activation-changed', …)
```

宿主侧用装饰器声明（`packages/goal/goal/src/index.ts:646-647`）：

```ts
@Remote('create')
remoteExportCreate(agent: Agent, request: CreateGoalRequest): CreateGoalResult { … }
```

收益：**类型化契约**（不再有 P0-7 这类漂移）、**认证/Origin 由连接层统一处理**（消除 P0-5）、
**事件订阅替代 5 秒轮询**（消除全量读盘）。代价：需要引入 `@deepseek-ai/dsh-typert-protocol` /
`dsh-client-runtime` 等 rc 线类型包（见 §6 的版本矩阵决策）。

### P1-2 长任务阻塞工具调用 ⟶ 原生 `jobs`

`orchestrateArchive` 串行跑 `openspec archive`（60s 超时）、`gitnexus analyze --force`；
`ready→implementing` 还会在 worktree 里跑 `pnpm install`。这些都在**一次工具调用里同步等待**，
模型只能干等。DSH 有原生作业系统：`jobs: JobRegistry`（`packages/jobs/jobs/lib/types/index.d.ts:18`），
第一方范例 `packages/jobs/tool-jobs/src/index.ts:31`（`inject = ['tools','jobs','systemPrompt']`），
带完成通知、`job_output` 等待与 wakeup 投递——正好是"归档编排"这种场景。

### P1-3 工具定义没用满 `defineTool` 能力（钉子版本就有，无需升级）

`@deepseek-ai/dsh-tools@0.1.2-alpha.5` 已支持（本机 `node_modules` 实读）：

| 能力 | 位置 | 现状 |
|---|---|---|
| `timeoutMs` 协作式超时预算 | `lib/types/index.d.ts:139`、`schema.d.ts:195` | 10 个工具一个都没声明 |
| `isConcurrencySafe(args)` 并行分类 | `lib/types/index.d.ts:153`、`schema.d.ts:201` | 未声明：只读工具（status/wiki_links/knowledge_*）本可并行 |
| `exec.signal` 取消传导 | `lib/types/index.d.ts:119`（`execute` 的 `exec` 参数） | `execute(args)` 全部忽略 `exec`，子进程用 `execFile` 无 abort → **用户点中断，git/openspec/pnpm 继续跑** |
| `presentCall` / `presentResult` / `presentationMeta` 渲染意图 | `lib/types/index.d.ts:163,171`、`schema.d.ts:192,223,230`、`lib/types/presentation.d.ts` | 全部退化为 `JSON.stringify` 文本直出（`src/index.ts` 每处 `output.render`） |

`presentation.d.ts` 里已有的卡片词汇（terminal / file-change / search / read / web-retrieval）
本可以让 `knowledge_query` 渲染成搜索卡、`proposal_create` 渲染成文件变更卡，现在都是裸 JSON。

### P1-4 质量资产写进 `.claude/`，而非 DSH 原生扩展点

`src/features/quality/sync.ts:36-48` 把 `proposal-auditor.md`、两条规则、一个 commit 校验
hook 复制进目标项目的 `.claude/agents`、`.claude/rules`、`.claude/hooks`，并合并
`.claude/settings.json` 的 `PreToolUse`（`:95-114`）；而且默认开启（`src/config.ts:32,58`）。

DSH 的原生位置是：

- 项目级技能根 `<项目根>/.dsh/skills/<name>/SKILL.md`（`docs/DSH-INTEGRATION-NOTES.md:183`）；
- 或插件直接注册 skill provider：`skills: SkillRegistry`
  （`packages/skill/skill/lib/types/index.d.ts:201`，`SkillProvider.list/get` 见 `:166-186`）。

即「proposal-auditor」应当是一个 **DSH skill**（随插件分发，不落用户项目），
而不是 Claude Code 的 agent 文件 + hook。当前做法既不符合 DSH 习惯，又是**默认开启地向用户
项目写文件**——对一个 DSH 插件来说是越界行为。

### P1-5 会话纪律藏在工具描述里 ⟶ `systemPrompt` / skill

`src/index.ts:244-248` 把"两轮卡住 MUST 调 `workmate_proposal_block`"写进工具 description；
10 个工具的 description 常量注入每个会话（上下文税）。
DSH 有 `systemPrompt` 服务供插件贡献系统提示段（`packages/jobs/tool-jobs/src/index.ts:31` 就 inject 了它），
也有 skill 通道。建议：把"流程纪律"移出工具描述（systemPrompt 片段或 skill），
工具只留"怎么做"的一句话。

### P1-6 客户端槽位契约是手写 ambient 类型

`src/client/slot-types.ts:8-11` 把 `conversation.chat.assistant-actions` /
`conversation.input.left` 写成裸字符串 + 自造 `SlotRegistryFace`，
并在注释里明确"故意不依赖宿主的 `@deepseek-ai/dsh-client-ui-*`"。

DSH 的做法是 `SlotMap` declaration merging（`packages/client/ui-slots/lib/types/index.d.ts:17`），
契约由 owner 包声明（`conversation.input.left` 在
`packages/client/ui-conversation/src/client/apply.ts:427`，`kind: 'list', scope: 'session'`）。
现状风险：宿主升级改了 slot 名/scope/props，**workmate 静默不渲染且无编译错误**。
社区包 `dsh-outline` 用的是 type-only import 官方 client 包
（`.../dsh-outline/src/client/index.tsx:8-11`），零运行时依赖，正是该抄的作业。

### P1-7 双 UI 出口（独立 SPA）与"寄生而非替代"自相矛盾

`scripts/build.mjs` 同时产出 IIFE 页 `dist/client/app.js` + `index.html`，
`src/api.ts:62-77` 提供 `/workmate/` 静态路由，`src/client/main.tsx` 是第二套挂载入口；
README §1 却写"不另起 Web 应用"。

两个出口共用同一个 `ProposalPanel`，代价是双份构建产物、双份挂载路径、`PANEL_STYLE` 在
两处注入（`App.tsx:120`、`ChatProposalAction.tsx:40-48,91`）。改走 P1-1 的原生 RPC 后，
独立页只对"调试/浏览器直开"有意义，可作为可选构建目标或直接删除。

---

## 4. P2 — 一致性 / 卫生

| # | 问题 | 证据 |
|---|---|---|
| 1 | 死字段：`OrchestrateDeps.gitnexusEnabled`、`LifecycleDeps.gitnexusEnabled` 声明后无人读 | `src/features/archive/orchestrate.ts:109`、`service.ts:49` |
| 2 | 噪音：`void proposal` | `src/client/App.tsx:159` |
| 3 | `serveStatic` 前缀校验用 `startsWith`，`<assetsDir>-evil` 同级目录可绕过 | `src/http.ts:104` |
| 4 | `mkdir(join(this.file, '..'))` 应为 `dirname()` | `src/features/project/registry.ts:46` |
| 5 | 无 i18n：面板与入口中文硬编码；DSH 有 `locale` 服务（`dsh-outline` 用 `ctx.locale.register`，其 `src/client/index.tsx:27`） | `src/client/App.tsx:25-40`、`ChatProposalAction.tsx:86` |
| 6 | 服务名用点号（`workmate.proposal` 等）而宿主生态用裸名（`jobs`/`commands`/`skills`）；无功能影响，一致性偏弱 | `src/index.ts:50-57,113-116` |
| 7 | `src/api.ts` 尾部 4 行空行 + `registerApiRoutes` 结构松散（多处空行） | `src/api.ts:181-186` |
| 8 | **`pnpm build` 的声明文件步骤从第一天就是坏的**：`tsconfig.decls.json` 同时要求 `allowImportingTsExtensions: false` 与 `.ts` 后缀 import（TS5097），并使用了 TS 5.7 才有的 `rewriteRelativeImportExtensions`（本仓库钉 `typescript@5.6.3` → TS5023）。`git stash` 到 HEAD 复现同样报错，与本轮改动无关。影响：`pnpm build` 非零退出（`scripts/build.mjs` 的运行时产物已先产出，profile 仍可用），`exports["."].types` 指向的 `dist/types` 是陈旧产物。修法：把 TypeScript 提到 `^5.7`（本机 `pnpm add` 被 pnpm store v10/v11 不一致挡住，需先 `pnpm install` 重建） | `tsconfig.decls.json:8-9`、`pnpm-lock.yaml`（typescript 5.6.3） |

---

## 5. 原生扩展点对照表

| 需求 | WorkMate 现状 | DSH 原生 | 证据 |
|---|---|---|---|
| agent 工具 | ✅ `defineTool` + `ctx.tools.register` | 同（形态正确） | `src/index.ts:143-371` |
| 工具超时/取消/并行 | ❌ 未声明 | `timeoutMs` / `exec.signal` / `isConcurrencySafe` | `dsh-tools` alpha.5 `lib/types/index.d.ts:119,139,153` |
| 工具结果渲染 | ❌ 裸 JSON | `presentCall`/`presentResult`/`presentationMeta` 卡片词汇 | `lib/types/presentation.d.ts` |
| 客户端↔宿主 | ❌ 自建 REST + fetch + 轮询 | `@Remote` / `ctx.remote.*` / `ctx.remote.$on` | `packages/goal/goal/src/index.ts:646`、`packages/client/ui-goal/src/client/index.ts:112-140` |
| 长任务 | ❌ 阻塞工具调用 | `jobs: JobRegistry` + `tool-jobs` | `packages/jobs/jobs/lib/types/index.d.ts:18`、`packages/jobs/tool-jobs/src/index.ts:31` |
| 配置 | ❌ 仅 TS 类型 | Schemastery `Config`（校验 + 配置 UI） | `packages/boot/app-boot/src/config-schema/collect.ts:203-208` |
| 流程资产 | ❌ 写 `.claude/**` | skill provider / `.dsh/skills` | `packages/skill/skill/lib/types/index.d.ts:166-186,201` |
| 流程纪律 | ❌ 工具描述 | `systemPrompt` 贡献 | `packages/core/system-prompt` |
| UI 座位 | ⚠️ 第三方 `betterSidebar` 硬依赖 | 一等 slot（`slots` + `SlotMap` 类型）；`shell.overlay` | `packages/client/ui-slots/lib/types/index.d.ts:17` |
| UI 文案 | ❌ 硬编码中文 | `locale` 服务 | `dsh-outline` `src/client/index.tsx:27` |
| 状态存储 | ✅ 自建 JSON + 原子写（合理，可留） | （`storage` 可选，非必须） | `src/features/proposal/store.ts:143-148` |
| 声明式 bundle | ✅ `dsh.bundle.patch` + `dsh.client.platform` | 同（形态正确） | `packages/client/modules/src/index.ts:839-847` |

---

## 6. 建议落地顺序

**Step 1（零依赖、零风险、纯收益）** — 一个 change 就能做完：
P0-1（inject 解耦 webServer）、P0-2（client inject 解耦 betterSidebar）、
P0-4（openspecRoot 贯通）、P0-6（注册表 fail-closed）、P0-7（死代码 + force 贯通 + 面板推进按钮）、
P1-3 的 `timeoutMs` + `isConcurrencySafe`（钉子版本已支持）。**不引入任何新依赖。**

**Step 2（形态升级，需要新 peer 类型包）**：
P0-3（Schemastery `Config`，只需 `@deepseek-ai/schemastery`）、P1-4（quality 资产改 skill provider）、
P1-5（systemPrompt）。这一步要把 `toolchain.json` 的版本矩阵扩一列：哪些 `@deepseek-ai/*`
可以从 rc 线引类型、哪些必须留在 alpha.5（已知 `dsh-tools` 的 `CallId/ToolCallId` 断链）。

**Step 3（架构替换，独立 change）**：
P1-1（REST ⟶ `@Remote` + `ctx.remote` + `$on`）→ 随之 P1-7（删独立 SPA）、P0-5（无鉴权路由消失）、
P1-2（归档/安装改原生 jobs）。**这是最大的一块，也最值得做**：它一次性消掉 500+ 行自建传输层、
消除契约漂移类缺陷、并把认证/Origin 交回宿主。

**Step 4（可选）**：P1-6（slot 契约改 type-only import 官方包，防宿主升级静默失效）、
P2 若干卫生项、i18n。

**独立小修**：P2-8（`pnpm build` 的 decls 步骤——TypeScript 提到 `^5.7`，需先解决
pnpm store v10/v11 不一致）。

> 落地进度（2026-09-30）：
> - Step 1 已实现 `openspec/changes/harden-dsh-plugin-fit`（P0-1/2/4/6/7 + P1-3）；
> - Step 2 已实现 `openspec/changes/adopt-dsh-native-config-and-guidance`（P0-3、P1-4、P1-5）：
>   Config 改 native Schemastery 导出、流程与审查规程改 skill + systemPrompt 分发、
>   Claude 资产加 `claudeAssetsEnabled` 开关。**P1-4 的结论据此修正**：DSH 源码里
>   `.claude/**` 没有任何原生读取路径（唯一读取者是第一方
>   `@deepseek-ai/dsh-hooks-claude-code` 桥，本机 profile 未装载），所以那批资产不是
>   "写错了通道"，而是**受众是 Claude Code 用户**——保留分发、加开关、DSH 侧另走 skill。
> - Step 3 仍未开始。

> 建议按本项目既有工作流走：先 `docs(openspec): ...` 写 `openspec/changes/<name>/{proposal,design,tasks}.md`，
> 再 `feat(...)` 实现。Step 1 建议拆成 `fix(dsh-fit): ...` 一次提交，Step 3 单独一个 change
> （它会重写 `src/http.ts` / `src/api.ts` / `src/client/api.ts` 三个文件）。

---

## 7. 未验证 / 需要决策

1. **`dsh plugin add <tarball>` 是否真的可用**（README §2.2 推荐路径）：需要真机跑一次
   `dsh plugin --profile web add ./workmate4dsh-0.1.0.tgz`，本次评估未执行（会改 profile）。
2. **`@Remote` 的客户端类型生成链**：`remoteExport*` → `ctx.remote.*` 的生成/装配细节未逐行读完，
   Step 3 前需要一次专项验证（重点：第三方插件（非 `packages/` 内）能否同样生成 Remote API）。
3. **`jobs` 的 JobRegistry 生产者接口**：外部插件注册作业的准确签名未核实（只确认了消费侧
   `tool-jobs`），Step 3 需补。
4. **profile `web` 之外的真实使用面**：若团队只在 web profile 用，P0-1 的紧迫度下降为"防御性修复"，
   但仍是正确性缺陷。
