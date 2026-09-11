# @helmsman/ui-board

Helmsman 任务看板 —— **独立页面** `/helmsman-board`(SPA + 同源 REST),把 change
`add-task-workitem-model` 的 WorkItem 聚合根渲染为四列看板,并承载 WIP 排队、推进门、
卡片详情关联跳转与会话内 run 实时面板。

独立页面而非侧边栏 Tab:四列 + 详情抽屉需要横向画布(proposal 已定)。

## 目录与产物

| 文件 | 作用 |
|---|---|
| `src/index.ts` | DSH host:注册 `webServer` 前缀路由,裸路径 301,**按前缀分流** `/api/*` → 路由器、其余 → 静态 SPA |
| `src/api.ts` | REST 路由工厂(纯函数,可单测);本地声明 `BoardServiceLike` / `OrchestratorLike` / `ArtifactLike` / `TopologyLike` 结构接口 |
| `src/http.ts` | 与 ui-dashboard/ui-diff 同一契约的 MiniRouter + `readJsonBody` + 静态文件(含穿越防护) |
| `src/client/**` | React SPA:四列、卡片、筛选(URL 同步)、详情抽屉、推进门、run 面板、建档表单 |
| `dist/index.js` | host 打包产物(esbuild,`packages: external`) |
| `dist/client/{app.js,embed.js,embed.d.ts,index.html,styles.css}` | 独立页 IIFE 外壳 + 可嵌入 `BoardView` 库入口 + 单一样式表 |

零运行时依赖(无 UI 库、无新的 npm 运行时依赖);`peerDependencies` 只有 `@deepseek-ai/cordis`。

## 装载

`package.json` 已声明 bundle 补丁(缺了会让 profile 装载直接抛错,见
`docs/DSH-INTEGRATION-NOTES.md` A 级条目):

```jsonc
"files": ["dist", "cordis.patch.yml", "README.md"],
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

配置(全部可选):

```ts
inject: ['webServer', 'helmsman.board']   // helmsman.board 必需
new Config({
  mountPath: '/helmsman-board',       // 页面挂载前缀
  dashboardMount: '/helmsman-dashboard', // run 时间线 SSE 的宿主挂载(可改)
  diffMount: '/helmsman-diff',        // 冲突跳转
  workbenchMount: '/helmsman-workbench', // 文档/草稿跳转
  pollMs: 5000,                       // 降级轮询间隔
})
```

`helmsman.orchestrator`(run 时间线)、`helmsman.artifacts`(产物跳转)、
`helmsman.topology`(受影响服务候选)都是**可选懒依赖**(请求时 `ctx.get`,缺失即降级):
缺 orchestrator 时 run 面板显示"不可用",缺 artifacts 时不显示产物悬空判定,
缺 topology 时不产生服务候选——页面照常渲染。

## REST 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `api/config` | 挂载前缀、SSE 模板、各可选服务是否在线 |
| GET | `api/items?repo=&stage=` | 卡片 + 列计数 + 仓库列表 + 冲突域 WIP 计数 |
| POST | `api/item` | 建档(`title` 必填,`repoScope.baseRepo` / `projectGroup` 至少一个) |
| GET | `api/item/:id` | 详情:阶段、下一阶段、推进门缺口、关联(含跳转 href / 悬空标记) |
| PATCH | `api/item/:id` | 摘要(`setSummary`,标记 `manual`)与 `scope.module` |
| POST | `api/item/:id/advance` | **唯一**阶段写路径,body `{to?, allowSkip?}` → `{ok,item,gaps,queueingReason}` |
| GET | `api/item/:id/gate?to=` | 只查门,不推进 |
| POST | `api/item/:id/associate` | 关联引用 `{type,refId,label?}` |
| DELETE | `api/item/:id/associate?type=&refId=` | 解除关联(refId 是路径,故走 query) |
| GET | `api/board/wip` | 冲突域占用(服务端策略优先,缺失时本地统计且上限为 `—`) |
| GET | `api/board/events?itemId=&limit=` | 阶段迁移留痕(`queryEvents` 可选) |
| GET | `api/item/:id/runs` | run 引用 + 每 run 状态 + 冲突跳转 + 待审批 + 服务候选 + `diffMount` |
| GET | `api/run/:taskId/events?after=` | 时间线轮询回退(读同一份 change A 持久化事件) |

约定:

- **拒绝即结果**:门/WIP 拒绝返回 `200 + ok:false`(附 `gaps` / `queueingReason`),卡片不动;
  只有未知 id(404)与非法 body(400)是非 200。`advance` 抛出的带 `gaps`/`queueingReason`
  的错误也被规整为同一个可显示结果。
- **绝不绕过服务**:REST 层不写 `stage`,不复制 WIP 策略;`stage` 只能由 `board.advance()` 改变。
- 关联跳转由服务端解析成 `href`(文档→工作台 draft/note、run/冲突→`/helmsman-diff`、
  产物→注册表下载端点、服务→仪表盘拓扑面板);无 Web 入口的引用(worktree/对话)只做只读展示,
  **不把内容复制进本页**。
- run 实时数据:主路径是宿主 dashboard 的 SSE
  `${dashboardMount}/api/task/:id/stream`(design D6 明写的挂载假设,`dashboardMount` 可配置);
  同时保留 `api/run/:taskId/events` 轮询回退,SSE 不可用(或连续重连失败)时自动降级。

## 服务契约(假设的 `@helmsman/board` 表面)

board 由 change `add-task-workitem-model` 提供,本包**只在类型层**按结构声明(`src/api.ts`
的 `BoardServiceLike`),运行时不 import 兄弟插件。调用形状:

```ts
board.create({ title, repoScope, stage?, scope?, conversation?, docPreset?, summaryText? })
board.update(id, { title?, scope?, specFinalized? })
board.get(id) / board.list({ repo?, stage? })
board.advance({ id, to, allowSkip })        // → { ok, item, gaps?, queueingReason? }(也接受抛错形式)
board.gate(id, to)                          // → { ok, gaps } 或直接返回 GateGap[]
board.associate(id, { type, refId, label?, at })
board.disassociate(id, { type, refId })
board.setSummary(id, { text, generatedBy, at })
board.wip?()                                 // → { policy, domains } 或 WipDomain[]
board.queryEvents?({ itemId?, kind?, limit? })
```

形状按 `openspec/changes/add-task-workitem-model/specs/task-workitem/spec.md` 对齐:
`WorkItem`(四阶段有序枚举 `requirements→spec→dev→done`、`repoScope`、`scope.module`、
`summary{text,generatedBy,source?,at}`、`associations[{type,refId,label?,at}]`、
`runs[{taskId,startedAt,terminal?}]`、`queueingReason`、`conflictDomain`)与
`GateGap{key,label,action?}`。**若 board 的实际签名与此不同,只需改 `src/api.ts` 的适配层**
(路由与 UI 不感知)。

## 看板行为要点

- 四列 `需求分析/规格设计/开发实施/验收归档`,列头显示计数;第 ③ 列显示 `在跑/上限`,
  并按冲突域分组(同仓不同 module 互不计数、可并行);被拒卡片置灰显示 `排队:<原因>`。
- 卡片:标题 + 摘要(≤4 行截断)+ 角标(📄/💬/🧩)+ run 状态点(在跑/排队/已合并/完成)。
- 筛选(仓库/阶段/含-无摘要)与打开的抽屉 id 写入 URL(`?repo=&stage=&summary=&card=`),
  刷新与分享不丢状态。
- 推进入口有两个:详情抽屉按钮与 HTML5 原生拖拽(相邻列),**两者调用同一个 `advance` 接口**,
  且都不本地移动卡片;失败时列出缺口(`GateGap`)与补齐跳转入口。进入开发列可编辑
  `scope.module`(datalist 提示同仓已有模块)。
- run 面板:列表 + 实时时间线(SSE/轮询)、审批挂起"待审批令牌"提示、已 merge run 的
  "确认影响服务"候选(勾选后写成关联)。
- **不提供任何自动合并 / 冲突裁决控件**:冲突行只有一个"跳转对比"链接指向 `/helmsman-diff`,
  由用户在对比界面逐文件决定;组件测试锁死该行为防回归。

## 开发

```bash
pnpm --filter @helmsman/ui-board typecheck   # host + client 两套 tsconfig
pnpm --filter @helmsman/ui-board build       # dist/ 产物
pnpm exec vitest run packages/ui-board       # 路由单测 + 客户端组件测试
```

可嵌入用法(未来放进工作台面板/抽屉):

```tsx
import { BoardView, injectBoardStyles } from '@helmsman/ui-board/client/embed'
injectBoardStyles()
;<BoardView />
```

注:`styles.css?inline` 由 esbuild 的 text loader 打进 `embed.js`,独立页则由 `index.html`
的 `<link>` 加载同一份样式表。
