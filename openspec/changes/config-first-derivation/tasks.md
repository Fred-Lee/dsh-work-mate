## 1. 扫描层：scope 选项（memory-topology）

- [x] 1.1 `scan-outbound.ts`:`OutboundScanOptions` 新增 `scope?: 'config' | 'full'`(模块级默认 `'full'`,向后兼容);walk 在 `config` 下只收集配置扩展名文件,源码文件**不计预算、不读内容**
- [x] 1.2 `config` 范围沿用既有配置解析与资源上限;不发起网络请求(回归保护)
- [x] 1.3 单测:config 范围下 `.java` 文件中的 Feign 客户端**不成为候选**(哨兵断言);`full` 与现行为一致

## 2. 推导层：透传与标注

- [x] 2.1 `derive-dependencies.ts`:`DeriveOptions.scope`(产品层默认 `'config'`,显式 `options.scan.scope` 仍可覆盖);结果新增 `scope` 回显与 `sources: { config, code }` 计数
- [x] 2.2 服务面 `deriveDependencies(group, opts?)` 与 `checkDeclarationDrift(group, service?, scope?)` 透传
- [x] 2.3 单测:默认 config(源码中的 Feign 客户端不出现);显式 full 恢复;来源计数正确;结果带 scope

## 3. UI 与漂移措辞（ui-dashboard）

- [x] 3.1 「🔍 推导候选（快扫）」为默认;新增「🔬 深度扫描（含代码）」按钮(title 说明代价与增益);完成后 toast 标明范围
- [x] 3.2 漂移核对默认 config;`staleDeclared.reason` 随范围变化——快扫「未在配置扫描范围内找到证据」、深扫「未在代码中找到证据」;`DeclarationDriftResult` 回显 `scope`
- [x] 3.3 路由 `GET api/topology/derive?scope=`;client `topologyDerive(group, scope)`;单测同步(默认调用载荷、按钮名、旧断言更新)

## 4. 文档与验证

- [x] 4.1 `docs/USAGE.md`:两种范围的对照表(读什么/产出什么/为什么默认快扫)、「不消耗 token」的说明、漂移措辞随范围变化
- [x] 4.2 `docs/ARCHITECTURE.md`:scope 分层决策(模块级默认 full、产品层默认 config 的理由)
- [x] 4.3 全仓 `pnpm typecheck && pnpm test` 通过(576 测试)
- [ ] 4.4 真机冒烟(父对话):真实项目群 config vs full 对比(候选数/明细/耗时)
