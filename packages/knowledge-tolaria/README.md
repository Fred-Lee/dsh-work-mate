# @helmsman/knowledge-tolaria

Helmsman 的 **L4 知识层**:在 `~/.helmsman/vault` 维护一个"归档笔记库"(markdown + YAML frontmatter,`git init`),提供检索与原项目知识图谱。是**唯一**读写该 vault 的插件;草稿/中间内容留在 Helmsman 本地,只有**确认归档**的定稿才会进入 vault。

## 功能

- `archive(note)` — 归档一篇定稿笔记(研究 / PRD / 设计)到 vault(`notes/`、`prds/`、`designs/` 子目录)。
- `list(kind?)` / `get(id)` — 列出/读取笔记元数据。
- `search(query, { kinds? })` — 文件名 + frontmatter + 正文的全文检索(大小写不敏感),返回命中片段。
- `buildGraph({ projectGroupId })` — 合并 memory-topology(服务/API 依赖,**可选**)+ vault 已归档文档/PRD,输出节点/边图谱。

## 存储

- 目录:`HELMSMAN_HOME`(默认 `~/.helmsman`)/`vault/`;详见 `docs/design.md` §5。
- 笔记格式:顶部 `---` frontmatter(`kind` / `title` / `createdAt` / `archivedAt` / `linkedProjects` / `source`) + markdown 正文。

## 复用与依赖

- **零运行时依赖**;`@deepseek-ai/cordis` 为 peer。
- 对 `helmsman.topology`(memory-topology)是**可选**依赖,运行时 `ctx.get` 惰性解析;未安装则图谱只含文档节点。
- Tolaria 的 MCP(`search_notes`)仅作**可选增强**,绝不硬依赖——读写直接走文件系统,离线可用。
