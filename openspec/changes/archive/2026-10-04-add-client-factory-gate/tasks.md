# Tasks — Add Client Factory Gate

- [x] 1. `scripts/check-client-factory.mjs`：VM 求值 + 断言（load 次数 / id / apply /
      inject / external 白名单默认拒绝）+ 可复用导出 `evaluateClientFactory`
- [x] 2. `scripts/check-client-factory.test.mjs`：好 bundle、双次 load、错 id、
      越白名单 require、apply 非函数、DOM 访问不炸、语法错可读
- [x] 3. `package.json`：`verify` 增加 `node scripts/check-client-factory.mjs`
- [x] 4. 文档：AGENTS.md 常用命令 + 契约章节（"这条门禁就是那道单元测试"）、README 常用命令
- [x] 5. 验证：`pnpm build` → `pnpm verify`（四条门）+ `pnpm test:toolchain`
