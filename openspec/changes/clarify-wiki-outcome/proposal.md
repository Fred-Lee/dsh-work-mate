# Clarify the Wiki Outcome

## Why

用户在工作区执行 `/workmate wiki` 后只看到三行（判决 / 页数 / 阅读器），**看不出到底发生了什么**：
是重新生成了，还是 GitNexus 认为已是最新、压根没动？耗时多久？命令就这样结束了吗？

复现实据：那次运行 `index.html` 的 mtime 被刷新（23:05:49），而 `meta.json` 仍是 16:18:22、
47 个页面未变——也就是说本轮**没有真正重新生成页面**。而 GitNexus 自己早就把答案写在输出里
（`Wiki is already up to date.` / `Mode: …` / `Pages: …` / `generated successfully (576.4s)`），
我们却把它丢掉了，只用自己数的文件数回答。

## What Changes

1. **解析 CLI 摘要**（`parseWikiSummary`）：`upToDate`（"already up to date"）、`mode`、`reportedPages`、
   `cliElapsedSeconds`；`gitnexusWiki()` 回传 `upToDate` / `mode` / `elapsedMs`。
2. **"已是最新"不算陈旧**：该分支下 GitNexus 本就不会重写产物，因此陈旧产物守卫改为
   仅在**非 up-to-date** 运行时生效（否则会把正确的"已是最新"误报成 `❌ 未完成`）。
3. **命令输出说明发生了什么**：`结果：已是最新（…用 --force）` 或 `已生成 / 更新（CLI 模式：full）`，
   并给出 `产物（实测）：N 页 + index.html`、`耗时`、`索引重建：是/否`、阅读器路径，
   以及一句"命令结束（无实时进度；要边跑边看用终端 wkwiki）"。
4. 工具回传同名字段，便于 agent 一致转述。

## Capabilities

### 修改的能力

- `wiki-generation`：CLI 摘要解析、up-to-date 语义与结果说明。

## Impact

- 改动：`gitnexus.ts`（parse + 回传）、`command/definition.ts`（输出）、`src/index.ts`（工具字段）、
  README / 常驻系统提示、AGENTS 里程碑。
- 不改变生成行为本身；只让"结果是什么"可被用户直接读懂。
