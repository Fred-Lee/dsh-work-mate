# Deterministic Pre-screen for the Injection Judgement

## Why

真机验收暴露**误报**：一个 notes 只是普通中文说明的提案被判 `risky` →
被标 `provenance.untrusted: true`。判定**确实在工作**，但对无害文本过于敏感——
**一个对正常文本报警的判断，会教用户忽略它**，这比"没实现"更糟。

## What Changes

1. 新增确定性前置筛（`src/features/decision/injection.ts`）：只对**看起来像指令**的文本送模型，
   特征包括指令覆盖（ignore previous / 忽略以上）、角色劫持（you are now / 你现在是）、
   凭据外泄（reveal api key / 泄露密钥）、门禁绕过（skip gates / 跳过审批）、
   自称批准（approve your own / 自行批准）、危险命令（`rm -rf` / `curl http…`）；
2. **无特征 → 直接判 `benign` 且不调模型**，同时写一条 `decision` 事件
   （`provider: 'rules'`，detail 注明 `no injection markers`）——便宜、确定、可审计；
3. **有特征 → 仍走模型严格判定**（筛子只决定"要不要问模型"，绝不代替判定）；
4. 事件 detail 记录命中的特征名，便于复查为什么送判。

## Impact

- `src/api.ts`（两处）、新增 `injection.ts` 与 3 组用例；判定语义与阈值不变，只降低误报与成本。
