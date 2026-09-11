# artifact-delivery Specification

## Purpose
TBD - created by archiving change add-artifact-delivery-endpoints. Update Purpose after archive.
## Requirements
### Requirement: 内容寻址产物存储,身份确定
系统 SHALL 把 Helmsman 自产产物存储在 `~/.helmsman/artifacts/` 下的注册表中,以内容哈希(产物字节的 sha256)为键;交付清单 SHALL 为每个产物记录稳定 id、逻辑名、原始文件名、MIME 类型、大小、创建时间与生产者元数据(草稿 id、任务 id、归档笔记路径、topology 组)。当注册的产物字节哈希已存在时,SHALL 返回既有产物 id,而非重复存储。

#### Scenario: 相同内容再导出被去重
- **WHEN** 某草稿的字节与此前注册过的产物完全一致而再次注册
- **THEN** 不存储新 blob,返回既有产物 id 及其原始元数据

#### Scenario: 产物在宿主重启后仍存在
- **WHEN** 注册若干产物后宿主重启
- **THEN** 注册表列出同样的产物、元数据完好,blob 仍可下载

### Requirement: 带正确交付头的同源下载端点
Helmsman web 宿主 SHALL 暴露 `GET /api/artifacts/:id`,流式返回已存字节,`Content-Disposition` 使用产物原始文件名、`Content-Type` 正确;未知产物 id SHALL 返回 404。现有误标内容的导出路径(把 YAML 以 `.json` 文件名导出的 topology 导出)SHALL 修正为以真实文件名与类型交付。

#### Scenario: 草稿以其真实文件名下载
- **WHEN** 操作者下载某份已注册的 markdown 草稿
- **THEN** 响应为 `Content-Type: text/markdown`、`Content-Disposition: attachment; filename="<原始>.md"`,响应体为草稿字节

#### Scenario: 未知产物 id
- **WHEN** 客户端请求一个注册表中不存在的产物 id
- **THEN** 响应为 404,不流式返回任何字节

### Requirement: 任务结果打包
系统 SHALL 能把某任务的结果注册为交付产物包:各 agent 的补丁(来自 worktree diff 收集)+ 一份含任务 id、agents、基础 sha 与 merge/discard 状态的清单,组合成单个可下载补丁包并附机器可读的伴生 JSON。该包 SHALL 与其他产物一样内容寻址,因此重复请求同一任务的包不会重复存储。

#### Scenario: 舰队运行可下载为一个包
- **WHEN** 操作者下载某多 agent 任务完成后的结果包
- **THEN** 响应为单文件,包含各 agent 补丁与清晰分隔符和任务元数据,外加描述 agents 与状态的伴生 JSON

### Requirement: Helmsman 自产内容统一可注册
草稿、归档知识笔记、topology 导出与任务包 SHALL 通过同一个产物 API 注册,而不是各自为政的按功能导出代码,使 Helmsman 产出的每个交付物都可在注册表中发现、可凭 id 下载。

#### Scenario: 归档笔记可下载
- **WHEN** 操作者把一份工作台草稿归档进 Tolaria vault,随后从产物列表下载它
- **THEN** 归档笔记从注册表以其文件名与 markdown 类型提供

#### Scenario: 注册表列出全部交付物类型
- **WHEN** 操作者在产出草稿、笔记、topology 导出与任务包后打开产物视图
- **THEN** 每个交付物都带其类型、生产者元数据与下载动作出现

