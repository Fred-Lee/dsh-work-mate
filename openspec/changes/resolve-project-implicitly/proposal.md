# Resolve the Project Implicitly

## Why

用户反馈：`/workmate wiki 当前项目` 被拒（"需要绝对路径（收到 '当前项目'）"）。
"当前项目"其实是**可知道**的——DSH 会话自带工作目录（`agent.session.header.cwd`，
`tool-bash` / `tool-lsp` 用的同一来源），命令与工具却在要求人手贴绝对路径，属于设计缺陷。

## What Changes

1. **隐式解析器**（`src/features/project/implicit-root.ts`）：按固定顺序解析
   `省略/./当前项目/本项目/这个项目/这里/cwd` → 会话 cwd；绝对路径；WorkMate 已注册项目名；
   相对当前项目的路径。都给不出来时**返回候选清单**（当前项目 + 已注册项目），不猜。
2. **`/workmate` 命令**：路径可选（`/workmate wiki`、`/workmate status`）；
   `input.hint` 与用法文本同步；解析结果里写明来源（`当前项目（会话工作目录）` / `已注册项目 X` / `绝对路径`）。
3. **`workmate_wiki_generate` 工具**：`projectRoot` 改为可选——优先会话 cwd，
   会话无 cwd 时回退"唯一已注册项目"，多项目则报错并列出候选。

## Capabilities

### 新增能力

- `project-resolution`：隐式项目解析（会话 cwd / 注册项目名 / 相对路径 + 候选提示）。

## Impact

- 新增 `implicit-root.ts` 与测试；`parse.ts`（路径可选）、`command/definition.ts`、
  `src/index.ts`（工具 schema 与解析）、README/系统提示、AGENTS 里程碑。
- 既有行为不变：给了绝对路径就照旧；只是**不再强制**要求路径。
