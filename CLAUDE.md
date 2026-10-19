# WorkMate — 项目指南（指向 AGENTS.md）

> 本文件**不再是副本**：为避免长期滞后（历史上曾落后 140 行），全部内容以
> **[`AGENTS.md`](./AGENTS.md)** 为唯一事实来源：项目定位、常用命令、插件契约、
> 升级仪式、数据落盘、里程碑路线、OpenSpec 工作流、文档索引。

## 三条最容易踩的纪律（细节见 AGENTS.md）

1. **插件契约**：具名导出 `name`/`inject`/`Config`/`apply`（无 default）；`Config` 必须同时是
   运行时 Schemastery schema；内核 peer 写 `*`；`webServer`/`skills`/`systemPrompt`
   用 reactive `ctx.inject` 惰性装配。
2. **改完必须重装/重启**：`link:` 安装的插件要 `pnpm build` 后重启 harness 才生效；
   本机重启入口是 `~/.dsh/harness-restart.sh`（看门狗托管，见 AGENTS.md）。
3. **验证纪律**：以**产物**判定，不以退出码判定；`openspec archive` 前先跑
   `pnpm typecheck && pnpm test && pnpm build && pnpm verify`。
   `pnpm verify` 含 `verify:test`（测试自证门禁）：**include 改窄、有 `it.skip`、有
   `test.todo` 都会被它拦下**——这是故意的，别改门禁去适配代码。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **dsh-Helmsman** (5429 symbols, 11052 relationships, 311 execution flows). Use GitNexus graph tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact analysis before editing.** Use `impact({target: "symbolName", direction: "upstream"})` (MCP) or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .` (CLI fallback); report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/dsh-Helmsman/context` | Codebase overview, check index freshness |
| `gitnexus://repo/dsh-Helmsman/clusters` | All functional areas |
| `gitnexus://repo/dsh-Helmsman/processes` | All execution flows |
| `gitnexus://repo/dsh-Helmsman/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
