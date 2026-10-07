# Vault Views, Better Touches, and Vault Search

## Why

上一轮导出后有三个短板：**看图要自己写查询**、**迭代↔模块的边很稀**、**AI 检索没有入口**。

## What Changes

1. **A. Dataview 视图笔记**（`views.ts`）：每个项目生成 `views.md`（时间线 / 按年分组 /
   被触及最多的模块 / 模块清单 / 最近变更），另在 vault 根写 `_views.md`（跨项目）。
   查询**只用导出器真的写出的字段**（`date`/`status`/`origin`/`derived`/`touches`/`module`），
   没装 Dataview 也有"怎么手读"的替代说明。
2. **B. touches 更强**：
   - 无反引号的裸路径也接受（`src/.../Foo.java`、`WrongQuesRate.java`），仅在 Impact 段内提取，
     上限 12 条，避免中文散文灌水；
   - `touches` 写进 **front-matter**（Dataview 才能查）；
   - **判断层归类**：路径没命中任何模块时，问一次 `module-match`（选项=模块 slug + `none`），
     **只有 `act` 档结论**才成为边；每次导出最多 20 次，走判断缓存。
3. **C. `workmate_wiki_search`**（`search.ts` + 工具 + `/workmate search <关键词>`）：
   在 vault 内做**词法检索**，返回**文件:行号 + 摘要片段**，可直接被引用；支持 `--limit`、
   限定项目、空结果显示"无命中"而不是假装有。诚实说明：这是 grep 式而非语义检索（可解释、永远与文件同步），
   向量索引以后可加而不改契约。

## Capabilities

### 修改的能力

- `vault-export`：视图笔记、touches 增强（front-matter + 判断层归类）。
- `vault-search`（新）：vault 词法检索，返回文件:行号。

## Impact

- 新增 `views.ts` / `search.ts` 与测试；`vault.ts`（front-matter touches、views 写入、归类钩子）、
  `iterations.ts`（裸路径）、`decision/types.ts`（`module-match` 节点）、命令与工具、README/AGENTS。
- 判断层未启用时：归类跳过（只走路径匹配），其余不变。
