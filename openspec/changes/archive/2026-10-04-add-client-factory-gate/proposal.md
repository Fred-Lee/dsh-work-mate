# Add Client Factory Gate

## Why

AGENTS.md 自己写着一条无法用现有门禁发现的失效模式：

> bundle 必须在 `package.json` 声明 `dsh.bundle.patch`，否则 profile 装载直接抛错
> （**单元测试抓不到，只有真装进 profile 才暴露**）。

客户端的失效同理：`dist/client/client.js` 是包在
`window.__ModuleLoader__.load({ id, factory })` 里的 CJS 模块，`apply` / `inject` /
external require 三点任一写错，单测全绿、`pnpm verify` 全绿，只在真机上白屏或静默不加载。
社区里 `dsh-worktable` 用一个 `node:vm` 求值门禁解决同一问题（143 行，断言 load 调用次数、
id、external 白名单、`apply` 类型、`inject` 深度相等），值得照抄思路。

## What Changes

1. 新增 `scripts/check-client-factory.mjs`：在 `node:vm` 里**真求值**构建产物
   `dist/client/client.js`（递归 Proxy 桩兜住 DOM/全局访问），断言：
   - `window.__ModuleLoader__.load` 恰好调用一次；
   - `id` 与本包 `package.json` 的 `name` 一致；
   - `factory(require)` 返回的 `module.exports` 上有函数 `apply`；
   - 若声明 `inject`，必须是字符串数组；
   - **external require 默认拒绝**，出现白名单（`react` / `react/jsx-runtime` /
     `react-dom` / `react-dom/client` / `@deepseek-ai/cordis`）之外的名字即失败。
   求值设两级超时，死循环不会挂住发布流程。
2. 门禁进 `pnpm verify`（第四条）并补 `scripts/check-client-factory.test.mjs`
   自测（node:test，随 `pnpm test:toolchain` 跑）。

## Capabilities

### 新增能力

- `client-build-gate`：客户端构建产物的工厂求值门禁（装载契约 + external 白名单）。

## Impact

- 新增 `scripts/check-client-factory.mjs` 与其用例；`package.json` 的 `verify` 增加一步。
- **不做**：真渲染验收（Proxy 桩只能证明"不抛异常"，DOM 行为仍需真机）。

## 边界（照抄者最容易误解的地方）

门禁解决的是"装载契约 + 依赖面"，**不是**端到端验收：它抓不到样式错位、槽位未渲染、
交互失效。它会明确列出自己抓得到与抓不到的范围。
