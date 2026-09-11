## Why

Helmsman 与 DSH 宿主的交互面散落在若干隐式约定里（Origin 围栏、profile bundle 声明、
agent preset 用户根、会话绑定序列、事件流信封），每做一个新面板都要重新逆向一次；
而相邻项目 DSH-Work-Buddy 已经用生产代码踩过其中几个坑，其经验对 Helmsman 的
任务工作项/看板计划直接有用。本次变更把这些契约点**沉淀成仓库内的参考文档**，
并以证据等级区分"本机实测"与"外部借鉴"，同时修掉一个只有真装进 profile 才会暴露的
集成缺陷。纯文档 + 一处声明修正，不改运行时行为。

## What Changes

- 新增 `docs/DSH-INTEGRATION-NOTES.md`：DSH 宿主集成要点，逐条标注证据等级
  （**A 实测** / **B 借鉴** / **C 源码**），并给出可复现的命令与结果。
- 已实测并写入文档的契约点：Origin 围栏（外来 Origin → 403 的完整矩阵）、
  插件 bundle 声明要求与缺声明时的装载报错、profile 的 `link:` 安装方式、
  agent preset 用户级插入点及其"永不覆盖"约定、真机上的历史/SSE/门控/审计/产物行为。
- 标为"借鉴、待本地验证"的点：WorkBuddy 的会话/工作区绑定序列、HTTP RPC 信封与
  `events.mux` 帧协议、`commands/execute` 与 `session.prompt` 的区别。
- **修复集成缺陷**：`@helmsman/artifacts` 缺少 `dsh.bundle` 声明与 `cordis.patch.yml`，
  导致 profile 装载直接抛错、harness 无法启动（同门 13 个包都有，唯它缺）。补齐声明、
  补丁文件与 README。
- 结论记录：WorkBuddy 内置的 harness 为 `0.1.0-rc.7`（cordis 4.0.1），与 Helmsman 目标的
  `0.1.2-alpha.5`（cordis 4.0.2）不在同一发布线，**不能**用作 Helmsman 的冒烟环境；
  本机自带的 harness 才是正确环境。

## Capabilities

### New Capabilities
- `dsh-integration-reference`: 仓库内维护的 DSH 宿主集成契约参考，要求每条要点带证据等级与
  可复现依据，且"借鉴未验证"的内容不得被当作已确认事实使用。

### Modified Capabilities
<!-- 无：本次不改变既有 spec 的行为要求。 -->

## Impact

- `docs/DSH-INTEGRATION-NOTES.md`（新增）。
- `packages/artifacts/package.json`（补 `dsh.bundle` + `files`）、
  `packages/artifacts/cordis.patch.yml`（新增）、`packages/artifacts/README.md`（新增）。
- 作为 `add-task-workitem-model` 的设计输入：会话/工作区绑定序列、per-task 目录当 cwd、
  归档 manifest 形状。
- 运行时的用户环境：`~/.dsh/profiles/web/package.json` 增加 `@helmsman/artifacts`
  （依赖 + bundle 列表），否则产物交付在真机上不可用。
