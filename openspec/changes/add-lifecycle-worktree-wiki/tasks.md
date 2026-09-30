# Tasks — Add Lifecycle State Machine, Worktree and Wiki Links

- [x] 1. `state-machine.ts`：八态矩阵 + 相邻校验 + 旧态迁移 + 前置条件接口
- [x] 2. store：status 迁移 normalize；service：transition/advance 集成
- [x] 3. `worktree/port-allocator.ts` + `worktree/manager.ts`（串行锁/四件事/清理）
- [x] 4. `wiki/links.ts`：wiki 声明解析 + 类型覆盖校验 + wiki.md/commits.md 渲染
- [x] 5. 编排：archiving 转换接归档编排（审查门/archive/analyze/清理/wiki+commits）
- [x] 6. REST（advance/transition/wiki link/links）+ 工具（archive mode 状态名 +
      workmate_wiki_link/links）+ Config 七项
- [x] 7. client：状态与下一步提示、worktree 信息、推进按钮、Wiki 分组展示
- [x] 8. 测试（状态机/端口/串行/清理/覆盖校验/归档留痕）+ 全量验证 + 真机验收
      - 71 单测全绿（+worktree 真仓库四件套、allocator 段互斥）
      - 真机八态全链：draft→…→archived，implementing 自动建 worktree
        （端口注入/配置复制/install）、merging 精确报缺 wiki 类型、
        归档后 worktree 回收、archive/ 内 wiki.md+commits.md
      - 真机抓出并修复：api 切块误伤 projects/graph 端点、implementing
        root 缺失静默推进（改为阻断）、install 误走 git 执行器、copyFiles
        覆盖端口注入（顺序对调）
