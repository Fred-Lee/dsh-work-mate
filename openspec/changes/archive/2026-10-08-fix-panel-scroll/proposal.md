# 修复宿主面板内提案卡片超长时无法滚动

## Why

宿主 WorkMate 中央面板里，提案卡片展开「卡点 / 决策日志」后内容超长，卡片在窗口底边被
**硬切**、全画面**无任何滚动条**，折叠区以下的内容与按钮不可达。

截图证据（用户于 2026-10-08 提供，1605×963 原始像素）：左栏「提案阶段」唯一卡片的最后一行
可读文字停在 `score 的准确率口径是"最高档完全命"`，其下无下边框、无圆角、无阴影，也没有
任何滚动条轨道/滑块；中右两栏为空态。

根因（代码事实，非推测）：

| 层 | 事实 | 来源 |
|---|---|---|
| 宿主中央列 `.centerCol` | `display:flex; flex-direction:column; overflow:hidden`，高度确定 | `@deepseek-ai/dsh-client-ui-layout` 的 `AppFrame.module.css` |
| 面板根 `.wm-root` | 只有 `font/color/background/padding`，**无 `height`、无 `flex`、无 `overflow`** | `src/client/styles.ts:10` |
| 卡片 `.wm-card` | **`overflow: hidden`** | `src/client/styles.ts:117` |

`.wm-root` 是 `.centerCol` 的 flex 子项（`flex: 0 1 auto`）：内容超过可用高度时它被压缩到容器
高度，内容却溢出，而 `.centerCol` 的 `overflow: hidden` 把溢出**永久裁剪**——既没有滚动条，
也无法滚动。

宿主自身对 `main` 槽的契约是「中央面板，填满该列」，一方面板插件都照此实现：
`ui-plugin-manager` 的 `.page { height:100%; overflow:auto }`、
`ui-schedule` 的 `.page { height:100%; min-height:0; overflow:hidden }`。
WorkMate 把面板根当成了普通块级元素，所以只在宿主内坏掉。

独立页 `/workmate/` **不受影响**（`dist/client/index.html` 无任何 CSS，靠 body 滚动）——这也是
单元测试从未发现它的原因：jsdom 没有布局。

## 来源 / Provenance

- source: `incident`
- sourceRef: `sha256:5346fd38f7bcbf830abaeee9eed9cfe67e39c88c56ecbd086c9f8ea1aabb573f`（用户截图）

### intent 形状

- **Problem**：面板根节点缺高度与滚动契约，在宿主 `main` 槽内被祖先裁剪，长卡片内容不可达；
  已有的 5 个客户端测试用例全部基于 jsdom，**结构上不可能**捕获该类缺陷（无布局引擎）。
- **Proposed outcome**：面板根声明 `height:100%` 的列方向 flex 布局，内容区（看板 / 控制台 /
  知识图谱三视图共用一层）成为唯一滚动容器，页头保持可见；独立页行为不变。
- **Affected users and systems**：所有在宿主内使用 WorkMate 面板的人；受影响面为
  `src/client/styles.ts` 与 `src/client/App.tsx` 两个文件，**不改**服务端、REST 路由与数据。
- **Constraints**：
  - 独立页 `/workmate/` 的模板无 CSS、无高度祖先，改动 SHALL NOT 让它塌成零高度或被嵌套滚动。
  - 客户端产物构建后必须重新装载才生效（`link:` 安装 → `pnpm build` + 重启 harness）。
  - `pnpm verify:client` 只管装载契约，证明不了渲染，因此验收必须包含**真机截图**。
- **Open questions**：
  1. 页头是否随内容滚动？（见 design D2：不随，钉在顶部）
  2. 滚动容器是 `.wm-root` 还是新增一层内容容器？（见 design D1：新增一层）

## What Changes

1. **样式**（`src/client/styles.ts`）：`.wm-root` 增加 `display:flex; flex-direction:column;
   height:100%; min-height:0;`，并把原先挂在它上面的 `padding: 0 0 24px` 移到新的内容层
   `.wm-body`；`.wm-body` 为 `flex:1 1 auto; min-height:0; overflow-y:auto;
   overscroll-behavior:contain; padding-bottom:24px`。
2. **结构**（`src/client/App.tsx`）：页头与错误条留在 `.wm-root` 直接子级，把三视图
   （`GraphView` / `ConsoleView` / `.wm-board`）包进 `<div className="wm-body">`。
3. **规格新增**（`specs/workbench-panel/spec.md`）：新增「面板根节点高度契约与滚动」要求
   及其三个场景（超长可滚到底 / 页头保持可见 / 独立页不被破坏）。
4. **测试**：新增结构断言（`.wm-root > .wm-body`、`.wm-body` 承载 `.wm-board`；
   `.wm-modal` 与 `.wm-modal-fixed` 挂载时**不得**出现 `wm-body`），并在 CSS 文本上断言
   `.wm-root` 含 `height:100%`、`.wm-body` 含 `overflow-y:auto`。
5. **真机验收**：`pnpm build` → `~/.dsh/harness-restart.sh` → 打开 WorkMate 面板，
   截图判定：卡片底部完整可见（有下边框/圆角）、面板右侧出现滚动条、页头仍在顶部、
   `/workmate/` 独立页仍正常。由用户执行重启（重启会中断 agent 会话）。

## Impact

- **受影响符号**：`PANEL_STYLE`（CSS 文本，新增 `.wm-body` 规则）、`ProposalPanel` 的
  JSX 根结构。无导出签名变化、无 API 变化、无数据迁移。
- **不改的**：`.wm-card` 的 `overflow: hidden` 保留（它裁的是左侧色条与圆角，不是内容滚动）；
  卡片展开/折叠、动作按钮、REST 调用、判断层、生命周期门禁一律不动。
- **风险**：`.wm-root` 加 `height:100%` 后，若某宿主把面板放进**无高度**的祖先，`100%` 会退化为
  `auto`（CSS 规范行为），布局与现在一致——即改动是**渐进增强**，不会把独立页或未知宿主改坏。
- **验证成本与边界（如实记录）**：现有 jsdom 测试对"是否真的能滚"没有证据力，
  因此本变更的**核心验收是真机截图**；单测只能锁住结构与 CSS 契约，防止未来被误删。
- **回滚**：还原 `styles.ts` / `App.tsx` 两处即可；无状态、无数据影响。
