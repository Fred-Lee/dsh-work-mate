## 1. 清单(Manifest)

- [x] 1.1 在仓库根创建 `toolchain.json`,分节 `platform`、`kernel`、`plugins`、`engines`、`helmsman`、`knownIssues`;内容从 `docs/WORKBENCH-SETUP.md`(10 个社区插件 + 钉版版本)、README、以及 `0.1.2-alpha.5` 的 dsh-tools 钉版及其 `CallId`/`ToolCallId` 已知问题迁移而来
- [x] 1.2 在根部 `package.json` 增加脚本 `verify:toolchain`;清单 schema 说明保留在检查脚本里(若采用严格 JSON,则避免 JSONC 注释)

## 2. 校验脚本

- [x] 2.1 实现 `scripts/check-toolchain.mjs` 的 `--structural` 模式:校验结构、版本唯一、每个插件条目含 name/version/source、文档交叉检查——文档中任何与清单冲突的版本都判失败
- [x] 2.2 实现 `--live --profile <name>` 模式:运行 `dsh plugin list` 比较已装社区插件版本,通过 profile 的 `pnpm ls` 比较 `@deepseek-ai` 内核包,比较 Node/pnpm 引擎;任何漂移以"期望 vs 实际"diff + 退出码 1 结束
- [x] 2.3 实现从 `toolchain.json`(已知可用矩阵)+ 手工 `knownIssues` 条目生成 `docs/COMPATIBILITY.md`
- [x] 2.4 单测脚本:合法清单通过;版本漂移失败且 diff 正确;引擎不匹配失败;文档 vs 清单冲突失败(按项目约定用 vitest 或纯 node 断言)

## 3. CI + 文档采纳

- [x] 3.1 新增 `.github/workflows/toolchain.yml`,在 `toolchain.json`、`docs/COMPATIBILITY.md`、`docs/WORKBENCH-SETUP.md`、`docs/DISTRIBUTION.md` 变更时触发;常跑结构检查,可安装 harness 时跑 live 检查
- [x] 3.2 更新 `docs/WORKBENCH-SETUP.md` 与 `docs/DISTRIBUTION.md`:指向 `toolchain.json` 为权威,删除冗余的散文钉版(或标注"必须与 toolchain.json 一致")
- [x] 3.3 生成一次 `docs/COMPATIBILITY.md`,并确认干净检出上 `pnpm verify:toolchain` 通过

## 4. 交叉核对

- [x] 4.1 核对 `packages/bundle` 的 12 插件集合与 `cordis.patch.yml` 同清单 `helmsman` 节一致
- [ ] 4.2 做一次真实升版演练(如在清单里升某个社区插件、跑 `--live`、观察"失败再修复"的流程),并作为证据记录在本变更的验证笔记中
