# Add Wiki Generation (one command per project)

## Why

知识面目前只有"读"：`workmate_knowledge_query`（query/context/impact）、
`workmate_knowledge_search`（WeKnora 文档），加上归档时的 `gitnexus analyze` 重建索引。
**没有任何"把索引变成人可读的项目 wiki"的入口**——而这正是 GitNexus 自带的能力
（`gitnexus wiki <path>`：按知识图谱分组模块，逐模块生成文档 + `index.html` 阅读器）。

对一个**已有项目**（不需要先建提案）来说，"我想给这个仓库生成一份 wiki"是高频、独立的需求；
现在只能让人去终端敲 CLI，还要自己记住"先 analyze，否则 wiki 基于过期图谱"。

## What Changes

1. **桥接层**（`knowledge-bridge/gitnexus.ts`）新增两个动作：
   - `gitnexusStatus()`：只读探针，判断索引是否 **stale**（分支/提交变过）；
   - `gitnexusWiki()`：生成 wiki，产物固定在 `<项目>/.gitnexus/wiki/`（含 `index.html`），
     支持 `force` / `lang` / `review` 与可配超时。
2. **工具** `workmate_wiki_generate`：`{projectRoot, analyze?, force?, lang?, review?}`。
   默认先跑一次只读 `status` 并把 `stale` 如实返回（不擅自重跑 analyze）；
   `analyze: true` 时先 `gitnexus analyze` 再生成，保证 wiki 基于最新图谱。
3. **REST** `POST /api/wiki`（同样的载荷），方便脚本/CI 一次性调用。
4. **配置**：`gitnexusWikiLang`（默认空 = GitNexus 自己的默认，可设 `chinese`）、
   `gitnexusWikiTimeoutMs`（默认 15 分钟——wiki 是逐模块 LLM 生成，慢是正常的）。

## Capabilities

### 新增能力

- `wiki-generation`：项目 wiki 生成入口（工具 + REST），带回索引新鲜度与产物路径。

## Impact

- 改动：`knowledge-bridge/gitnexus.ts`、`src/index.ts`（工具）、`src/api.ts`（REST）、
  `src/config.ts`（两个开关）、README / guidance。
- **代价与边界**：wiki 生成是**逐模块 LLM 调用**（用 `~/.gitnexus/config.json` 里已配的
  provider/key），大仓库可能跑十几分钟——所以默认不触发，必须显式调用；超时与并发由
  GitNexus 侧控制，WorkMate 只负责把结果与失败原因如实带回。
- 与既有能力的关系：`workmate_wiki_link` 登记的是 **WeKnora 页面引用**（提案级），
  本能力生成的是 **GitNexus 仓库 wiki**（项目级），两者互补不重叠。
