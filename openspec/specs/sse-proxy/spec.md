# sse-proxy Specification

## Purpose
TBD - created by archiving change manage-sse-proxy. Update Purpose after archive.
## Requirements
### Requirement: SSE 归一代理的按需托管

实现 SHALL 提供一个仅监听回环地址的 SSE 前缀归一代理脚本，并在
`Config.gitnexusSseProxyEnabled` 为 true 时于 wiki 生成前保证其可用：
已运行且转发目标一致时 SHALL 复用现有实例（SHALL NOT 重复启动）；
未运行时 SHALL 以 detached 方式启动并等待健康检查就绪；
转发目标与配置不一致时 SHALL 拒绝复用并给出说明。
代理不可用 SHALL NOT 阻断 wiki 调用，但 SHALL 在结果中如实标注。

#### Scenario: 复用已在运行的实例

- **WHEN** 代理已在监听且 `upstream` 与配置一致
- **THEN** `sseProxy.status` 为 `reused`，且不产生新进程

#### Scenario: 未运行时按需启动

- **WHEN** 代理未运行
- **THEN** 以 detached 子进程启动，健康检查通过后 `sseProxy.status` 为 `started`

#### Scenario: 端口被别的网关占用

- **WHEN** 端口上的代理转发目标与配置不一致
- **THEN** `sseProxy.status` 为 `failed` 且说明不一致，SHALL NOT 把请求转发到错误目标

#### Scenario: 默认关闭

- **WHEN** `gitnexusSseProxyEnabled` 为 false
- **THEN** `sseProxy.status` 为 `disabled`，不探测也不启动任何进程

