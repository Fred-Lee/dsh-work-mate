# Add Decision Layer (typed judgments, agent-backed)

## Why

流程里有一批**高频、封闭、可验证**的判断节点，现在是机械处理或空缺：审查发现的分级、
决策是否语义矛盾、外部文本是否夹带指令、变更风险等级、任务是否真的完成。它们不值得动用
"让 agent 自由读一遍然后写段话"，但也确实需要语义判断——这正是 Jev 那类**判断模型**的
定位（TypeSafe System One：给 state + 类型化题目，返回选项概率，不生成文本）。

用户没有 TypeSafe key，所以本变更用**宿主自己的 LLM 服务**（`ctx.llm`）承担同一角色：
把题目**约束成一次强制工具调用**（单一 tool、`enum` 选项），拿到的就是类型化答案——
Jev 的 `Choice` 的等价物。provider 抽象成 `rules | agent | jev`，key 到位后加一个适配器
即可，调用方与门禁逻辑一行不改。

## What Changes

1. **判断层**（`src/features/decision/`）：
   - `DecisionQuestion`（节点、state 文本、题干、固定选项）；
   - provider：`rules`（确定性兜底）、`agent`（host `ctx.llm`，强制单 tool 调用，
     多采样取多数并把一致率当 certainty 代理）、`jev`（接口占位，未配置即不可用）；
   - **阈值归 WorkMate**：`certainty ≥ act → act`；`≥ review → review`；否则 `abstain`；
   - **降级**：provider 缺失/超时/答不出 → 换下一个 provider（agent → rules），
     仍无结论则 `abstain`，并在事件里记 `degraded`。
2. **审计**：每次判断向提案事件流写一条 `kind: "decision"` 事件
   （node / choice / action / certainty / provider / model / threshold / latency）。
3. **第一个消费点**：`workmate_proposal_decide` 的**语义矛盾检测**——新决策与既有决策
   矛盾、且调用方没给 `supersedes` 时，若判断为 `act` 则拒绝并提示补 `supersedes`。
   现在只机械校验"supersedes 指向的 id 是否存在"，判不出"你其实在推翻某条旧决策"。
4. **配置**：`Config.decision`（默认 `enabled: false` —— 门禁里发起模型调用必须显式开启）。

## Capabilities

### 新增能力

- `decision-layer`：类型化判断节点、provider 选择（rules/agent/jev）、阈值动作与审计事件。

## Impact

- 新增 `src/features/decision/{types,rules,agent,service}.ts` 与测试；`events.ts` 加
  `decision` 事件；`config.ts` 加 `decision`；`index.ts` 实例化并在 decide 工具里消费。
- **安全边界（写死）**：模型判断**只能收紧、不能放松**——它可以把一次推进/决策标成
  `review`/`abstain` 或拒绝，`SHALL NOT` 用来放行任何确定性门禁本来会拦的操作。
- **不做**：不把判断层放进 `merging/archiving` 的放行路径；不做 Jev 的真实 HTTP 适配器
  （无 key，接口占位）；不自动改写 review.md。
