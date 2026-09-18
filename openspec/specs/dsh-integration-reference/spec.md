# dsh-integration-reference Specification

## Purpose
TBD - created by archiving change borrow-workbuddy-harness-know-how. Update Purpose after archive.
## Requirements
### Requirement: 集成要点带证据等级
仓库 SHALL 在 `docs/DSH-INTEGRATION-NOTES.md` 维护 DSH 宿主集成契约的参考，且每条要点 SHALL
标注证据等级：**A 实测**（在本机 harness 上真实执行过，附可复现命令与结果）、
**B 借鉴**（来自其它 DSH 项目，尚未在 Helmsman 侧验证）、**C 源码**（读宿主源码得到）。
文档 SHALL NOT 把 B 级内容表述为已确认事实。

#### Scenario: 实测条目可复现
- **WHEN** 读者看到一条标为 A 实测的要点（如 Origin 围栏矩阵）
- **THEN** 文档给出可直接执行的命令与预期输出，读者能在本机复现同一结果

#### Scenario: 借鉴条目明确标注待验证
- **WHEN** 文档记录一条取自外部项目、Helmsman 侧尚未验证的做法（如 RPC 信封成功路径）
- **THEN** 该条目标为 B 借鉴并注明"待本地验证"，不与 A 级条目混排为同一可信度

### Requirement: 覆盖关键宿主契约点
文档 SHALL 覆盖以下契约点，每点至少说明现象、触发条件与落地含义：请求 Origin 校验、
插件 profile bundle 声明要求、profile 的 link 安装与重建要求、agent preset 用户级插入点
及其"永不覆盖用户 preset"约定。

#### Scenario: Origin 围栏可据文档规避
- **WHEN** 有人计划把 DSH 反代到另一个源
- **THEN** 文档说明必须改写 `Origin`/`Referer`，并给出外来 Origin 得到 403 的实测矩阵作为依据

#### Scenario: 新增插件不再漏声明
- **WHEN** 开发者新增一个 Helmsman 插件包并准备装进 profile
- **THEN** 文档指出必须同时提供 `dsh.bundle.patch` 与 `cordis.patch.yml`，并说明缺失时的装载报错文本

### Requirement: 借鉴内容可追溯到产出物
文档 SHALL 记录借鉴来源项目与版本，并 SHALL 明确"外部内置 harness 版本与 Helmsman 目标版本
不同、不可用作冒烟环境"的结论及其依据（peer 约束与发布线差异）。

#### Scenario: 环境选择有依据
- **WHEN** 有人提议用 DSH-Work-Buddy 内置的 harness 跑 Helmsman 冒烟
- **THEN** 文档说明其版本为 `0.1.0-rc.7`、cordis 4.0.1，不满足 Helmsman 的 `cordis ^4.0.2`
  约束，因而不可用，并指向本机正确版本

### Requirement: 插件包声明齐备（回归防护）
每个 Helmsman 插件包 SHALL 同时具备 `dsh.bundle.patch` 声明与对应的 `cordis.patch.yml`，
使 profile 装载不会因缺声明而失败。

#### Scenario: 新包可被 profile 装载
- **WHEN** 一个 Helmsman 插件包被加入 `dsh.profile.bundles`
- **THEN** harness 启动时不出现 `declares no dsh.bundle` 报错，插件日志出现其 ready 行

