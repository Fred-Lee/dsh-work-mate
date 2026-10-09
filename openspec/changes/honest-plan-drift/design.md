# Design — plan-drift 诚实化

<!-- files: src/features/proposal/artifacts.ts, src/features/archive/orchestrate.ts, AGENTS.md -->

## D1 `excluded` 是独立字段，不混进 `missing`

替代方案一：把计划目录前缀从声明里直接删掉。否决——那会让报告里**看不到**提案声明过
自己的 spec 文件，"声明被谁吃掉了"变成一个查不出来的问题。
替代方案二：让 `missing` 的判定自己知道"这个前缀不在 actual 里是因为被排除"。
否决——`computeDrift` 是纯函数，它只知道两个数组，不该内嵌调用方的过滤规则。

所以把过滤规则**显式传进去**（`ignoredPrefixes`），落在里面的声明进 `excluded`：
既不算漂移，也不消失。`driftRatio` 的分母是 `actual`，不受影响。

## D2 前缀相等也算 excluded

`scopeCovers` 的语义是"scope 覆盖 path"。判定一个**声明**是否落在被忽略的前缀里，
不能只问 `scopeCovers(prefix, scope)`：当声明正好等于前缀本身
（`writes: openspec/changes/p1`）时它不满足该式，会被误判成 missing。
因此双向各问一次（`scopeCovers(prefix, scope) || scopeCovers(scope, prefix)`）。
代价是把"前缀的父目录"也算进来——在这里是想要的方向（父目录显然也属于计划目录）。

## D3 `warn` 是第三种 step 状态，而不是塞进 `ok` 的摘要

替代方案：`status: 'ok'` 但摘要里写"另有 2 处未触及声明"。
否决——摘要字符串是给人读的，不是给程序分的；`ok` 里混进"有值得看的东西"，
消费方就没法把"纯绿"和"绿但有话说"区分开（面板、将来的告警都要这个区分）。
新增 `warn` 的成本很低：`service.ts:477` 只查 `failed`，`orchestration.ok` 也不看 `warn`，
所以既有行为逐字不变。

## D4 不把 missing 变成阻断

"声明了 src/a/** 最后没改 src/a/**"有三种正当来源：① 计划收缩了范围；
② 改在了别处（改名 / 抽公共模块）；③ 声明就是写多了。这三者都无法从 git 事实区分，
把它们一律当成失败会逼调用方去删声明——而删除声明是**降低**信息量的行为。
所以：只提示，不阻断。与之相对，`undeclared`（改了没声明）是能被明确判定的事实，
保持 `failed`。

## 风险与回滚

- 风险：`warn` 状态被某个消费方当成"非 ok"处理。已核对全部消费点：
  `service.ts:477` 查 `'failed'`、`service.ts:486` 只做详情拼接、
  `src/client/api.ts` 的类型是 `status: string`。无风险点。
- 风险：`ignoredPrefixes` 传错会掩盖真实 missing。当前只有一个调用方，
  传的就是"从 actual 里被过滤掉的那个前缀"，与过滤逻辑同源。
- 回滚：不传 `ignoredPrefixes` 即回到旧行为（`excluded` 为空数组）；
  `warn` 步骤消失后 `plan-drift` 回到"只在 undeclared 时出现"。数据无需迁移。
