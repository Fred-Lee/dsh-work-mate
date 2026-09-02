# @helmsman/bundle

Helmsman 组合包。把 9 个 Helmsman 插件一次性装入一个 DSH profile：

```bash
# 在本仓库根目录执行
dsh plugin --profile web add ./packages/bundle
```

`pnpm` 会解析 bundle 的依赖（所有 `@helmsman/*` 插件互相以 workspace 依赖声明的
部分会一并装入 profile），随后 `dsh --dump-config --profile web` 应能看到本文件
列出的全部 9 个 `id`。
