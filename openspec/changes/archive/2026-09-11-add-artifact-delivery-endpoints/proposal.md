## Why

Helmsman 的交付物目前只以两种方式触达用户:磁盘上未提交的 markdown/JSON 草稿,或被 git 提交进基础仓库。没有任何途径可以下载一份已完成的工作台草稿、一份已归档的知识笔记、或一个打包了某任务全部 agent diff 的产物包。MOVO 平台验证了 Helmsman 所缺的交付形态:产物有稳定身份、写入存储层(本地文件系统,OSS 场景回退为带签名 URL 的下载)、经由专用端点可下载,并做"权威交付去重"——重复导出相同内容不会产生重复劳动。本次变更给 Helmsman 加上一个轻量产物交付层——下载端点、把任务结果打包成产物包、为产物提供确定性身份——同时保持运行在既有 loopback 服务器与文件系统状态之上。

## What Changes

- 在 `~/.helmsman/artifacts/` 下新增产物注册表:确定性身份(基于 sha256 的对象路径 + 原始文件名元数据)+ 一份交付清单(manifest),把逻辑产物(草稿、归档笔记、任务 diff 包、topology YAML)映射到已存对象。
- 新增由插件 web 宿主提供的 REST 下载端点(同源于 DSH loopback 服务器):`GET /api/artifacts/:id`,带正确的 `content-disposition` 文件名(顺带修复现有 topology YAML 端点把 YAML 误标成 `.json` 文件名的问题)。
- 新增打包能力:任务结果(worktree diff 收集得到的各 agent diff、决定/合并状态)打包成可下载的 `.patch` 包/补丁集;工作台草稿与归档知识笔记可下载为 `.md` 文件。
- 同内容复用:当某生成产物的内容哈希与既有对象一致时,注册表返回既有产物 id,而非重复存储。
- 全部保持客户端 + loopback:不引入对象存储 SDK,鉴权不超出 loopback 服务器现状;存储抽象可替换(local 先行、OSS 之后),无行为变化。
- 范围边界:本变更不新增 docx/pptx/xlsx/pdf 生成——那仍属于 DSH 侧文档技能;Helmsman 只交付它自己已产出的内容。

## Capabilities

### New Capabilities
- `artifact-delivery`:确定性产物注册表(内容寻址存储 + 交付清单)与 Helmsman 自产交付物的同源下载端点,含任务结果打包与内容哈希去重。

### Modified Capabilities
<!-- 暂无。 -->

## Impact

- `packages/ui-dashboard`:修正 topology YAML 导出端点;新增任务产物包下载。
- `packages/ui-workbench`:草稿/指令/归档笔记以可下载产物形式呈现(`src/index.ts` REST 宿主、`client/App.tsx`)。
- `packages/knowledge-tolaria`:归档笔记导出路径(只读,经 vault 门面)。
- 新增共享产物存储模块(本地存储 + 注册表 + 清单);哈希/去重/下载头的单元测试。
- 文档:`docs/USAGE.md`、`docs/ARCHITECTURE.md`。
