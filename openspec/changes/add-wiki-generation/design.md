# Design — Add Wiki Generation

## D1 不擅自重跑 analyze

`analyze` 是重活（全量重建图谱）。所以默认只跑**只读** `gitnexus status` 判断新鲜度，
把 `stale: true` 如实写进结果，由调用方决定要不要 `analyze: true`。
"我知道你的索引过期了"比"我替你跑十分钟然后你没预期"更诚实。

## D2 产物路径写死并回传

`<项目>/.gitnexus/wiki/`（`index.html` + 逐模块 markdown），由 GitNexus 决定目录布局，
WorkMate 只做"路径回传"而不是自己拼接内容。回传 `wikiDir` 与 `indexHtml` 绝对值，
面板/终端都能直接打开。

## D3 失败要可执行

wiki 依赖 LLM 配置（`~/.gitnexus/config.json` 或 `--provider/--api-key`）。失败时
`note` 保留 CLI 原文并附一句"先配 provider/key"，而不是笼统"失败了"。

## D4 与提案流程解耦

本能力不需要提案存在（对已有仓库用），因此不复用 `workmate_proposal_*` 的任何前置校验；
只校验 `projectRoot` 是存在的绝对路径。想把它登记进提案知识面，另行调用
`workmate_wiki_link`（WeKnora 页面引用）。
