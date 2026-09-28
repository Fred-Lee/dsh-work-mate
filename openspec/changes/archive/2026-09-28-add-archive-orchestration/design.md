# Design — Add Archive Orchestration

## D1 swarm 并行执行：记录性降级

设计文档 §3.1.4 的流水线第 2 步是「调用 swarm_dispatch 并行执行」。现实：
`dsh-swarm-orchestrator` 未装入 profile，且该包在本机 npm 生态的可安装性未验证
（引入一个无法解析的 patch 条目会直接断链 profile）。本变更把该步骤实现为
**记录性跳过**（step 记录 `skipped`，注明原因），编排顺序与其余步骤与设计文档
一致；swarm 插件实际可用后，只需替换 `runSwarmTasks` 一个函数。

## D2 步骤失败语义：失败即停，状态不变

编排是幂等的（重复执行 archive：openspec CLI 幂等报错、gitnexus analyze 强制重跑）。
任一 CLI 步骤失败 → 后续步骤跳过 → 提案保持 `executing`，返回 step 数组供 Agent/面板
定位。`--yes` 交给 openspec CLI（非交互），gitnexus 用 `--force` 全量重建。

## D3 openspec CLI 形态（实测 1.3.1）

`openspec archive <change-id> --yes`，cwd 必须是项目根（openspec/ 所在）。归档后
change 目录迁至 `openspec/changes/archive/<date>-<id>/`——状态探测复用 M2 的
`readChangeState`（archived 分支）。

## D4 任务快照

编排第一步读取 `changes/<id>/tasks.md` 的复选框行（`- [ ]`/`- [x]`），作为 step
记录附着在结果里（任务数 / 完成数 / 原始行）。这是 swarm 执行未来的输入格式。
