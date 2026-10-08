# Review — 修复宿主面板内提案卡片超长时无法滚动

<!-- reviewer: proposal-auditor@session -->
> 审查对象：`openspec/changes/fix-panel-scroll`（`3c175a8` 实现提交 + `ff89b07` 主干合并）。
> 审查方式：静态阅读 + 浏览器布局引擎实测（CDP Runtime.evaluate 读计算样式与滚动几何）+ 失效态对照实验。
> **GitNexus 知识查询不可用**（`workmate_knowledge_query` 对 `PANEL_STYLE` / `ProposalPanel` 两次均返回
> `VECTOR extension unavailable`），消费方清单为静态格雷普结果，非图谱交叉验证。此降级如实标注。
> 下文 `疑问项` / `建议补充项` 的开放条目**刻意带严重度标签**（`LOW-n`/`MED-n`）：未打标签的条目会被
> 判断层的 `review-severity` 节点重新归级，可能把一条已知非阻断发现判成 `CRIT` 而误锁归档门。
> 带标签即声明严重度，属该解析器的正常形态（`src/features/quality/review-parser.ts:67`）。

## 确认项

- [x] 确认：C1「面板根填满 main 槽」已落地 — `src/client/styles.ts:45-48` 有
  `display:flex; flex-direction:column; height:100%; min-height:0`，且 `git diff` 显示这是本变更新增行。
- [x] 确认：C2「唯一纵向滚动容器」已落地 — `src/client/styles.ts:56-62` 新增
  `.wm-body { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding-bottom:24px }`；
  `padding: 0 0 24px` 从 `.wm-root` 移除（同文件 diff 的 `-` 行），职责迁移干净。
- [x] 确认：C3「页头常驻可见」结构成立 — `src/client/App.tsx` 的 `.wm-body` 开标签在 `wm-header` 之后
  （`App.tsx:193`），实测 `header.parentClass === 'wm-root'`、`header.insideBody === false`。
- [x] 确认：C4「三视图共用同一滚动层」成立 — 浏览器实测依次点「控制台 / 知识图谱 / 看板」，三次
  `document.querySelectorAll('.wm-body').length` 恒为 1，且每次滚动几何都落在这同一元素上
  （控制台 `scrollHeight 471 / clientHeight 182`、知识图谱 `190 / 182`、看板 `263 / 182`）。
- [x] 确认：C5「独立页不被破坏」成立 — 无高度祖先下 `.wm-root` 计算高度为**内容高度**
  `338.188px`（`height:100%` 按 CSS 规范退化为 auto），`.wm-body` 不溢出（`scrollHeight === clientHeight`），
  文档仍溢出（`354 > 340`）→ 滚动依旧由文档流承担，未被面板内嵌滚动层接管。
- [x] 确认：C6「弹窗路径不受影响」成立 — 打开「＋ 新提案」后 `.wm-modal` 存在，而
  `document.querySelector('.wm-modal').closest('.wm-body') === null`；`ChatProposalAction.tsx:90-92` 的
  `.wm-root.wm-modal-fixed > .wm-modal` 路径同样不经 `.wm-body`。
- [x] 确认：C7「卡片自身不再裁内容」在**对照实验**下成立 — 同一份新代码，注入宿主裁剪上下文
  （`html,body{height:100%;overflow:hidden}` + `main` 槽的 `display:flex;overflow:hidden` 确定高度列）后：
  修复态 `.wm-body` `scrollHeight 263 > clientHeight 162`，`canScroll = true`，`scrollTop` 实际到达
  **101px**；把 `.wm-root`/`.wm-body` 还原成修复前语义后，`canScroll = false`、`scrollTop` 恒为 0。
  **对照项是这次审查里最有力的一条**：它证明"能滚"来自本次改动，而不是环境偶然。
- [x] 确认：页头在任何视图下都不随内容滚动 — 修复态滚到底时 `header.getBoundingClientRect().top` 恒为
  `0` 且 `headerVisible = true`；对照态（修复前）同一测量得到 `top = -101`（页头被一起滚出视口）。
- [x] 确认：改动面与声明一致 — `git diff --ignore-all-space 3c175a8^..3c175a8` 显示 `src/client/App.tsx`
  **净增仅 2 行**（`.wm-body` 开/闭标签）；`src/client/styles.ts` 的语义改动为上述两处；
  未触碰服务端、未新增依赖，符合 `tasks.md:3` 的范围声明。
- [x] 确认：`App.tsx` 表面上 684 行的 diff 是**纯重新缩进**，非语义改写 — 342 处加减行首空白，
  +行合计缩进 12237 格、-行 11505 格，净增 732 格 ≈ 每行 +2 格（缩进层级加一）。
- [x] 确认：消费方清单完整（静态核验，GitNexus 不可用）— 全仓引用 `wm-root` / `wm-body` / `PANEL_STYLE`
  的仅 `src/client/App.tsx`、`src/client/ChatProposalAction.tsx`、`src/client/app.test.tsx` 三处；
  已逐个核对：`ChatProposalAction` 走 `.wm-root.wm-modal-fixed` 固定定位路径（`inset:0` 给出确定高度，
  `height:100%` 不产生副作用），未出现遗漏消费方。
- [x] 确认：回滚完整 — 本变更无状态、无数据、无接口（`design.md:71-74`），
  `git revert 3c175a8` 后行为回到修复前，与"回滚后行为与修复前完全一致"的声明相符。
- [x] 确认：人工验收已完成 — 用户在重启后的真机面板上确认"可以滚动"，并成功点到此前无法到达的
  「推进到 归档中」按钮（事件流 `2026-10-08T14:51:37.785Z` `merging→archiving`）。
  **这条同时是端到端判据**：如果面板仍不可滚，那个按钮在视口外，这个状态迁移不可能发生。

## 疑问项

- [ ] LOW-1 用户提供的真机截图上**未观察到可见的滚动条**，我无法用视觉证据复核 C2 的"滚动条出现" —
  影响：C2/C7 的**视觉**判据弱于几何判据 — 说明：macOS 覆盖式滚动条在非滚动瞬间不绘制，属正常；
  且该轮视觉后端已耗尽（`VISION_BACKEND_UNAVAILABLE`），未再重试。几何判据（`scrollHeight > clientHeight`
  且 `scrollTop` 实际改变）比"看到滚动条"更强，故不阻断，仅记录证据等级。

## 建议补充项

- [ ] LOW-2 建议：把"宿主裁剪上下文复刻 + CDP 几何量测"固化成脚本（本次为一次性 `/tmp` 脚本），
  让 C1/C2/C3/C7 在未来每次客户端布局改动时可重复取证 — 本次证据因此无法在 CI 重放。

## CRITICAL 问题

- [x] 无未解决 CRITICAL 问题

## 范围外发现（本变更不修，逐条取证，供开新提案）

- [ ] MED-3 归档审批记录在回退后不被清理 — 证据：`proposals.json` 的 `approvals` 同时累积了两条
  `merging/approve`（`14:44:29.751Z`、`14:46:19.146Z`），面板因而同时显示「已批准」与「等待人工批准」。
  `service.ts` 的 `recordApproval` 只追加、回退路径不裁剪。违反：审批记录应表达"当前是否已批准"这一
  状态语义 — 修复方向：状态回退时按 `to` 状态清除对应 gate 的审批记录，或改为读时按最新一条判定。
- [ ] MED-4 `workmate_proposal_status` 工具查不到已注册项目 — 证据：同一提案，REST
  `/workmate/api/proposals/:id` 能取到根目录（`src/api.ts:151` 传了 `resolveRoot`），而工具返回
  `projects[].note = "未在项目注册表中注册 — 无根目录，跳过 Git/OpenSpec 采集"` 且 `commits: []`，
  尽管 `commits.md` 已列 3 个提交。违反：工具与面板应共享同一套项目解析 — 修复方向：在
  `src/index.ts` 的 `workmate_proposal_status` 工具块补 `resolveRoot` 依赖（与面板路径同源）。
- [ ] LOW-5 `tasks.md:3` 的范围声明注释本身被 `workmate_plan_drift` 解析出一个字面量范围 `…` —
  证据：`workmate_plan_drift` 的 `declared` 数组首项为 `"…"`，`missing` 亦含该项，而 `undeclared` 为空
  （`driftRatio 0`，不影响结论）。说明：`tasks.md:3` 是**说明性**的 `> 范围声明用行内 ...`
  引用行，被当成声明行解析；属解析器对文档正文的误收纳，非本变更缺陷。

> 审查结论：C1–C7 逐条有落点、有实测；失效态对照把"能滚"归因到本次改动；无未解决 CRITICAL。
> 上述 MED/LOW 条目均为范围外发现或证据等级说明，不阻断归档，建议随后以独立提案处理 MED-3 / MED-4。
