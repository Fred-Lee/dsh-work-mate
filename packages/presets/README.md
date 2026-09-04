# @helmsman/presets

Helmsman 的 **L1/L2/L4 生成预设与工具**:ship 4 个 agent 预设(research / prd / decompose / require-analyze),并注册 4 个 `helmsman_*` 生成工具(headless 可直接调用)。

## 功能

- **4 个 agent 预设**(目录含 `agent.cordis.yml` + `preset.yml`),由本包同步进 DSH 的 preset roster(user-root),供会话组合选用。
- **4 个工具**:`helmsman_research` / `helmsman_generate_prd` / `helmsman_decompose` / `helmsman_require_analyze`,走注入的 `helmsman.generator` 服务执行生成。

## 生成契约(关键解耦)

生成引擎通过 `ctx.get('helmsman.generator')` 注入(DI)。本包**只负责**预设文件与工具的"调用方",真正启动 DSH 会话并跑 agent 的工作放在 `helmsman.generator` 实现后面(T0.1 门)。这意味着本包可脱离 DSH 内部会话 API 被单测,也便于未来替换生成引擎。

```ts
interface HelmsmanGenerator {
  generate(req: { preset: 'research'|'prd'|'decompose'|'require-analyze'; input: Record<string, unknown> }): Promise<{ taskId: string; status: string; draftId?: string }>
}
```

若未接线 generator,工具会抛出 `helmsman.generator not available`。

## 依赖

- `@deepseek-ai/cordis`(peer)+ `@deepseek-ai/dsh-tools`(peer,optional)。
- 预设目录经 `installPresets()` 同步到 `~/.helmsman/presets`(可用 `config.presetRoot` 覆盖),最佳努力、不阻塞 apply。

## 现状 / 待接线

- 搜索:DSH 无内建 web 搜索(T0.3),`helmsman-research` 的搜索需另配 adapter,当前预设只含 persona + instructions(可挂载)。
- 生成引擎(`helmsman.generator`):需接 DSH 会话启动(T0.1),本包不实现。
