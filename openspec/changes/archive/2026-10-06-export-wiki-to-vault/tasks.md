# Tasks — Export Wiki to Vault

- [x] 1. `vault.ts`：index/MOC + 模块笔记 + 迭代笔记（依赖 front-matter）+ changelog + 覆盖写
- [x] 2. 迭代依赖来自提案（status / relatesTo → depends_on / decisions.supersedes → supersedes）
- [x] 3. 工具 `workmate_wiki_export`（项目隐式解析）
- [x] 4. 命令 `/workmate export [--vault <path>] [--no-git]`
- [x] 5. 配置 `wikiVaultPath` / `wikiVaultSubdir` / `wikiVaultGitCommit`；可选 git commit（无变更不提交）
- [x] 6. 测试：文件与 front-matter、index 链接、依赖字段、changelog 追加、重复导出幂等、命令解析
- [x] 7. 文档 + AGENTS 里程碑；真机导出到本机 vault 并用 Obsidian 打开验证
