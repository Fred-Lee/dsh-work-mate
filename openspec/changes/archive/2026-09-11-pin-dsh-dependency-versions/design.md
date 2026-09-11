## 背景(Context)

Helmsman 是一个"住在另一产品(DeepSeek Harness)插件系统内部"的插件项目,它对版本的假设目前只有文字:`docs/WORKBENCH-SETUP.md` 用表格钉了 10 个社区插件(better-sidebar 0.18.0、plugin-check 0.1.0、skill-manager 0.1.3、agfs 0.1.9、outline 0.1.6、vision-router 2.1.2、mnemon 0.5.2、mcp-adapter 0.6.3、auto-review 0.10.4、annotation 1.4.8),记录本地 harness 是 `0.1.2-alpha.5` 源码,并强调 `@deepseek-ai/dsh-tools` MUST 钉在 `0.1.2-alpha.5`(rc.8 线会破坏 `CallId`/`ToolCallId` 导入)。`docs/DISTRIBUTION.md` 描述安装路径。仓库目前没有 `.github/`、没有任何 CI。参考项目 MOVO 用锁版本文件 + 兼容矩阵 + 升级检查 CI 解决了同类问题——本次变更把这个模式缩放到本仓库规模。

## 目标 / 非目标(Goals / Non-Goals)

**目标:**
- Helmsman 验证过的环境所依赖的每一个版本,有且只有一个权威、机器可读的来源。
- 操作员(或 CI)可运行一项检查,证明已安装 profile 仍与清单一致。
- 把兼容性知识沉淀成一份文档,且它不会静默偏离清单。

**非目标:**
- vendor 或自动安装社区插件(保持"单独安装、绝不重写"立场)。
- 在插件内做运行时强制(例如版本不对就拒绝启动)——校验只在仓库/CI 层做。
- 让 Helmsman 脱离 `dsh plugin add` 的分发机制。

## 决策(Decisions)

### D1. 清单是仓库根部的 `toolchain.json`
分节:`platform`(harness 源码引用/版本)、`kernel`(`@deepseek-ai/cordis`、`dsh-tools` 等)、`plugins`(社区插件:名称、版本、来源形式:`github:…`、tgz URL 或 registry)、`engines`(node/pnpm 区间)、`helmsman`(自有包版本与 bundle 集合)。

- **理由**:JSON 可 diff、可被零依赖 Node 校验脚本解析、可 grep;单根文件易发现。
- **考虑过的替代**:散文表格(现状——无法校验);`pnpm-workspace.yaml`/profile `package.json` overrides(只覆盖 npm 安装的部分,覆盖不了用 `dsh plugin add` 装进 profile 的社区插件);`docs/` 下的 yaml front-matter(对工具不可见)。均否决。

### D2. 校验脚本是零依赖 Node
`scripts/check-toolchain.mjs` 接受 `--profile <name>`(默认 `web`)与模式:`--structural`(schema + 内部一致性 + 文档交叉检查)、`--live`(对目标 profile 执行 `dsh plugin list`/`pnpm ls` 比较,用 `node -p process.version` 与 `pnpm --version` 比较引擎)。退出码:0 通过,1 不匹配(打印期望/实际 diff),2 环境/用法错误。

- **理由**:仓库已跑在 Node ≥ 22 + esbuild 上;零依赖 `.mjs` 符合项目约定,无需 `tsx` 即可运行。
- **考虑过的替代**:shell 脚本(JSON 处理脆弱);做成 `packages/toolchain` 插件(杀鸡用牛刀——这是仓库治理,不是运行时功能)。

### D3. CI workflow 最小化且只做增量
`.github/workflows/toolchain.yml` 在触碰 `toolchain.json`、`docs/COMPATIBILITY.md`、`docs/WORKBENCH-SETUP.md`、`docs/DISTRIBUTION.md` 的推送时触发,运行 `node scripts/check-toolchain.mjs --structural`,并在可安装 harness 的 CI 环境运行 live profile 检查。该 workflow 是仓库第一个 CI,但不 gate 其他变更。

- **理由**:先只 gate 会静默漂移的表面;对无关 PR 的爆炸半径为零。

### D4. 兼容性文档 = 由清单生成 + 手工补充已知问题
`docs/COMPATIBILITY.md` 由检查脚本从 `toolchain.json` 生成(已知可用矩阵 = 清单),再叠加清单内手工维护的 `knownIssues` 数组(记录损坏配对与症状,如 dsh-tools 的 `CallId`/`ToolCallId` 不匹配)。

- **理由**:纯手工维护的文档(MOVO 的 `compatibility-matrix.yaml` 也是)会漂移;从清单生成"已知可用"半部分可消除 spec 禁止的漂移模式,而 `knownIssues` 记录的是只有人知道的症状,必须保留人工编辑。

## 风险 / 取舍(Risks / Trade-offs)

- [清单与现实仍会漂移(社区插件发版快)] → 本变更让漂移*可见且快速失败*,而不是消灭漂移;升版本 = 一行清单改动 + 文档说明 + CI 通过。
- [live 检查依赖环境且慢] → live 模式按需(`--live`);CI 常跑结构检查,仅在具备 harness 时跑 live。
- [仓库第一个 CI 对现有工作流陌生] → workflow 增量、小、只在清单/文档路径触发。

## 迁移计划(Migration Plan)

从 `docs/WORKBENCH-SETUP.md` 表格 + README 钉版创建 `toolchain.json`;加校验脚本;生成 `docs/COMPATIBILITY.md`;加 workflow;再把 `WORKBENCH-SETUP.md`/`DISTRIBUTION.md` 改为指向清单。回滚:删掉三个新文件即可——运行时行为不变。

## 开放问题(Open Questions)

- 暂无阻塞项。(CI 的 live 模式是否该安装一个临时 harness,等有了 runner 再定。)
