# Tasks — 测试自证门禁

> 范围声明用行内 `<!-- writes: … -->`（swarm 装批 + `workmate_plan_drift` 都读它）。
> 本变更不新增任何依赖。

- [x] 1. 规格增量 `specs/test-integrity/spec.md`：四条判据（全集⊆执行、执行⊆全集、无 skip/todo/failed 且 passed>0、include 显式声明；全集须由仓库独立发现而非复用 include）<!-- writes: openspec/changes/harden-test-integrity/specs/** -->

- [x] 2. 门禁脚本 `scripts/check-test-integrity.mjs`：`parseInclude` / `discoverTestFiles` / `executedFiles` / `evaluateIntegrity` 纯函数 + 薄主流程（`import.meta.url === file://argv[1]` 才执行），跑 vitest JSON reporter 后交叉核对，逐条红因并 exit 1 <!-- writes: scripts/check-test-integrity.mjs -->

- [x] 3. 脚本自测 `scripts/check-test-integrity.test.mjs`：四类假绿各一条（文件没执行 / 执行了 include 之外 / skip 与 todo / 空跑与全红）+ 解析与归一化用例，随 `pnpm test:toolchain` 跑 <!-- writes: scripts/check-test-integrity.test.mjs -->

- [x] 4. 接线 `package.json`：新增 `verify:test`，并把 `pnpm verify` 扩为五道门（`verify:test` 放最后，先让秒级门禁失败）<!-- writes: package.json -->

- [x] 5. 文档：`AGENTS.md` 常用命令与验证纪律写明第五道门；`README.md` 验证章节写明"证明什么 / 不证明什么" <!-- writes: AGENTS.md, CLAUDE.md, README.md -->

- [x] 6. **反证验收**（本变更的核心证据，必须做）：① 在 `include` 只留 `src/features/quality/**` 时门禁必须红（改窄前会报绿）；② 加一条 `it.skip` 时门禁必须红；③ 复原后门禁必须绿。三条结果写进 `review.md` <!-- writes: openspec/changes/harden-test-integrity/review.md -->

- [x] 7. 收口：`pnpm typecheck && pnpm test:toolchain && pnpm build && pnpm verify`（`verify` 现在含测试）<!-- 无仓库内写入 -->

## 验收命令（每步都跑，不以退出码判定）

```bash
pnpm test:toolchain
pnpm verify:test
pnpm verify
```

## 完成标记纪律

`[x]` 只表示"这一步被认为完成了"。第 6 项是**反证**：必须给出"改坏时红、复原后绿"的
实测输出，不能只写"已加门禁"。
