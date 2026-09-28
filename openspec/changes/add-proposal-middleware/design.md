# Design — Add Proposal Middleware

## D1 集成模式全部取自真机验证的 Helmsman 形态

| 面 | 模式 | 证据 |
| --- | --- | --- |
| 工具注册 | `inject: ['tools']` + `ctx.tools.register(defineTool({parameters, output, execute}))` | `main:packages/orchestrator/src/index.ts`，0.1.2-alpha.5 宿主真机 |
| REST/静态 | `inject: ['webServer']` + `webServer.register({kind:'prefix', path, handler})` + 自建 Router（:param、遍历保护） | `main:packages/ui-board/{src/index.ts,src/http.ts}` |
| 独立 SPA | esbuild IIFE 全内联（react 打进去），静态目录白名单服务 | `main:packages/ui-workbench/build.mjs` app.js |
| DSH 界面寄生 | `dsh.client.platform:'web'` + ModuleLoader CJS bundle（react external）+ `betterSidebar.registerTab` | `main:packages/ui-workbench/{src/client/index.tsx,build.mjs}` |

`'tools'` 与 `'webServer'` 都进模块级 `inject`——两者为硬依赖且存在性已验证；
client 半的 `betterSidebar` 同理（ui-workbench 同款）。`slots` 类可选注册面继续
沿用「`ctx.inject([...], scope)` 局部作用域」纪律，M2 未用到。

## D2 项目根解析：显式优先，不猜

工具的 `projectRoot` 参数 > `Config.projectRoot`（新增，默认 `''` 禁用）。为空且
未传时，openspec 目录生成与 Git 扫描跳过并在返回值里带 `note` 说明——提案是全局
实体（`$DSH_HOME` 侧），项目侧资源（openspec 目录、git 扫描）只在能确定项目根时
才动作，绝不落到 cwd 这类隐式位置（子进程 argv 数组、rootDir 越界校验继承
Helmsman 纪律）。

## D3 Git 关联用 pull 模式，不监听事件

设计文档 §3.1.2 的「监听 DSH 的 Git 事件」在宿主上无验证面。status 查询时执行
`git log --all --grep '[proposal:<id>]>' --fixed-strings --format=%H%x09%s%x09%h`
（`-fixed-strings` 防止 id 里的正则元字符）。查询是幂等只读，事件监听的唯一好处
（实时推送）M2 的面板用轮询即可覆盖。结论记回 DSH-INTEGRATION-NOTES。

## D4 archive 的 M2/M4 分层

M2 的 `workmate_proposal_archive` 是**状态机推进**：校验 openspec change 目录存在
（能解析 projectRoot 时），推进 `executing → archived`（draft 不能直接跳到
archived）。M4 会把同一工具的背后替换成完整编排（tasks 解析 → swarm → openspec
archive CLI → gitnexus analyze）——工具签名不变，Agent 无感。

## D5 UI 形态：一个面板组件，两个出口

`ProposalPanel` React 组件是唯一实现；

- `main.tsx` → IIFE `app.js`：独立页 `/workmate/`（自持样式、内联 React）；
- `index.tsx` → ModuleLoader `client.js`：better-sidebar tab「🛠 WorkMate」内渲染
  同一组件（react external，宿主 module table 提供）。

数据面统一走 `fetch('/workmate/api/...')`（同源，无跨域）；轮询 5s 兜底，不引 SSE
（提案状态变化频率低，M2 不值得上事件流）。

## D6 样式注入

延续 Helmsman 约定：CSS 以 `?inline` text loader 进 bundle，运行时 `<style>` 注入
（IIFE 页）或由宿主 shell 注入（ModuleLoader 侧同样 self-inject，一次去重）。
