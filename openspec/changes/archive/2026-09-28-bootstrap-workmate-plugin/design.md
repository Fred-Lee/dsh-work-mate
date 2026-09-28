# Design — Bootstrap WorkMate Plugin

## D1 仓库形态：单包，非 monorepo

设计文档 §8.3 的发布流程是 `pnpm pack` 单包 tarball，WorkMate 自建面只有一个插件
（host 半 + client 半同包），没有拆包需求。因此：

- 删除 `pnpm-workspace.yaml` 与 `packages/*`，根 `package.json` 即插件包本身。
- 不保留 Helmsman 的 `tsconfig.base.json` 共享层——单包直接内联同一组严格选项
  （`strict`、`noUncheckedIndexedAccess`、`nodenext`、`verbatimModuleSyntax`、
  `allowImportingTsExtensions`），这些选项经 Helmsman 42 文件 / 681 用例验证。
- `.claude/`（openspec/gitnexus 工作流技能）与 `openspec/config.yaml` 保留——
  它们是开发流程设施，与产品代码无关。
- 包名取 `workmate4dsh`（无 scope）。设计文档的 `@your-org/workmate4dsh` 是占位符，
  scope 待发布渠道确定后再定；`cordis.patch.yml` 的 `name` 必须与之一致
  （宿主契约笔记 §A：三处一致，M1 起由静态检查保障）。

## D2 插件形态：按真机验证过的写法，而非设计文档的字面示例

设计文档 §3.1.1 的示例用 Schemastery schema 导出 `Config`。但本机宿主上被 Helmsman
13 插件验证过的形态是 **纯 TypeScript interface**：

```ts
export const name = 'workmate'
export const inject = [] as const
export interface Config { workmateHome?: string; ... }
export function apply(ctx: Context, config: Config = {}): void
```

服务类型经 `declare module '@deepseek-ai/cordis'` 扩展 `Context` 接口。按验证过的
形态写，避免 M1 冒烟就卡在配置解析上。若宿主 0.1.7-rc.2 实际要求 Schemastery
schema，冒烟会立刻暴露（`dsh web` 加载日志），届时再改。

## D3 inject 策略：M1 自足，'tools' 延至 M2，'git'/'session' 待验证

设计文档写 `inject = ['tools', 'git', 'session']`。宿主契约笔记的教训（Helmsman
AGENTS.md「插件契约」）是：**inject 里的服务未就绪则 fiber 永久 PENDING**。三个名字
在 0.1.7-rc.2 宿主上的存在性均未验证（profile 实测可见的内置服务面里没有它们）。
因此：

- M1：`inject = []`（纯服务插件，board 同款自足形态），验收目标是「加载成功」。
- M2：注册工具时先 `ctx.get('tools')` 惰性解析验证存在性，确认后写进 inject。
- `'git'` / `'session'`：降为待验证假设，在 M2/M4 各自需要时先探测再依赖，
  探测结论记回 `docs/DSH-INTEGRATION-NOTES.md`。

## D4 版本线：跟随真机，修正设计文档的两处假设

| 项 | 设计文档假设 | 真机（本变更采用） | 依据 |
|---|---|---|---|
| DSH 宿主 | `>=0.1.5-rc.3 <=0.1.7-rc.2` | **0.1.7-rc.2**（源码部署） | `~/Documents/workspace/deepseek-harness/package.json` |
| `@deepseek-ai/cordis` peer | `^4.0.1` | **`^4.0.2`** | Helmsman 全线真机验证的组合 |
| `@deepseek-ai/dsh-tools` | `^0.1.1-rc.2` | M1 不引入；M2 引入时钉 **0.1.2-alpha.5 线** | profile 实装版本；Helmsman 教训：升 rc 线破坏 `CallId`/`ToolCallId` import |

## D5 MCP 桥接：`@deepseek-ai/dsh-mcp-client` 在本机生态不存在

设计文档 §3.1.3 假设官方 MCP 客户端插件。profile 实测只有社区的
`dsh-mcp-adapter@^0.6.3`，没有 `@deepseek-ai/dsh-mcp-client`。M1 不涉及；
M3 设计时二选一：改用 `dsh-mcp-adapter`，或为 GitNexus 走 stdio 直连（GitNexus
自带 `node .gitnexus/run.cjs` CLI，HTTP/CLI 桥接可能比 MCP 更短）。本变更只在
`cordis.patch.yml` 预留注释位，不写无法解析的条目。

## D6 patch 装配：一行起步

`cordis.patch.yml` 仅含 `workmate` 一行。设计文档 §4.2 的 `swarm` / `mcp-gitnexus`
条目引用了 profile 尚未安装的插件（`dsh-swarm-orchestrator`、MCP 客户端），写入
即断链。宿主契约笔记 §A：bundle 声明缺失会让 profile 装载直接抛错——同理，引用
缺失插件也会。对应条目随 M3/M4 依赖就位追加。

## D7 client 半：M1 完全不声明

`package.json` 不写 `dsh.client`——M1 没有 `src/client/`，声明只会制造一条未验证的
加载路径。M2 引入提案面板时随 UI 构建链（client IIFE 打包）一起加。设计文档 §2.2
的 Host/Client 禁止跨边界 import 约束届时以 `shared/contracts/` 落地。

## D8 持久化布局（M2 实现，M1 定契约）

`$DSH_HOME/workmate/proposals.json`，单 JSON 文件 + tmp+rename 原子写（继承
Helmsman 落盘纪律；JSONL 与撕裂尾行容忍等 M2 出现事件流时再引入）。`$DSH_HOME`
解析顺序：配置 `workmateHome` 是相对子目录名（默认 `workmate`），根取
`$DSH_HOME`（默认 `~/.dsh`）。——注意设计文档 §3.1.2 写的 `$DSH_HOME` 默认值未
指明，按宿主 `dsh-home-paths` 实际约定在 M2 实现时核对，此处先立目录布局。

## D9 测试与验收

- 单元：配置默认值补全、proposal store 路径解析与原子写（M1 先落 store 骨架）。
- 冒烟（验收标准）：web profile 装载后 `pnpm dsh --profile web --dump-config`
  出现 `workmate` 条目，`dsh web` 加载日志无 error。
- 契约静态检查：`cordis.patch.yml` 的 `id`/`name`、`package.json` 的
  `name`/`dsh.bundle`、`src/index.ts` 的 `name` 三处一致（设计文档 §6 风险表的
  loader id 错位规避，M1 起用一个 20 行的 node 脚本门禁）。
