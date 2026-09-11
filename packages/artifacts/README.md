# @helmsman/artifacts

Helmsman 产物交付注册表 —— 内容寻址存储 + 同源下载端点。

## 职责

纯 Service cordis 插件(无 `webServer`、无工具),提供 `helmsman.artifacts` 服务:

| 方法 | 说明 |
|---|---|
| `register({ type, fileName, bytes, meta })` | 按 sha256 内容寻址登记产物;内容重复时返回既有 id 且 `duplicate: true` |
| `resolve(id)` | 返回交付元数据 + 字节;未知 id 返回 `null` |
| `list()` | 列出已登记产物(仅元数据) |

## 状态布局

```
$HELMSMAN_HOME/artifacts/          # 默认 ~/.helmsman/artifacts
├── blobs/<sha256>                 # 内容寻址的对象字节
└── manifest.json                  # 交付清单(原子 tmp+rename 重写)
```

清单损坏时按 blobs 目录重新哈希重建;单次注册上限 50 MB(`PAYLOAD_TOO_LARGE`)。

## 下载头助手

`contentDispositionHeader` / `downloadHeaders` / `mimeForFileName` 供宿主端点复用:
ASCII 回退 + RFC 5987 `filename*`(CJK 安全),MIME 表覆盖
`.md .json .patch .diff .yaml .yml .txt`。

## 被谁消费

- `@helmsman/ui-workbench` —— 草稿与归档笔记登记为产物,「📦 交付物」面板下载。
- `@helmsman/ui-dashboard` —— 产物端点、任务结果包(`<taskId>.bundle.patch` + 伴生 JSON)、topology YAML 导出。

宿主一律经 `ctx.get('helmsman.artifacts')` 懒取,插件缺失时降级隐藏产物功能。
