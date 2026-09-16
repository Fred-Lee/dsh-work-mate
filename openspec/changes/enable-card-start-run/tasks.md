## 1. 看板发起入口（ui-board）

- [ ] 1.1 卡片视图:第 ③ 列 dev 卡片在 `repoScope.projectGroup` 存在且该群已装至少一个 agent 时,渲染「▶ 发起执行」按钮(其他情况显示"先去执行看板"引导)
- [ ] 1.2 「发起执行」弹窗:标题(预填卡片标题,可改)+ 提示词(预填 `summary`,无则空 textarea,可改)+ 级联注入复选框(默认勾上)
- [ ] 1.3 agent 选择下拉:`按场景自适应(默认)` / `claude` / `codex`;默认按场景走"卡片描述特征 + 已装列表"启发式(见 design D2,本地 0 token);用户改选即生效
- [ ] 1.4 提交:调既有 `runParallelTask` 工具,落地后卡片 `runs[]` 由 change A 写入,SSE 推回
- [ ] 1.5 单测:入口条件(gating);预填+可改;agent 切换;提交后调工具不污染拓扑/声明/忽略;WIP 不拦列内追加

## 2. 文档与验证

- [ ] 2.1 `docs/USAGE.md`:看板发起流程(预填+agent 选择+级联)、与执行看板的边界(取消/重试/审批/合并仍走那里)
- [ ] 2.2 `docs/ARCHITECTURE.md`:看板是发起入口、执行看板承担其余操作;WIP 规则不变
- [ ] 2.3 全仓 `pnpm typecheck && pnpm test` 通过
- [ ] 2.4 真机冒烟(父对话):在已装 claude/codex 的真项目群上,临时在卡片配置里点"发起执行"→ 验证 run 起跑、SSE 推回、卡片 `runs[]` 出现;不修改任何既有数据
