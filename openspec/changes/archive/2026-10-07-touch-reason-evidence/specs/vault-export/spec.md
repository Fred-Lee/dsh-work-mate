## MODIFIED Requirements

### Requirement: Vault 视图笔记

「触及模块」边的标注 SHALL 描述**证据类型**（来自代码路径 / 来自散文 token / 来自向量相似 /
来自判断层归类），SHALL NOT 用实现细节（如"slug 包含 vs token 重叠"）冒充证据强度。
看起来像路径或文件名的证据 SHALL 标为路径证据，即使匹配是通过 slug token 完成的。

#### Scenario: 代码路径算路径证据

- **WHEN** Impact 段给出 `src/.../HomeworkManagementService.java` 并被 token 匹配到模块
- **THEN** 该边标注为「路径命中」，而不是「token 命中」
