/**
 * Dataview view note (change `dataview-views-in-vault`).
 *
 * The vault is only "not just text" when the graph and the queries actually work, so the
 * export ships a ready-made view note: with Dataview installed the tables appear
 * immediately; without it the note still explains what to open and read by hand.
 * Queries only use front-matter fields the exporter really writes (`date`, `status`,
 * `origin`, `derived`, `touches`, `module`) — no invented keys.
 */
export interface ViewNoteInput {
  project: string
  subdir: string
  modules: number
  pages: number
  iterations: number
}

export function dataviewViews(input: ViewNoteInput): string {
  const base = `${input.subdir}/${input.project}`
  return `---
title: "${input.project} — 视图"
type: "views"
project: "${input.project}"
tags: ["workmate", "views", "${input.project}"]
---

# ${input.project} — 视图

> 这些是 **Dataview** 查询；装插件后本页会自动渲染成表格，未装则看下面的替代说明。
> 每次导出都会重写本页；你自己的查询请另建笔记。

## 项目规模

\`\`\`dataview
TABLE WITHOUT ID
  length(rows) AS 笔记数
FROM "${base}"
GROUP BY true
\`\`\`

## 迭代时间线（按日期）

\`\`\`dataview
TABLE date AS 日期, status AS 状态, origin AS 来源, derived AS 派生血缘
FROM "${base}/iterations"
SORT date ASC
\`\`\`

## 按年分组的迭代

\`\`\`dataview
TABLE WITHOUT ID date.year AS 年份, length(rows) AS 迭代数
FROM "${base}/iterations"
GROUP BY date.year
SORT date.year ASC
\`\`\`

## 被触及最多的模块

\`\`\`dataview
TABLE WITHOUT ID touches AS 触及, length(rows) AS 迭代数
FROM "${base}/iterations"
WHERE touches
FLATTEN touches
GROUP BY touches
SORT length(rows) DESC
LIMIT 15
\`\`\`

## 模块清单

\`\`\`dataview
TABLE module AS slug, pages AS 页数, commit AS commit
FROM "${base}/modules"
SORT module ASC
\`\`\`

## 最近变更

\`\`\`dataview
TABLE date AS 日期, status AS 状态
FROM "${base}/iterations"
SORT date DESC
LIMIT 10
\`\`\`

## 未装 Dataview 时

1. 打开 [[${base}/index|${input.project} 索引]]：里面有模块表与迭代表（Markdown 表格，纯文本也能读）。
2. 打开 \`iterations/\` 任意一篇：front-matter 里有 \`date\` / \`sequence\` / \`touches\`。
3. 看依赖与脉络：Obsidian 打开图谱（\`Cmd+G\`），迭代之间按 \`sequence\` 相连。

当前导出：**${input.modules} 模块 / ${input.pages} 页 / ${input.iterations} 迭代**。
`
}

/** Vault-level note listing every project the exporter has written. */
export function vaultViews(projects: readonly string[], subdir: string): string {
  const list = projects.map((project) => `- [[${subdir}/${project}/index|${project}]]`).join('\n')
  return `---
title: "WorkMate — 总览"
type: "views"
tags: ["workmate", "views"]
---

# WorkMate — 总览

由 WorkMate 从 GitNexus 图谱导出的项目 wiki。人用 Obsidian 读/看图，AI 直接读同一批 markdown。

## 项目

${list || '- （还没有导出过项目）'}

## 跨项目查询（需 Dataview）

\`\`\`dataview
TABLE project AS 项目, length(rows) AS 迭代数
FROM "${subdir}"
WHERE type = "iteration"
GROUP BY project
SORT length(rows) DESC
\`\`\`

## 约定

- 每个项目一个目录：\`index.md\`（MOC）、\`modules/\`、\`iterations/\`、\`views.md\`、\`changelog.md\`。
- 迭代的依赖分两类：**声明**（WorkMate 提案的 \`relatesTo\`/决策 \`supersedes\` → \`depends_on\`/但当前主用 \`supersedes\`）
  与**推导**（按时间的前序 \`sequence\`，front-matter 标 \`derived: true\`，不会冒充依赖）。
`
}
