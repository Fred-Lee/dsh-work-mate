## ADDED Requirements

### Requirement: 项目 wiki 导出到 vault

实现 SHALL 把项目的 GitNexus wiki 导出为 Obsidian/Tolaria 兼容的 markdown 笔记：
每个模块一篇笔记、一篇 `index.md` 索引、每个相关提案一篇迭代笔记、以及追加式 `changelog.md`；
笔记 SHALL 带 YAML front-matter（项目、模块/提案、来源、commit、生成时间、标签），
索引与迭代笔记 SHALL 使用 `[[wikilink]]` 形成可浏览的图谱；
迭代笔记 SHALL 依据提案数据写入 `depends_on`（来自 `relatesTo`）与 `supersedes`（来自决策链）。

#### Scenario: 导出结构

- **WHEN** 对已生成 wiki 的项目执行导出
- **THEN** vault 内出现 `index.md`、`modules/*.md`、`iterations/*.md`（有提案时）、`changelog.md`，
  且索引中可点达每个模块

#### Scenario: 依赖关系进图谱

- **WHEN** 项目内有带 `relatesTo` / 决策 `supersedes` 的提案
- **THEN** 对应迭代笔记的 front-matter 含 `depends_on` / `supersedes`，并以 `[[...]]` 链接到对方

#### Scenario: 重复导出幂等

- **WHEN** 对同一 commit 重复导出
- **THEN** 笔记被覆盖为一致内容，changelog 不重复追加同一条

#### Scenario: 可选 git 提交

- **WHEN** 开关开启且 vault 是 git 仓库、确有改动
- **THEN** 产生一条 `WorkMate: 更新 <project> wiki @<commit>` 提交；无改动时不提交
