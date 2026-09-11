# @helmsman/bundle

Helmsman 组合包。把 15 个 Helmsman 插件一次性装入一个 DSH profile：

```bash
# 在本仓库根目录执行
dsh plugin --profile web add ./packages/bundle
```

`pnpm` 会解析 bundle 的依赖（所有 `@helmsman/*` 插件互相以 workspace 依赖声明的
部分会一并装入 profile），随后 `dsh --dump-config --profile web` 应能看到本文件
列出的全部 15 个 `id`。

聚合内容：worktree / memory-topology / knowledge-tolaria / artifacts /
orchestrator / adapter-{claude,codex,pi,oh-my-pi} / presets / ui-dashboard /
ui-diff / ui-workbench。其中 `artifacts` 是纯 Service 产物注册表（内容寻址存储 +
下载头助手，UI 宿主经 `ctx.get('helmsman.artifacts')` 懒取），`ui-workbench` 附带
DSH client bundle（`dsh.client` 声明），装入后 DSH web 侧边栏出现
「🚀 Helmsman」工作台入口。
