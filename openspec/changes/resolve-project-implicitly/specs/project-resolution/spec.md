## ADDED Requirements

### Requirement: 隐式项目解析

实现 SHALL 在未给出项目路径时按以下顺序解析：会话工作目录
（`agent.session.header.cwd`，等同于 DSH 的 `bash` 工具所用来源）→ 已注册项目名 →
相对会话工作目录的路径；`省略`、`.`、`当前项目`、`本项目`、`这个项目`、`这里`、`cwd`
SHALL 视为"会话工作目录"；无法解析时 SHALL 返回包含候选（当前项目与已注册项目）的错误，
SHALL NOT 猜测路径。

#### Scenario: 省略即当前项目

- **WHEN** 在带有工作目录的会话里输入 `/workmate wiki`
- **THEN** 以会话工作目录为目标执行，并在输出中标注来源为当前项目

#### Scenario: 无工作目录时报错而非猜测

- **WHEN** 会话没有工作目录且未给路径
- **THEN** 返回错误说明无法确定当前项目并提示给出绝对路径

#### Scenario: 未知名称列出候选

- **WHEN** 给出的既不是路径也不是已注册项目名
- **THEN** 错误文本包含当前项目与已注册项目列表

### Requirement: 工具的项目参数可选

`workmate_wiki_generate` SHALL NOT 要求 `projectRoot`；省略时 SHALL 使用会话工作目录，
会话无工作目录时 SHALL 回退到唯一已注册项目，注册多个项目时 SHALL 报错并列出候选。

#### Scenario: 省略参数可用

- **WHEN** agent 在项目会话中不带 `projectRoot` 调用工具
- **THEN** 以会话工作目录为目标生成 wiki
