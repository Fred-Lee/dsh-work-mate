# Design — 修复宿主面板内提案卡片超长时无法滚动

<!-- 关键决策、权衡、替代方案。非平凡变更必填。 -->
<!-- files: src/client/styles.ts, src/client/App.tsx, src/client/app.test.tsx, openspec/changes/fix-panel-scroll/specs/workbench-panel/spec.md -->

外部契约来源（宿主实现，属参考而非本仓库代码事实）：
`@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.module.css`（`.centerCol`）、
`ui-plugin-manager/src/client/PluginManagerPage.module.css`、`ui-schedule/src/client/TaskManagerPage.module.css`。

## 缺陷机制（先讲清"为什么会这样"，否则修法无从判断）

`.wm-root` 是宿主 `.centerCol` 的 flex 子项，自身是 `overflow: visible` 的块级 div：

- 内容不高时：`.wm-root` 取内容高度，`align-items` 默认 `stretch` 只作用于交叉轴，主轴（纵向）
  仍按内容排布 —— 看起来正常。
- 内容超过列高时：`flex-shrink: 1` 允许它被压缩到列高，其**内容**溢出自己的盒子；而
  `.centerCol` 是 `overflow: hidden`，溢出部分被祖先裁掉，且没有任何可滚动祖先
  （`html/body` 在这个 shell 里不滚）。于是"内容在、但永远看不到、也滚不到"。

这解释了截图的两个特征：**无滚动条** + **在窗口底边硬切**（切口正好是 `.centerCol` 的下边界）。

## D1 滚动容器 = 新增的内容层 `.wm-body`，不是 `.wm-root`

- **决策**：`.wm-root` 负责"填满该列 + 纵向 flex"，新增 `.wm-body { flex:1 1 auto; min-height:0;
  overflow-y:auto }` 作为唯一滚动容器；看板 / 控制台 / 知识图谱三视图都渲染在它里面。
- **理由**：`min-height: 0` 是 flex 布局里让子项**允许被压缩**的必要条件（默认 `auto` 会让
  flex 项拒绝收缩到内容高度以下，滚动容器就永远拿不到比内容小的高度，`overflow` 也就永不触发）。
  用一层独立容器，还能让页头与错误条待在滚动区之外（见 D2）。
- **替代方案**：直接给 `.wm-root` 加 `overflow: auto` —— 否决（见 D2）。

## D2 页头留在滚动区外（钉在顶部）

- **决策**：`.wm-header` 与 `.wm-error` 是 `.wm-root` 的直接子级，不进入 `.wm-body`。
- **理由**：页头承载「看板 / 控制台 / 知识图谱」切换与「＋ 新提案」，是面板的**唯一导航**。
  若整页滚动，用户在长卡片底部想切视图还得先滚回顶部；而面板是 `main` 槽里的独立应用面
  （不是文档流页面），导航常驻是宿主自身面板（plugin-manager / schedule）的一致做法。
- **替代方案**：`position: sticky` 页头 —— 否决（`src/client/styles.ts:69` 已明确记录：
  宿主右栏是 `overflow:hidden`，sticky 会钉到错误容器上并盖住 shell 的布局按钮；这条历史教训
  说明 sticky 在这个宿主里不可靠，用 flex 分区才是确定的）。

## D3 为什么不在宿主侧修

- **决策**：本变更只改插件自己的面板根，不动宿主 `ui-layout`。
- **理由**：宿主契约本身是**自洽的**（`main` = 中央面板，填满该列，占位符自己滚），
  宿主自家面板都遵守；不遵守的是本插件。改宿主会波及所有面板与整个 shell 布局，且
  `link:` 的插件与宿主是两条独立的发布线。
- **替代方案**：给 `.centerCol` 加 `overflow:auto` —— 否决（会让宿主所有中央面板获得双重滚动容器，
  属于用宿主缺陷掩盖插件缺陷；本仓库也无法把它发布出去）。

## D4 验收证据分级：真机截图是判据，jsdom 断言只是防回归

- **决策**：验收以「重启后真机截图」判定（卡片底部完整 + 滚动条出现 + 页头在顶 + 独立页正常）；
  单测只锁结构与 CSS 契约。
- **理由**：本缺陷的**全部信息都在布局引擎里**（裁剪、压缩、滚动高度），jsdom 不实现这些，
  现有 5 个测试用例即使全绿也与本缺陷无关 —— 这正是它上线到用户眼前的原因。把 jsdom 测试
  当判据会重复同一种错误。
- **替代方案**：只写单测 —— 否决（无法证伪；见"验证成本与边界"）。

## D5 契约逐条落地的 Review Checklist

| # | 契约 | 落点 | 核验方式 |
|---|---|---|---|
| C1 | 面板根填满 `main` 槽 | `.wm-root { height:100% }` | CSS 文本断言 + 真机截图 |
| C2 | 唯一纵向滚动容器 | `.wm-body { overflow-y:auto; min-height:0 }` | CSS 文本断言 + 真机滚动条 |
| C3 | 页头常驻可见 | 页头不在 `.wm-body` 内 | 结构断言（`.wm-root > .wm-header`、`.wm-header` 无 `.wm-body` 祖先） |
| C4 | 三视图共用同一滚动层 | `GraphView` / `ConsoleView` / `.wm-board` 均在 `.wm-body` 内 | 结构断言（三个视图分别断言） |
| C5 | 独立页不被破坏 | `height:100%` 在无高度祖先下退化为 `auto` | 真机 `/workmate/` 截图（不塌陷、不内嵌滚动） |
| C6 | 弹窗根不受影响 | `.wm-modal` / `.wm-modal-fixed` 路径不渲染 `.wm-body` | 结构断言（弹窗场景无 `.wm-body`） |
| C7 | 卡片自身不再裁内容 | `.wm-card` 的 `overflow:hidden` 保留但不再是滚动瓶颈 | 真机截图（底部边框/圆角可见） |

## 回滚

按 C1–C7 的落点反向还原 `styles.ts` / `App.tsx` 即可；本变更无状态、无数据、无接口，
回滚后行为与修复前完全一致。
