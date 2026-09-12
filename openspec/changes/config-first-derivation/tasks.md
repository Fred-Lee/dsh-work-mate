## 1. 扫描层：scope 选项（memory-topology，等漂移车道落地后实施）

- [ ] 1.1 `scan-outbound.ts`:`OutboundScanOptions` 新增 `scope?: 'config' | 'full'`(默认 `'config'`);walk 在 `config` 下只收集配置扩展名文件,源码文件不入扫描(不读内容)
- [ ] 1.2 `config` 范围沿用既有配置解析与资源上限(`maxConfigFiles`/`maxConfigFileBytes`/containment);不发起网络请求(回归测试保护)
- [ ] 1.3 单测:`config` 不读 `.java`/`.ts`(用含哨兵内容的源码文件验证未读取);`config` 从 `feign-client-config.<svc>.url` 产出名称档候选;`full` 与现行为一致;空配置仓库 → 零候选

## 2. 推导层：透传与标注

- [ ] 2.1 `derive-dependencies.ts`:`deriveDependencies(topology, { scope })` 透传;结果新增 `scope` 与来源类别计数(配置线索/代码线索)
- [ ] 2.2 服务面 `deriveDependencies(group, opts?)` 与漂移入口透传 scope
- [ ] 2.3 单测:结果含 `scope`;候选证据可区分来源;`config` 下无端点明细候选

## 3. UI 与漂移措辞（ui-dashboard）

- [ ] 3.1 「推导候选」默认快扫,提供「深度扫描(含代码)」勾选并说明代价与增益;结果区展示 scope 与来源计数
- [ ] 3.2 漂移核对默认 `config`;`staleDeclared` 措辞调整为"未在(配置)扫描范围内找到证据"并保留人工确认引导
- [ ] 3.3 单测:默认调用为快扫(请求载荷断言);深扫勾选改变载荷;措辞随范围变化

## 4. 文档与验证

- [ ] 4.1 `docs/USAGE.md`:两种范围的含义与取舍(含"扫描不消耗 token、深扫用于要端点明细"的说明)、切换时机
- [ ] 4.2 `docs/ARCHITECTURE.md`:scope 语义贯穿两层的设计与默认值理由
- [ ] 4.3 `docs/VERIFICATION-GUIDE.md`:可复现步骤(真实仓库 config 快扫秒级出 7 条名称档候选;深扫差异对比)
- [ ] 4.4 全仓 `pnpm typecheck && pnpm test` 通过
- [ ] 4.5 真机冒烟(父对话):在真实项目群上分别跑 config 与 full,对比候选数量/明细/耗时并记录