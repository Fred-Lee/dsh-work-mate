## 1. 模型：边的来源标记（memory-topology）

- [x] 1.1 `types.ts`:`RestDependencyEdge` 新增可选 `source?: 'declared' | 'derived'` 并写清语义;新增辅助 `edgeSource(edge)`(缺省 `'declared'`)
- [x] 1.2 `normalizeTopology` 保留 `source`(只接受两个合法值,其余丢弃为缺省),既有数据无该字段时行为不变
- [x] 1.3 `mergeDependencyEdge` 的来源语义:合并同一对时任一为 `declared` 则结果为 `declared`(声明优先,不被推导降级);明细仍按 (method,endpoint) 去重
- [x] 1.4 单测:往返保留 `derived`;缺字段按 `declared`;非法值被忽略;`declared` + `derived` 合并结果为 `declared`

## 2. 声明文件解析与回写

- [x] 2.1 新增解析器 `declaration.ts`:`parseDeclaration(text)`,校验 `version`/`service`/`dependencies` 必填、`dependencies[].to` 必填;缺失直接报错且不产出部分结果
- [x] 2.2 服务级边(`to` 无 method/endpoints → `endpoints: []`、`method: '*'`)与带明细边均支持;`critical` 透传;产出边一律标 `source: 'declared'`
- [x] 2.3 新增回写器 `renderDeclaration(service, declaredEdges)`:只输出 `declared` 边,与解析器互为往返
- [x] 2.4 新增读取入口 `readDeclaration(localPath)`:文件不存在 → "未声明"结果(非错误);解析失败 → 报出问题且不产出边
- [x] 2.5 单测:最小声明 → 服务级边;带明细保留;缺字段报错且不部分产出;往返无损;回写不含 `derived`;文件缺失非错误;损坏报错不部分应用

## 3. 抓取接入导入流程

- [x] 3.1 新增导入源 `helmsman-declaration`:`importPreview` 支持该 source(文件文本),产出既有 `ImportPreview` 形状;另新增按仓库路径入口 `declarationPreview(group, service)`(带项目群上下文,用于未登记目标判定)
- [x] 3.2 预览中标出**未登记目标**,并可随抓取登记(复用 ③ 的路径)
- [x] 3.3 应用时**调和**:文件中有的补上、文件没有的 `declared` 边移除、`derived` 边原样保留;随后走既有去重与存盘
- [x] 3.4 单测:预览可核对;应用后同一对仅一行;文件删除一条 → 该 `declared` 边消失而 `derived` 边保留;重复应用幂等;未登记目标可登记且无悬空

## 4. UI 入口（ui-dashboard）

- [x] 4.1 「📥 从仓库抓取依赖」:选服务/仓库 → 复用现有导入预览对话框核对 → 应用(含「目标未登记(勾选即登记)」标记与解析错误列表)
- [x] 4.2 「💾 写回声明文件」:展示回写内容与目标路径 + "建议提交到仓库"提示;不执行 git 操作
- [x] 4.3 路由 `GET api/topology/declaration` / `GET api/topology/declaration/render`,错误语义与既有路由一致
- [x] 4.4 单测:抓取入口调用形状;未登记目标标记与登记;回写不含推导边;文件缺失提示

## 5. 文档与验证

- [x] 5.1 `docs/USAGE.md`:声明文件格式(最小与带明细示例)、抓取与回写流程、核对要点、未登记目标处理
- [x] 5.2 `docs/ARCHITECTURE.md`:声明作为导入源、`source` 标记与调和规则
- [x] 5.3 `docs/VERIFICATION-GUIDE.md` §3.8:可复现步骤(该节输出由实现方在临时仓库上实跑得到)
- [x] 5.4 全仓 `pnpm typecheck && pnpm test` 通过;`git status` 仅触及本变更文件
- [x] 5.5 真机冒烟(父对话,真实项目群 + 临时仓库,**未写入用户仓库**):见下方第 6 节记录

## 6. 真机冒烟记录（父对话，作业服务群 + /tmp/decl-smoke）

- [x] 6.1 服务的 `localPath` 指向无声明文件的真实仓库 → `status: missing`(友好提示、非错误)——"文件缺失不报错"实测通过
- [x] 6.2 把 `localPath` 临时指向含声明的临时仓库 → `status: ok`,解析出 2 条服务级边,并**识别出未登记目标 `['internal-qp']`**
- [x] 6.3 应用(勾选登记未登记目标)→ 两条边均带 `source: 'declared'`;`internal-qp` 被自动登记为服务;体检 `dangling: []`(未产生悬空引用)
- [x] 6.4 **调和规则实测**:声明边在文件里 → 保留;`derived` 边不在文件里 → **保留**;声明边从文件移除 → **消失**;重复抓取 → 集合不变(幂等)
- [x] 6.5 **回写实测**:`declared=1 derived=1` 时回写内容**只含声明边**,推导边被排除,并给出提交提示
- [x] 6.6 冒烟后拓扑已还原(文件指纹 `IDENTICAL`),`localPath`/依赖边/服务集合恢复原状;临时仓库已删除;用户仓库**零写入**