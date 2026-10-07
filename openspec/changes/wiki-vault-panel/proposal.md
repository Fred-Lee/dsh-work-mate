# Wiki Vault Panel

## Why

vault 导出与检索目前只有三个入口：**工具**、**`/workmate` 命令**、**REST**——都要求用户记得命令或路径。
本次补齐**界面入口**：在 better-sidebar 增加一个 **📚 Wiki 页签**，人不用离开 harness 就能
导出与检索，并看到归类结果与命中位置。

## What Changes

1. `src/client/WikiPanel.tsx`：项目根目录输入 → **导出到 vault**（显示模块/页/迭代数、归类统计、
   是否已提交）；关键词输入 + **词法/语义**切换 → **检索**（结果列出 `文件:行号` + 片段，
   点击复制该位置，便于贴给 AI）。
2. `src/client/index.tsx` 注册第二个页签 `workmate:wiki`（标题 `📚 Wiki`，order 46）。
3. 全部走插件自己的 `/workmate/api/wiki/*`（同源，无需额外鉴权）。

## Impact

- 新增一个客户端组件与一次页签注册；`entry.test.tsx` 的注册次数断言更新为 2（并断言两个 id）。
- 服务端零改动：复用已验证的 `wiki/export` 与 `wiki/search`。
