# Make the Lifecycle Fully Reversible

## Why

「归档可回退」落地后仍有一个死胡同：提案进入「执行中」后无法退回「提案中」——
执行中发现方向错了，只能硬着头皮归档或弃卡。用户要求：**每个步骤都可以回退**，
即状态机的每个前进动作都有对应回退。

## What Changes

1. **状态机补全**：新增 `stop`（`executing → draft`，退回提案中）。至此每一步
   前进都有回退：`start`↔`stop`、`archive`↔`reopen`；`draft` 是唯一起点，
   `archived` 经 reopen 可逆。openspec change 目录在 stop 时不动（它本来就没被
   归档编排移走）。
2. **REST**：`POST /api/proposals/:id/stop`。
3. **工具升级**：`workmate_proposal_archive` 新增 `mode` 参数
   （`archive` / `start` / `reopen` / `stop`，缺省 archive）；旧布尔 `start` 保持
   兼容。Agent 因此获得与面板一致的全程可逆操作面。
4. **面板**：执行中卡片的操作区加「退回提案」；归档卡片的「重新打开」已有。

## Capabilities

### 修改能力

- `archive-orchestration`：状态机双向化（MODIFIED requirement）。

## Impact

- host：`service.ts` 的 `stop`、REST 端点、工具 mode 参数。
- client：执行中卡片一个按钮。
- 不涉及编排（stop 不触发任何项目侧动作）。
