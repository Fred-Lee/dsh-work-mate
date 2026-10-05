# Harden DSH Plugin Fit

## Why

`docs/DSH-FIT-AUDIT.md`（2026-09-30）对照本机宿主 `0.1.7-rc.2` 源码逐条核验后确认：WorkMate
的功能面完整，但**宿主适配层存在会真实掉功能的缺陷**，且这些缺陷都不需要引入新依赖：

- 宿主 `inject` 硬依赖 `webServer`（只在 `dsh-web-app` bundle 装载）——headless / acp /
  sdk profile 下 fiber 永久 PENDING，**10 个 agent 工具一个都不注册**；
- 客户端 `inject` 硬依赖第三方 `betterSidebar`——该插件缺失时**对话入口一起消失**；
- `Config.openspecRoot` 在生命周期路径上有 5 处被硬编码 `'openspec'` 覆盖——配置改了
  创建在 A、归档编排查 B；
- `ProjectRegistry.read()` 把 JSON 损坏吞成 `[]`——下一次写入**静默清空整张注册表**
  （与 ProposalStore 的 fail-closed 纪律相反）；
- 面板与路由契约漂移：3 个客户端函数打向不存在的端点，`archive` 的 `force` 服务端不读，
  面板**不能推进/回退状态**，`orchestrateReopen`（归档目录搬回）是死代码——"全程可逆"
  只在状态字段上可逆；
- 10 个工具全部忽略 `exec.signal`——用户中断后 `git worktree add` / `pnpm install` /
  `openspec archive` / `gitnexus analyze` 继续跑完。

## What Changes

1. **宿主 inject 解耦**（`src/index.ts`）：`inject = ['tools']`；webServer 经
   `ctx.inject(['webServer'], scope => …)` 惰性挂载（第一方惯例，见
   `packages/api/gateway/src/index.ts:239`），缺失即无 UI 但工具照常可用。
2. **客户端 inject 解耦**（`src/client/index.tsx`）：client half 零硬依赖；better-sidebar
   tab 与 `slots` 两个对话入口各自惰性注册，互不牵连。
3. **配置贯通**（`src/features/archive/service.ts` + `src/index.ts`）：`LifecycleDeps`
   接收 `openspecRoot`（缺省回落 `'openspec'` 以兼容既有嵌入方），5 处硬编码改为走配置。
4. **注册表 fail-closed**（`src/features/project/registry.ts`）：缺失读作空集，损坏抛
   `StoreCorruptError`；写路径不再可能覆盖损坏文件。
5. **面板流转闭环**（`src/api.ts`、`src/client/*`、`src/index.ts`）：
   `archive` 路由与工具贯通 `force`（跳过审查门）；状态详情返回 `lifecycle{prev,next,hint}`；
   面板新增「回退 / 推进 / 完成归档 / 强制归档」；删除 3 个死客户端函数。
6. **归档可回退补齐**：`archived → archiving` 回退时调用 `orchestrateReopen` 把各项目
   change 目录从 `changes/archive/` 搬回 `changes/`（失败只记录步骤，不阻断状态回退）。
7. **取消传导 + 工具元数据**：`exec.signal` 贯通到 git / 包管理器 / openspec CLI / gitnexus
   / WeKnora fetch；长任务工具声明 `timeoutMs`；只读工具声明
   `isConcurrencySafe: () => true`。

## Capabilities

### 修改能力

- `workmate-plugin`：入口 inject 形态（可选 UI 依赖）、配置贯通、项目注册表 fail-closed。
- `proposal-middleware`：REST/工具/面板的流转闭环（force、推进/回退、死端点清理）。

### 新增能力

- 无（本变更是既有能力的加固，不引入新域模型）。

## Impact

- 改动文件：`src/index.ts`、`src/api.ts`、`src/client/{index.tsx,api.ts,App.tsx,types.ts}`、
  `src/features/archive/{service.ts,orchestrate.ts}`、`src/features/project/registry.ts`、
  `src/features/worktree/{manager.ts,git.ts}`、`src/features/knowledge-bridge/{gitnexus.ts,weknora.ts}`、
  `src/features/proposal/state-machine.ts`（新增 `prevState`）。
- `cordis.patch.yml` **不变**（仍只有 workmate 一行）。
- 版本矩阵**不变**：不新增依赖，`@deepseek-ai/dsh-tools` 继续钉 `0.1.2-alpha.5`
  （`timeoutMs` / `isConcurrencySafe` / `presentCall` 在该线已具备）。
- 非目标（留给后续变更）：`Config` 改 Schemastery、`.claude/**` 质量资产改 DSH skill、
  REST 改原生 `@Remote` RPC、归档编排改原生 jobs。
