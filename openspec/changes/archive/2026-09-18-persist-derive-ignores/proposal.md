## Why

推导候选里会出现**外部基础设施**目标(真机冒烟中 `oss`、`bapi` 来自 `oss.url` 等配置键):它们不是错
(服务确实调用这些端点),也不是微服务拓扑里要登记的"服务"。现状的「忽略」只是**前端本地状态**——
下次推导(或刷新页面)它们会原样回来,用户每轮都要再忽略一次。加"忽略并记住":忽略落盘、跨会话生效、
可恢复;推导与漂移核对都尊重忽略清单。

## What Changes

- 忽略清单按项目群持久化于 `~/.helmsman/derive-ignores.json`(原子写,`HELMSMAN_HOME` 感知),
  键为 `from→to` 服务对。
- 推导入口接受排除集,被忽略的候选**在推导层被过滤**(结果回显 `excluded` 计数)——因此普通推导与
  **漂移核对**的「未声明」清单同时干净(漂移复用同一推导路径)。
- 服务面新增 `ignoreCandidates(group, keys[])`(记住)与 `restoreIgnoredCandidates(group, keys?)`
  (恢复,缺省全部)。
- UI:「忽略」按钮改为**落库**;结果区显示「已忽略 (N)」折叠清单,可逐条恢复;推导结果 toast 计数
  含已忽略。
- 不改变候选判定、置信度、确认落库等任何既有语义——只加"记住不要"。

## Capabilities

### New Capabilities
- `derive-ignore-list`:推导候选的持久化忽略清单——按服务对记住、推导与漂移共同尊重、跨会话存活、可恢复。

### Modified Capabilities
<!-- 无:候选生成/确认落库/漂移判定的既有要求不变。 -->

## Impact

- `packages/memory-topology`:新增 `derive-ignores.ts`(存取)+ `derive-dependencies.ts`(排除过滤)+
  `index.ts`(服务面方法、推导/漂移路径装排除集);单测。
- `packages/ui-dashboard`:`api.ts` 两个路由 + `client/api.ts` + `App.tsx`(忽略落库、已忽略清单与恢复);
  单测。
- `docs/USAGE.md`、`docs/VERIFICATION-GUIDE.md`:忽略/恢复流程。
