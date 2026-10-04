# client-build-gate Specification

## Purpose
TBD - created by archiving change add-client-factory-gate. Update Purpose after archive.
## Requirements
### Requirement: 客户端工厂求值门禁

项目 SHALL 提供一条门禁，在 VM 中真求值客户端构建产物 `dist/client/client.js`，并断言：
`window.__ModuleLoader__.load` 恰好被调用一次、`id` 等于本包 `package.json` 的 `name`、
`factory` 返回值上有函数 `apply`、声明的 `inject` 是字符串数组、且 factory 通过 `require`
请求的名字全部落在白名单内（白名单之外 SHALL 失败）。求值 SHALL 有超时上限，
且 SHALL 不因模块访问 DOM/浏览器全局而失败。

#### Scenario: 完好产物通过

- **WHEN** 对 `pnpm build` 产出的 `dist/client/client.js` 运行门禁
- **THEN** 退出码为 0，并打印 id、apply 类型与 external 依赖面

#### Scenario: 越白名单依赖被拒

- **WHEN** 产物里出现 `require('lodash')`
- **THEN** 门禁失败并列出 `lodash`

#### Scenario: 装载契约写错被拒

- **WHEN** 产物的 load id 与包名不一致，或 factory 未导出 `apply`
- **THEN** 门禁失败并给出具体不符项

### Requirement: 门禁自测

门禁 SHALL 自带用例（随 `pnpm test:toolchain` 运行），覆盖至少：完好产物、`load` 被调用
两次、id 不符、越白名单 require、`apply` 非函数、访问 DOM 全局不失败。

#### Scenario: 自测随工具链用例一起跑

- **WHEN** 运行 `pnpm test:toolchain`
- **THEN** 门禁用例被包含且全部通过

