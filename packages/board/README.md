# @helmsman/board

Helmsman 看板工作项(WorkItem)聚合根 —— 四阶段生命周期 + 门校验 + 冲突域 WIP + 关联引用集。

## 职责

纯 Service cordis 插件(无 `webServer`、无工具、无运行时依赖),提供 `helmsman.board` 服务:

| 方法 | 说明 |
|---|---|
| `create(input)` | 建档(id `wi_*`),默认落在 `requirements`;至少需 `repoScope.baseRepo` 或 `repoScope.projectGroup` |
| `update(id, patch)` | 改标题 / 仓库标识 / 开发作用域 / 门数据;无实质变化则不写事件 |
| `get(id)` / `list(filter)` | 单卡读取(未知 id 返回 `undefined`)/ 按 `repo`、`stage` 过滤(创建序) |
| `advance(id, opts)` | 阶段推进:默认只允许 +1;返回 `{ item, gaps }`,**gaps 非空即未推进** |
| `gate(id, to)` | 返回进入目标阶段的缺口清单 `[{ key, label, action? }]` |
| `setGates(id, patch)` | 写入门数据(如 `{ specFinalized: true }`);`update({ gates })` 为等价写法 |
| `associate(id, a)` / `disassociate(id, a)` | 关联增删(只存引用 + `label` 快照);`type: 'run'` 同时维护 `runs[]` |
| `setSummary(id, s)` | 存摘要(生成在宿主);`generatedBy` 区分 `model`/`manual`/`fallback` |
| `wip()` / `evaluateWip(repoScope, scope)` | 冲突域占用/上限/排队;`evaluateWip` 为**同步**返回 |
| `queryEvents(filter)` | 生命周期事件查询(`since` 为 `ts` 下界,可安全翻页) |

## 模型要点

- **两级结构**:`WorkItem` ⇄ `runs[]: RunRef{ taskId, startedAt, terminal? }`。run 数据归 orchestrator,
  board 只存引用,不改变既有 `taskId` 语义;`terminal` 由宿主写入,board 从不伪造 run 状态。
- **四阶段**:`requirements → spec → dev → done`(展示名由 UI 决定,包内不存中文文案)。
- **关联集**:全部为引用(`doc` / `conversation` / `service` / `worktree` / `artifact` / `run`),
  `refId` 用对象自有 id/路径,`label` 仅作渲染快照,绝不复制内容。
- **门(DoR/DoD)**:`requirements→spec` 无门;`spec→dev` 需 `gates.specFinalized === true`;
  `dev→done` 需"≥1 run 已 merge + 审计在案"。
- **冲突域(D7)**:域键 = `repo:module`(声明了 `scope.module`)或 `repo:*`;同仓不同模块互不计数。
  默认上限 `module:1`、`repo:*:2`,可经 `wipLimits` 配置。

## 结构化消费方兼容(`@helmsman/ui-board`)

看板 SPA 经**结构化类型**(不 import 本包实现)消费本服务,部分调用形状与规范签名不同;
本包对这些形状**容忍**(纯增量,不放松任何行为规则):

| 调用形状 | 说明 |
|---|---|
| `advance({ id, to, allowSkip, scope })` | 与 `advance(id, { to, ... })` 等价 |
| `update(id, { title, scope, specFinalized })` | `specFinalized` 为门数据别名(等价 `setGates`) |
| `update(id, { stage })` | **拒绝**:`stage` 只允许 `advance()` 写(看板不得绕过接口直接改写阶段);与当前阶段相同则视为幂等 |
| `setSummary(id, { text })` | `generatedBy` 省略时按 `'manual'`(宿主手改) |
| `queryEvents({ itemId, kind, limit })` | `kind` 为 `type` 别名;`limit` 取**最新** N 条(仍按追加序) |
| `gate(id)` | `to` 省略时默认下一阶段;终态返回 `[]` |
| `wip()` | 每条含 `key`(= `domain`)、`repo`、`module`、`itemIds`(在跑卡片 id) |
| `evaluateWip({ repo, module, excludeId })` | 兼容扁平入参;返回含 `key`/`running`/`limit`/`queueingReason` 别名 |

`advance()` 返回体除 `{ item, gaps }` 外含 `ok` / `queueingReason` / `reason`;
**结构性拒绝**(越级 / 回退 / 终态)抛出 `HelmsmanBoardError` 时同样携带 `gaps` 与
`details.missingStages`,REST 层可直接渲染为可展示的拒绝,无需 500。

## 缺口清单与本地化

`GateGap.label` / `action` 为英文文案,`key` 是稳定机器键——UI 应按 `key` 出中文文案:

| key | 含义 |
|---|---|
| `spec-finalized` | 未标记规格定稿,不能进入 `dev` |
| `run-merged` | 无已 merge 的 run(或未配置 probe / probe 失败) |
| `audit-on-record` | 无 merge 审计记录(或未配置 probe / probe 失败) |
| `wip-limit` | 冲突域已达上限(文案内含域键,如 `R:a`) |

## 可选注入缝(缺省即独立可用)

| 缝 | 作用 | 缺省行为 |
|---|---|---|
| `ExistenceProbe.exists({type, refId})` | 校验关联目标是否存在 | 不校验,关联按原样接受,事件里记 `verified: false` |
| `GateProbe.hasMergedRun(item)` / `hasAuditOnRecord(item)` | 裁决归档门 | 不通过也不静默放行:返回"无法验证/未配置"缺口并拒绝推进 |

`advance()` 另支持按次覆盖 `gateProbe`(测试/宿主便利),以及可选的 `actor`(记入迁移事件)与
`scope`(进入 `dev` 时一并声明模块域,被拒则整卡不变)。

## 状态布局

```
$HELMSMAN_HOME/board/            # 默认 ~/.helmsman/board
├── items.json                   # { schemaVersion: 1, items: [...] } 原子 tmp+rename 重写
└── events.jsonl                 # { v, ts, type, itemId, payload } 逐行追加
```

事件类型:`create` / `update` / `advance` / `associate` / `disassociate` / `summary`;
迁移事件含 `from` / `to` / `at` / `actor` / `runs`(供 change C 审计消费)。
`ts` 在单个 store 内**严格递增**(跨重启亦从文件尾部续钟),因此可直接当翻页游标。
摘要正文可能含敏感对话内容,事件里只记 `generatedBy` / `source` / `chars`,不记正文。

## 失败策略(与 artifacts 相反:不自我修复)

`items.json` 是卡片唯一真相源,损坏或 schema 版本不识别时**报显式类型化错误并保留原文件**,
之后所有读写一律 fail-closed —— 绝不静默重建空看板(空看板看起来像丢数据,且下一次写会覆盖真文件)。
目录不可写时写操作报 `STORE_WRITE_FAILED`,既有文件不被破坏(tmp+rename 保证)。
事件追加失败会抛 `EVENT_WRITE_FAILED`,且消息明确说明"卡片变更已落盘、仅审计行缺失",避免调用方误重试建档。

错误码:`INVALID_INPUT` / `NOT_FOUND` / `STAGE_TERMINAL` / `INVALID_TRANSITION` / `SKIP_NOT_ALLOWED` /
`TARGET_NOT_FOUND` / `STORE_CORRUPT` / `SCHEMA_UNSUPPORTED` / `STORE_UNREADABLE` /
`STORE_WRITE_FAILED` / `EVENT_WRITE_FAILED`。

拒绝语义:**结构性错误**(未知 id、非法/回退/越级迁移)抛错;**业务拒绝**(门未满足、WIP 超限)
返回缺口清单且卡片/存储/事件流全部不变,便于看板渲染清单后重试。

## 被谁消费

- `@helmsman/ui-board` —— 四列看板、冲突域分组与排队原因、卡片详情推进门。
- `@helmsman/ui-workbench` —— 会话"保存为任务"建档通道(摘要生成在宿主侧)。
- change C 审计 —— 消费 `events.jsonl` 的阶段迁移留痕。

宿主一律经 `ctx.get('helmsman.board')` 懒取,插件缺失时降级隐藏看板功能。
