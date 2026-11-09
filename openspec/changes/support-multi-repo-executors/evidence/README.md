# 面板 Before / After 证据（多执行器）

变更 `support-multi-repo-executors` 的面板改动很小（顶部健康摘要、未接入仓库卡片的正文提示），
但按交付要求给出同场景的 Before / After 对照。

- **Before（基线）**：`41164fc`（`origin/main`，本分支基线），构建产物 `dist/client/app.js`
- **After（变更）**：本分支工作区（`src/client/TasksView.tsx` + `src/client/api.ts` 的改动）
  同机构建产物 `dist/client/app.js`
- **视口 / 主题 / 状态**：1440×900、默认浅色、任务视图（默认页签）、同一份夹具数据
  （`fixture-tasks.json`：两个执行器端点，一在线一离线；一条可指派待办 + 一条
  `connectable=false`、`unservedRepo=/srv/repo-b` 的待办）
- **采集方式**：两份**真实构建产物**分别用静态服务按 `/workmate/*` 提供，`/workmate/api/tasks`
  返回同一份 `fixture-tasks.json`（其余面板端点返回空数据），无头 Chrome 截图。夹具服务与截图
  脚本是一次性工具（未入库），**没有改动任何 app 代码**。
  复现要点：`pnpm build` → 用静态服务把 `dist/client/` 挂在 `/workmate/`、`/workmate/api/tasks`
  返回本目录 JSON → `chrome --headless=new --window-size=1440,900 --screenshot=... /workmate/`。

## 差异（左列 Before，右列 After）

| 区域 | Before（`before.png`） | After（`after.png`） |
| --- | --- | --- |
| 顶部健康行 | `执行器在线 · http://127.0.0.1:3080`（只读单值，看不到第二台） | `2 个执行器，1 个离线`（逐端点聚合，离线仍可看到在线的那台） |
| 未接入仓库的卡片 | 只有禁用的「仓库未接入」按钮，**看不出是哪条仓库** | 正文多一行 `未接入执行器（仓库 /srv/repo-b）`，指派仍禁用 |

## 限制（诚实声明）

这是**构建产物 + 夹具数据**的渲染对照，**不是**"重启宿主后的真机验收"。真机验收（第二个实例 /
第二仓库、面板可指派、双端点聚合、归档门逐 target）仍需按 `tasks.md` 任务 12 由人重启宿主后执行；
jsdom 无布局引擎，真实宿主内的换行 / 深色 / 窄屏仍需人工看一眼。
