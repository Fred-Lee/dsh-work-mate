# Tasks — Add Lifecycle State Machine, Worktree and Wiki Links

- [ ] 1. `state-machine.ts`：八态矩阵 + 相邻校验 + 旧态迁移 + 前置条件接口
- [ ] 2. store：status 迁移 normalize；service：transition/advance 集成
- [ ] 3. `worktree/port-allocator.ts` + `worktree/manager.ts`（串行锁/四件事/清理）
- [ ] 4. `wiki/links.ts`：wiki 声明解析 + 类型覆盖校验 + wiki.md/commits.md 渲染
- [ ] 5. 编排：archiving 转换接归档编排（审查门/archive/analyze/清理/wiki+commits）
- [ ] 6. REST（advance/transition/wiki link/links）+ 工具（archive mode 状态名 +
      workmate_wiki_link/links）+ Config 七项
- [ ] 7. client：状态与下一步提示、worktree 信息、推进按钮、Wiki 分组展示
- [ ] 8. 测试（状态机/端口/串行/清理/覆盖校验/归档留痕）+ 全量验证 + 真机验收
