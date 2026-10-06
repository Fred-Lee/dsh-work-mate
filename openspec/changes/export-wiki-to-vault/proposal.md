# Export the Project Wiki into an Obsidian Vault

## Why

用户要的"wiki"是**人能读、AI 能直接吃**的形态，并要能看到**迭代与依赖的图谱**（不是一页页读文字）。
GitNexus 生成的 47 页是"原料"（图谱事实完整，但机器味重、没有索引/标签/互链，也没有迭代关系）；
WeKnora 服务端方案已评估为需要额外部署与 embedding（esp 网关实测无 embedding），成本高。

Obsidian 库是**纯 markdown 文件夹**：人用 Graph/Dataview 看依赖与脉络，AI 直接 `grep`/`read`
同一批文件（文件+行号可引用）。所以把 wiki 导出成**结构化的 vault 笔记**，一次解决人读与 AI 读。

## What Changes

1. **vault 导出器**（`src/features/wiki/vault.ts`）：把 `<repo>/.gitnexus/wiki/` 的原料整理成
   - `index.md`（MOC：项目概览 + 模块表 + 迭代表 + 最近变更）
   - `modules/<slug>.md`（每模块一篇；front-matter + 正文 + 返回索引的 wikilink）
   - `iterations/<proposal-id>.md`（**来自 WorkMate 提案**：`status` / `depends_on` / `supersedes`
     → 图上就是真实的依赖与取代边）
   - `changelog.md`（追加一条：日期 / commit / 模块数 / 页数）
2. **确定性入口**：工具 `workmate_wiki_export`（项目可省略，走隐式解析）+ 斜杠命令
   `/workmate export [--vault <路径>] [--no-git]`。
3. **可选 git 提交**：vault 若是 git 仓库且开关打开，导出后自动 commit
   （`WorkMate: 更新 <project> wiki @<commit>`），零结果时不提交。
4. **配置**：`wikiVaultPath` / `wikiVaultSubdir`（默认 `WorkMate`）/ `wikiVaultGitCommit`。

## Capabilities

### 新增能力

- `vault-export`：GitNexus wiki → Obsidian vault（人读结构 + AI 语料 + 依赖边 + 可选 git commit）。

## Impact

- 新增 `src/features/wiki/vault.ts` 与测试；`config.ts` 三个开关；`index.ts`（工具 + 命令依赖）；
  `command/parse.ts`（新增 `export` 动作与 `--vault/--no-git`）；README/系统提示；AGENTS 里程碑。
- 本机默认 vault：`~/Documents/WorkMate-vault`（新建，已 git init）；可一处配置改指到
  现有库（`~/Documents/Obsidian Vault`、`~/Documents/personal-kb`、`工作日志` 均可）。
