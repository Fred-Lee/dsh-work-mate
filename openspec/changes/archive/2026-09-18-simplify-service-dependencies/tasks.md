## 1. 模型与归一化（memory-topology）

- [x] 1.1 `types.ts`:为 `RestDependencyEdge` 补文档,明确 `endpoints: []` + `method: '*'` 表示服务级边;新增常量(如 `SERVICE_LEVEL_METHOD = '*'`)与判定辅助 `isServiceLevelEdge(edge)`
- [x] 1.2 `normalizeTopology`:**不把空明细填成默认值**(空 `endpoints` 保持为空、`'*'` 保持 `'*'`);对既有已填明的边保持原样
- [x] 1.3 `types.ts`:新增 `mergeDependencyEdge(existing, incoming)`(按 (from,to) 合并、明细按 (method,endpoint) 二次去重)与 `dedupeDependencies(topology)`(对整图按 (from,to) 归并重复对)
- [x] 1.4 单测:服务级边往返保持形态(`endpoints: []`、`method: '*'` 不被改写成 `GET`);带明细边往返不变;`mergeDependencyEdge` 合并与去重;`dedupeDependencies` 把重复对归并为一条

## 2. 保存路径去重（服务端不变量）

- [x] 2.1 `saveTopology` 写入前执行 `dedupeDependencies` + 归一化,保证"同一对服务只有一条边"对导入/HTTP/前端三条写入路径同时成立
- [x] 2.2 单测:同一份含重复对的拓扑保存后只留一条边;连续保存两次幂等(第二次不改动依赖集合)

## 3. 图级体检

- [x] 3.1 新增 `graph-health.ts`:`checkGraph(topology) → { cyclic, cycles: string[][], dangling: Array<{from,to}>, isolated: string[] }`,含环检测(DFS/栈,返回环成员而非仅布尔)
- [x] 3.2 拓扑服务面暴露只读入口(如 `checkHealth(group)`),不改动 `loadTopology` 既有返回形状
- [x] 3.3 `computeDownstream` 的 `cyclic` 与 `cascadeOrder` 的降级行为保持不变(回归测试保护)
- [x] 3.4 单测:`A→B→A` 报出环及成员;`toServiceId` 不在 services 时报悬空;无入出边的服务报孤立;干净图返回空问题列表

## 4. UI：表单简化与展示降级（ui-dashboard）

- [x] 4.1 `DependencyModal`:默认只需「调用方 / 被调用方」两个下拉即可保存;「HTTP 方法 + 端点路径」移入可折叠的「端点明细(可选)」区;不填时提交服务级边(`endpoints: []`、`method: '*'`)
- [x] 4.2 依赖行渲染:无明细 → `调用方 ──▶ 被调用方`;有明细 → 保留现有形态(不留 `GET ` 残缺文本)
- [x] 4.3 保存后调用体检接口并以告警条呈现环/悬空/孤立(仅提示,不阻断保存);干净时不显示
- [x] 4.4 `api.ts`:新增只读体检路由(如 `GET api/topology/health?group=`),转发到拓扑服务
- [x] 4.5 单测:无明细行渲染断言(不含方法名/尾随空白);体检告警渲染;路由转发与 404 语义

## 5. orchestrator 注入文本

- [x] 5.1 `describeTopology`:无明细边渲染为 `- A --▶ B`(不出现 `--*-->` 与尾随空格);有明细保持现状
- [x] 5.2 单测/断言:`cascade: true` 且含服务级边时,注入文本形态正确

## 6. 文档与验证

- [x] 6.1 `docs/USAGE.md`:依赖录入新流程(两次下拉即可)、端点明细为可选、体检告警含义
- [x] 6.2 `docs/ARCHITECTURE.md`:补充服务级边编码与体检职责
- [x] 6.3 `docs/VERIFICATION-GUIDE.md`:新增可复现步骤(两条 `curl` 即可验证:服务级边保存 → 只一行;重复添加 → 仍只一行;构造 `A→B→A` → 体检报告出环)
- [x] 6.4 全仓 `pnpm typecheck && pnpm test` 通过;`git status` 仅触及本变更文件
- [x] 6.5 真机冒烟(父对话执行,`作业服务群`):服务级边保存后**空明细与 `*` 原样保留**、依赖区仅 1 行;重复添加 4 条 → 合并为 1 条且明细去重;相同内容再存 → 文件字节一致(幂等);构造 `A→B→A` → 体检报出环及成员 `[homework-server, internal-homework]`;构造悬空引用 → 报出 `{from, to}`;干净图 → 无告警。冒烟后拓扑已备份还原(文件指纹一致)