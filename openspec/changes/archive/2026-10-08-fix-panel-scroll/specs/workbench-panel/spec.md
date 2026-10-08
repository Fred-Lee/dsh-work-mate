## ADDED Requirements

### Requirement: 面板根节点高度契约与滚动

WorkMate 面板注册在宿主的 `main`（中央面板）槽，因此其根节点 SHALL 填满该列的确定高度
（`height: 100%`），SHALL 采用纵向 flex 布局，并 SHALL 提供一个**唯一**的纵向滚动容器
（`min-height: 0` + `overflow-y: auto`）；面板头部（导航与「＋ 新提案」）SHALL 位于滚动容器
之外以保持常驻可见；`GraphView` / `ConsoleView` / 看板三视图 SHALL 全部渲染在该滚动容器内。

面板根 SHALL NOT 依赖宿主提供滚动容器：宿主中央列是 `overflow: hidden`，面板自身不滚时
超长内容会被祖先静默裁剪。该契约 SHALL NOT 破坏独立页（`/workmate/`）：其模板不含 CSS，
`height: 100%` 在无高度祖先下退化为 `auto`，页面 SHALL 仍由文档流滚动。

#### Scenario: 超长卡片可滚动到底

- **WHEN** 某提案卡片的展开详情（卡点 / 决策日志）使内容高度超过面板可用高度
- **THEN** 面板内容区出现纵向滚动条，可滚动到卡片底部的边框与操作按钮，内容不被裁剪

#### Scenario: 页头保持可见

- **WHEN** 内容区已滚动到最底部
- **THEN** 头部（视图切换「看板 / 控制台 / 知识图谱」与「＋ 新提案」）仍在原位置可见

#### Scenario: 三视图共用同一滚动容器

- **WHEN** 依次切换到看板、控制台、知识图谱视图
- **THEN** 每个视图都渲染在同一滚动容器内，且各自可纵向滚动

#### Scenario: 独立页不被破坏

- **WHEN** 直接访问独立页 `/workmate/`（无高度祖先）
- **THEN** 面板根取内容高度、不塌陷，滚动仍由文档流承担，且不出现被裁剪的内容

#### Scenario: 弹窗路径不引入滚动层

- **WHEN** 面板打开新建提案弹窗（`.wm-modal`）或聊天入口的固定弹窗（`.wm-modal-fixed`）
- **THEN** 这两个路径不渲染面板内容滚动层，弹窗行为与修复前一致
