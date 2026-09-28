# Tasks — Add Multi-Project, Reopen and Git Visibility

- [x] 1. host：`src/features/project/registry.ts`（projects.json 原子 CRUD）
- [x] 2. host：`git.ts` 的 `getGitInfo`（branch/head/dirty/worktree 检测）
- [x] 3. host：详情聚合多项目（每项目 git 块 + 该项目关联提交）
- [x] 4. host：编排多项目化（归档/搬回逐项目执行）+ `ArchiveServiceImpl.reopen`
- [x] 5. host：REST（projects CRUD、reopen、detail 聚合）+ 工具升级
- [x] 6. client：对话弹层作用域修复（.wm-root 包裹 + 按钮样式注入）
- [x] 7. client：创建模态项目选择器（勾选注册项目 + 内联注册）
- [x] 8. client：卡片详情项目分组展示 + archived 卡片「重新打开」
- [x] 9. 测试 + 全量验证 + 真机验收
      - 真机：双项目（其一为 linked worktree）关联提案 → 详情正确显示
        分支/HEAD/worktree 标记/各项目关联提交 → 归档编排两项目逐一 archive
        + gitnexus 重建 → reopen 两项目目录搬回 changes/、状态回 executing
      - 真机发现并修复：归档失败重试的幂等语义（CLI 报 not found 但
        change 已 archived → 记 skipped 而非 failed）；REST 归档端点
        吞掉 orchestration 的缺陷
