# Design — Adopt DSH-native Config and Guidance Surfaces

## D1 Config 用 Schemastery，与 profile 内 dsh-tools 同一条线

宿主识别插件的 Config 是一个**身份检查**（不是鸭子类型）：

```ts
// packages/boot/app-boot/src/config-schema/native.ts:11-16
Reflect.get(value, Symbol.for('schemastery')) === true
  && typeof Reflect.get(value, 'type') === 'string'
  && meta !== null && typeof meta === 'object'
```

本机实测：`z.object({...})` 三个条件全真，`s({})` 直接给出全部默认值。因此
`Config` 必须由**真的 Schemastery** 构造；不允许手搓同名 symbol（后续投影会按
Schemastery 内部图结构遍历字段，伪造必炸）。

版本选择：profile 实装的 `@deepseek-ai/dsh-tools@0.1.2-alpha.5` 自身依赖
`@deepseek-ai/schemastery@^3.18.2`，我们声明同一区间（装到 3.18.2），
`toolchain.json` 的 `runtime` 段记录该区间（它不是 `require` 门禁项：那份门禁管的是 devDependencies 里的 kernel 钉子）。多一份 copy 不影响身份检查（`Symbol.for` 是
全局注册表，brand 由创建者打上），宿主投影器只读结构字段、不 `instanceof`。

`resolveConfig` 保留：它管的是"显式 `undefined` 不覆盖默认"，而 schema 管的是宿主
边界的校验与 UI 投影，两者不冲突；`apply(ctx, config = {})` 的行为因此完全不变。

## D2 用 runtime skill，不用 skill provider

`SkillRegistry` 提供两条路：

| 路径 | 适用 |
|---|---|
| `registerProvider(create)` | 目录/远端来源、需要 `list()` 异步发现、多个候选 |
| `register(skill)` | 静态文本、随 fiber 处置自动注销的"borrowed readonly runtime skill" |

我们只有两段静态 Markdown，选 `register`：`ctx.inject(['skills'], scope =>
scope.effect(() => scope.skills.register({...})))`，fiber 卸载即注销，无残留。
`invocation` 省略 = 模型与用户都可调用（`SkillRegistration` 的默认）。

技能名用 kebab-case（`isSkillName` 校验通过）：`workmate-proposal-flow`、
`workmate-proposal-audit`。内容取自既有资产（`assets/quality/claude/rules/*.md`、
`agents/proposal-auditor.md`）并按 DSH 工具面改写（工具名从 `mcp__gitnexus__*`
改成 `workmate_knowledge_query`）。

## D3 `.claude/**` 保留，但说清适用面 + 加开关

证据：DSH 里 `.claude` 只有一条读取路径——`@deepseek-ai/dsh-hooks-claude-code`
（第一方桥，跑 Claude Code 的 `settings.json` hooks，能阻断工具调用）。本机
profile 既没装这个包、bundle 里也没有它的行，所以：

- 交付到目标项目的 `.claude/settings.json` PreToolUse hook **在 DSH 下当前不执行**；
  它服务的是同一仓库里跑 Claude Code 的人。
- 因此这批资产不是"错的"，而是**受众不同**：DSH 用户拿 skill，Claude Code 用户拿
  `.claude/**`。README 写明；`claudeAssetsEnabled`（默认 true）给不需要它们的项目
  一个开关。
- 默认值翻转（true→false）会让现有的 Claude Code 用户静默失去提交标记拦截，
  属于产品决策 → 记入"待用户决策"，不在本变更里翻转。

hook 合并的老纪律不变：按 hook 命令全文去重、既有用户 hook 原样保留、已存在文件
永不覆盖（`src/features/quality/sync.ts:95-114`）。

## D4 systemPrompt 段落与工具描述的边界

- **段落**（`order: 30`，systemPrompt 默认区）写跨工具的纪律与顺序：何时 create、
  decide/block 的触发条件、wiki 登记时机、归档/回退由 WorkMate 编排而非手跑。
- **工具 description** 只写"怎么做"（参数语义、返回值），把重复的 MUST 话术删掉。
- 净效果：纪律从"每个 tool schema 各说一遍"变成"一段话说一次"，且从第一轮就可见。

注册同样是惰性的（`ctx.inject(['systemPrompt'], …)`）：没有该服务的组合里插件照常
工作，只是少了这一段。

## D5 非目标

- REST → `@Remote` + `ctx.remote.$on`、归档改原生 `jobs`：Step 3，独立变更。
- `presentCall` / `presentResult` 渲染意图：需要逐卡片设计，独立变更。
- 把 `proposal-auditor` 做成 agent preset（`~/.dsh/.agent-presets/`）：skill 已能覆盖
  审查规程，且 skill 随插件走、不需要写用户目录；需要真正独立子代理时再评估。
