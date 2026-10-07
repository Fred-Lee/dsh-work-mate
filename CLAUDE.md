# WorkMate — 项目指南（指向 AGENTS.md）

> 本文件**不再是副本**：为避免长期滞后（历史上曾落后 140 行），全部内容以
> **[`AGENTS.md`](./AGENTS.md)** 为唯一事实来源：项目定位、常用命令、插件契约、
> 升级仪式、数据落盘、里程碑路线、OpenSpec 工作流、文档索引。

## 三条最容易踩的纪律（细节见 AGENTS.md）

1. **插件契约**：具名导出 `name`/`inject`/`Config`/`apply`（无 default）；`Config` 必须同时是
   运行时 Schemastery schema；内核 peer 写 `*`；`webServer`/`skills`/`systemPrompt`
   用 reactive `ctx.inject` 惰性装配。
2. **改完必须重装/重启**：`link:` 安装的插件要 `pnpm build` 后重启 harness 才生效；
   本机重启入口是 `~/.dsh/harness-restart.sh`（看门狗托管，见 AGENTS.md）。
3. **验证纪律**：以**产物**判定，不以退出码判定；`openspec archive` 前先跑
   `pnpm typecheck && pnpm test && pnpm build && pnpm verify`。
