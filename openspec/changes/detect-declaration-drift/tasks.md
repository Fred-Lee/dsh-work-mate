## 1. 漂移比对模块（memory-topology）

- [x] 1.1 新增 `declaration-drift.ts`:`checkDeclarationDrift` —— 输出 `{status, consistent[], staleDeclared[], undeclared[], mediumConfidence[], counts}`,以 (from,to) 为键、以声明边为准判定
- [x] 1.2 判定口径:仅高置信候选参与 `undeclared`;中置信进 `mediumConfidence`;`staleDeclared` 附保留措辞(静态扫描可能漏识别)
- [x] 1.3 单测:16 项(一致/陈旧/未声明/中置信分列/目标未登记/全一致为空/保留措辞不含"不存在")

## 2. 服务面只读入口

- [x] 2.1 服务面 `checkDeclarationDrift(group, service?)`:读 localPath 声明 + 推导候选 → 比对;`no-declaration` 列出全部代码证据为未声明(非错误);新增 `no-repo-path` 状态
- [x] 2.2 只读保证:声明文件与拓扑文件字节不变(单测断言)
- [x] 2.3 单测:+6 项(状态语义/字节不变/损坏报错且不扫描)

## 3. UI（ui-dashboard）

- [x] 3.1 「🔎 漂移核对」结果区:三组 + 中置信单列、服务对与证据、保留措辞、计数;无漂移时不渲染(按钮给"未发现漂移"提示)
- [x] 3.2 `undeclared` 条目跳既有候选确认流程;目标未登记一并标出
- [x] 3.3 无声明文件时显示引导态(证据列为未声明)
- [x] 3.4 路由 `GET api/topology/drift`(group+service 必填),语义与既有路由一致
- [x] 3.5 单测:+12 项(渲染/计数/措辞/引导/available:false/错误路径)

## 4. 文档与验证

- [x] 4.1 `docs/USAGE.md`:三组含义、"未找到证据 ≠ 不存在"、处置建议
- [x] 4.2 `docs/ARCHITECTURE.md`:两个输入面、只读边界、与图级体检的分工
- [x] 4.3 `docs/VERIFICATION-GUIDE.md` §3.9(实现方对齐模块常量核验过,期望输出待父对话实测替换)
- [x] 4.4 全仓 `pnpm typecheck && pnpm test` 通过(568 测试)
- [x] 4.5 真机冒烟(父对话,真实项目群 + 临时仓库,**未写入用户仓库**):构造"1 条真实 + 1 条虚构、漏 6 条"的声明 → 一致 1(internal-homework)/陈旧 1(internal-legacy,带保留措辞)/未声明 6(全部真实遗漏);冒烟后拓扑还原(指纹 IDENTICAL)

## 5. 冒烟暴露的缺陷修复（父对话）

- [x] 5.1 **声明解析器不剥行内注释**:`- to: internal-homework  # 注释` 的注释进入值内,导致该边永远匹配不上代码证据(全判陈旧)、应用后写入垃圾服务 id——手改 YAML 的最常见写法。修:`parseDeclaration` 的 service/to/method/endpoints 标量读取统一剥除"空格+#"起的行内注释(`/path#frag` 无空格不受影响);补 2 个回归测试(注释剥除 + 片段保留),168 测试通过
- [x] 5.2 修复后真机复验:一致 1 / 陈旧 1 / 未声明 6,与人工认知完全一致
