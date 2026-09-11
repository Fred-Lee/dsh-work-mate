## 1. `@helmsman/board` 服务包骨架

- [x] 1.1 搭建 `packages/board`(模式同 `@helmsman/artifacts`):plugin `name:'@helmsman/board'`、`inject:[]`、`helmsman.board` Context 类型;目录/tsconfig/package.json 对齐既有 Service 包
- [x] 1.2 定义模型类型(`WorkItem`、`Stage` 枚举 4 值、`RunRef`、`Association`、`DocRef/ConversationRef/ServiceRef/ArtifactRef/WorktreeRef`、`Summary`、`GateGap`)于 `src/model.ts` 并导出

## 2. 存储与生命周期事件

- [x] 2.1 实现 `BoardStore`:`~/.helmsman/board/items.json`(原子 tmp+rename,`schemaVersion`)、启动加载、损坏时报显式错误且不覆盖原文件
- [x] 2.2 事件追加:`~/.helmsman/board/events.jsonl`,覆盖 create/update/advance/associate/disassociate,行内含 `v/ts/type/payload`;提供 `queryEvents()`
- [x] 2.3 单测:create/list/get/update、重启还原、原子写、损坏文件报错保留、事件追加顺序与查询

## 3. 阶段与门

- [x] 3.1 实现 `advance(itemId)`:仅允许 +1(`allowSkip` 默认 false),成功写阶段迁移事件并更新 items.json
- [x] 3.2 实现门数据与校验:`GateState`(如 `specFinalized`)持久于卡片;`gate(itemId,to)` 返回缺口清单 `[{key,label,action?}]`;可选 `GateProbe` 注入(如 done 门查 run 已 merge + 审计在案)
- [x] 3.3 单测:顺序推进、跳级拒绝、缺口清单、probe 通过/未配置的"未知"语义、迁移事件字段
- [x] 3.4 实现开发作用域:进 dev 时写入/更新 `scope.module`(自动建议接口由宿主给候选,服务层存值);实现冲突域 WIP 评估(键 `repo:module` / 回退 `repo:*`,默认 `module:1`、`repo:*:2`,可配置),与推进校验同一次返回(拒绝 + 排队原因)
- [x] 3.5 单测:同仓不同 module 并行放行、同冲突域超限拒绝、未声明作用域回退整仓域、配置上限覆盖

## 4. 关联与摘要

- [x] 4.1 实现关联增删(`associate/disassociate`):规范化 `refId` + `label` 快照 + `at`,写入事件;可选 `ExistenceProbe` 校验目标存在(缺失则拒绝)
- [x] 4.2 摘要字段:存储 `summary:{text,generatedBy,source,at}`;提供 `setSummary`(manual)与标记入口(模型无关,生成在宿主)
- [x] 4.3 单测:关联增删/事件/悬空引用解析返回"目标不存在"、摘要手动覆盖与元数据保留

## 5. 宿主接线 + 文档

- [x] 5.1 在 `packages/board/src/index.ts` 装配 `BoardStore`(`HELMSMAN_HOME/board`),`ctx.provide` 服务面:create/update/get/list/advance/gate/associate/disassociate/setSummary/queryEvents
- [x] 5.2 ui-workbench 建档通道:`saveTaskFromConversation` 用既有 generator/`ctx.agents` 生成摘要(模型缺失时退化为最近消息前 ~200 字)后调 board create;提供 `getRecentSessions` 门面
- [x] 5.3 文档:`docs/TASK-MODEL.md`(模型/四阶段/DoR-DoD/关联 schema),更新 `docs/ARCHITECTURE.md`、`docs/USAGE.md`
- [x] 5.4 全仓 `pnpm typecheck && pnpm exec vitest run packages/board` 通过;scope 仅 `packages/board` + 文档

## 6. 登记与收尾（父对话）

- [x] 6.1 `toolchain.json` `helmsman.plugins` 登记 `@helmsman/board`(15 个),`packages/bundle/cordis.patch.yml` 同步,`pnpm verify:toolchain` 通过
- [x] 6.2 插件计数同步 15(README / FEATURES / DISTRIBUTION / WORKBENCH-SETUP / bundle README / USAGE)
- [x] 6.3 跨车道接口对齐:`RunRef.terminal` 统一为宿主写入的结果标签(字符串);门控文案统一中文(界面原样渲染)
- [ ] 6.4 真机冒烟:建档 → 推进 → 开发 → 归档 全链路(父对话执行,见 `docs/VERIFICATION-GUIDE.md` §6)