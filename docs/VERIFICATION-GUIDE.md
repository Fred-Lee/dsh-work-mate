# Helmsman 验证操作手册

按本手册可以自己复现全部验证。每条都给出**可直接粘贴的命令**与**我实测得到的输出**，
你的输出应与之一致（任务 ID、时间戳、哈希值会不同，属正常）。

> 证据等级说明见 `docs/DSH-INTEGRATION-NOTES.md`：本手册的期望值全部来自**真机实测**（A 级）。

---

## 0. 环境准备

### 0.1 前提

| 项 | 要求 | 本机实测值 |
|---|---|---|
| harness 源码 | `0.1.2-alpha.5`，已构建 | `/Users/fredlee/Documents/workspace/deepseek-harness` |
| Node / pnpm | `^22.19 \|\| >=24` / `>=10` | v24.11.0 / 10.33.2 |
| profile | `web`，用 `link:` 直连 Helmsman 源码 | `~/.dsh/profiles/web` |
| 编码 agent | `claude`、`codex` 已安装；`pi`、`oh-my-pi` **未安装** | claude 2.1.267 / codex 0.144.5 |

**重要**：`pi` 与 `oh-my-pi` 本机未安装，验证时只能选 `claude` / `codex`。

### 0.2 构建 + 启动

改过代码后必须重建再重启（profile 用 `link:`，加载的是 `dist/`）：

```bash
# 1) 构建全部插件
cd ~/Documents/workspace/dsh-Helmsman && pnpm build

# 2) 启动 harness（若已在跑先停：kill $(lsof -ti:3080)）
cd ~/Documents/workspace/deepseek-harness && pnpm dsh web
```

期望：启动日志里 15 个 Helmsman 插件逐行 ready、**0 error**：

```
[helmsman/worktree] service ready (root: /Users/fredlee/.helmsman/worktrees)
[helmsman/artifacts] service ready (root: /Users/fredlee/.helmsman/artifacts)
[helmsman/knowledge-tolaria] vault ready (root: /Users/fredlee/.helmsman/vault)
[helmsman/memory-topology] service ready (root: /Users/fredlee/.helmsman/topologies)
[helmsman/orchestrator] ready (adapters register themselves via inject)
[helmsman/ui-diff] serving diff view at /helmsman-diff/
[helmsman/ui-dashboard] serving dashboard at /helmsman-dashboard/
[helmsman/ui-workbench] serving workbench at /helmsman-workbench/
dsh web: http://127.0.0.1:3080/?token=...
```

> 若出现 `declares no dsh.bundle in its package.json` → 某个包缺 bundle 声明，
> 用 §2.3 的静态检查定位。

### 0.3 浏览器可访问的页面

| 页面 | 地址 |
|---|---|
| DSH 聊天 | `http://127.0.0.1:3080/` |
| 执行看板 | `http://127.0.0.1:3080/helmsman-dashboard/` |
| Diff 对比 / 合并 | `http://127.0.0.1:3080/helmsman-diff/` |
| 工作台抽屉 | DSH 侧边栏 🚀 Helmsman 或 `/helmsman-workbench/` |
| 任务看板（新） | `http://127.0.0.1:3080/helmsman-board/` ← 见 §6 |

---

## 1. 状态目录速查

所有状态在 `~/.helmsman/` 下，出问题先看这里：

| 目录/文件 | 内容 |
|---|---|
| `history/tasks/<taskId>.jsonl` | 任务事件时间线（追加式） |
| `history/tasks.json` | 任务摘要快照 |
| `audit/audit.jsonl` | 审计日志（决定 + 运行完成 + 合并裁决） |
| `artifacts/blobs/<sha256>` + `manifest.json` | 产物内容寻址存储 |
| `worktrees/` + `worktrees.json` | git worktree 与注册表 |
| `topologies/` | 项目拓扑 |
| `vault/` | Tolaria 知识库（归档笔记） |
| `board/` | 任务看板卡片（§6） |

**想从干净状态开始**（会清掉历史/审计/产物，谨慎）：

```bash
rm -rf ~/.helmsman/{history,audit,artifacts}   # 保留 worktrees/topologies/vault
```

---

## 2. 自动化关卡（最先跑，最快）

### 2.1 类型检查

```bash
cd ~/Documents/workspace/dsh-Helmsman && pnpm typecheck
```

期望：每个包一行 `typecheck: Done`，**无 `error TS`**，退出码 0。

### 2.2 单元 / 集成测试

```bash
cd ~/Documents/workspace/dsh-Helmsman && pnpm test
```

期望（写入时）：`Test Files 25 passed`、`Tests 199 passed`。看板落地后数字会上升。

### 2.3 工具链与插件可装载性检查

```bash
cd ~/Documents/workspace/dsh-Helmsman
pnpm verify:toolchain                                  # = --structural
node --test scripts/check-toolchain.test.mjs           # 15/15
node scripts/check-toolchain.mjs --live --profile web  # 对已装 profile 比对
```

期望：

```
OK: toolchain.json is valid and consistent with the docs
ℹ tests 15 / ℹ pass 15 / ℹ fail 0
OK: installed profile matches toolchain.json
  note: optional community plugin dsh-virtual-workspace is not installed (…skipping)
```

**负向验证**（确认它真的会拦）：

```bash
cd ~/Documents/workspace/dsh-Helmsman
cp packages/artifacts/package.json /tmp/art.bak
python3 -c "import json;p='packages/artifacts/package.json';d=json.load(open(p));del d['dsh'];json.dump(d,open(p,'w'),indent=2)"
node scripts/check-toolchain.mjs --structural; echo "exit=$?"
cp /tmp/art.bak packages/artifacts/package.json
```

期望看到（退出码 1）：

```
MISMATCH: 1 structural problem(s)
  - packages/artifacts/package.json (@helmsman/artifacts) declares no dsh.bundle.patch — a profile referencing it refuses to boot
```

---

## 3. REST 冒烟（无需 agent，秒级）

```bash
B=http://127.0.0.1:3080
```

### 3.1 插件已装载且能读到 agent

```bash
curl -s $B/helmsman-dashboard/api/state
```

期望：`agents` 里 `claude.installed=true`、`codex.installed=true`、`pi.installed=false`；
`groups` 含你的拓扑组（本机为 `["作业服务"]`）。

> 插件路由**不需要 token**（loopback 信任边界，见 `docs/SECURITY-AUDIT.md` §1.6）。

### 3.2 审批策略默认值

```bash
curl -s "$B/helmsman-dashboard/api/approvals/policy?op=merge"
curl -s "$B/helmsman-dashboard/api/approvals/policy?op=cancel"
```

期望：merge → `{"op":"merge","mode":"confirm-required","confirmRequired":true}`；
cancel → `mode":"auto-grant"`。

### 3.3 产物注册表可用

```bash
curl -s $B/helmsman-dashboard/api/artifacts
curl -s $B/helmsman-workbench/api/artifacts
```

期望：`{"artifacts":[...],"available":true}` —— `available:true` 表示 artifacts 插件已装载并被宿主读到。

### 3.4 审计日志可读

```bash
curl -s $B/helmsman-dashboard/api/audit
```

期望：`{"entries":[...]}`（干净状态下为空数组）。

### 3.5 Origin 围栏（理解为什么 UI 必须同源）

需要 harness 在运行中。注意用数组传 header——`${x:+-H "..."}` 这种展开会把 header 拆成两个
参数导致 curl 误解析：

```bash
payload='{"type":"client-request","rpcId":"p1","method":"host.describe","payload":{}}'
for o in "<none>" "http://127.0.0.1:3080" "http://127.0.0.1:8765"; do
  if [ "$o" = "<none>" ]; then H=(); else H=(-H "Origin: $o"); fi
  printf "Origin=[%-24s] -> " "$o"
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$B/api/host.describe" \
    -H 'content-type: application/json' "${H[@]}" -d "$payload"
done
```

期望（harness 运行中实测）：

```
Origin=[<none>                  ] -> 401
Origin=[http://127.0.0.1:3080   ] -> 401
Origin=[http://127.0.0.1:8765   ] -> 403
```

即：不带或自身 Origin 只差令牌；**外来 Origin 直接 403**。

---

## 4. 端到端：任务 → 时间线 → 门控 → 审计 → 产物

### 4.0 造一个临时仓库

```bash
rm -rf /tmp/helmsman-smoke && mkdir -p /tmp/helmsman-smoke/src && cd /tmp/helmsman-smoke
git init -q
printf '# Smoke\n' > README.md
printf 'export const value = 1\n' > src/app.ts
git add -A && git -c user.email=s@l -c user.name=s commit -q -m "chore: base"
```

### 4.1 起一个真实任务

```bash
curl -s -X POST $B/helmsman-dashboard/api/task -H 'content-type: application/json' \
  -d '{"prompt":"Create a file named SMOKE.md containing exactly: helmsman smoke ok","agents":["claude"],"repoPath":"/tmp/helmsman-smoke","timeoutSec":90}'
```

期望：`{"taskId":"t-..."}`。把 ID 存起来：

```bash
TID=<粘贴上面的 taskId>
```

> ⚠️ **已知环境行为**：`claude -p` 非交互运行时可能因权限策略**拒绝写入**，于是任务完成但
> 没有文件改动，后续合并会返回 `no changes to merge`。这不是 Helmsman 的缺陷；要验证真实
> 合并/冲突，请在提示词里让 agent 只做只读操作，或先在 claude 侧放行写入权限。

### 4.2 持久化时间线（change A）

```bash
curl -s "$B/helmsman-dashboard/api/task/$TID/events?after=0" | python3 -m json.tool | head -30
```

期望：`events` 数组，每条 `{"v":1,"seq":N,"ts":...,"kind":"task-state"|"agent-log",...}`，
`seq` 从 1 单调递增，`nextCursor` 等于最后一条的 seq。

**游标分页**（关键语义：只返回 `seq > after`）：

```bash
curl -s "$B/helmsman-dashboard/api/task/$TID/events?after=5" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('seqs:',[e['seq'] for e in d['events']])"
```

期望：打印 `seqs: [6, 7]`（示例），即严格晚于 5 的事件。

### 4.3 SSE 实时流

```bash
curl -s -N -m 8 "$B/helmsman-dashboard/api/task/$TID/stream?after=0" | head -c 500
```

期望：先一行 `: connected`（连接注释），随后 `data: {...}` 按 cursor 重放历史事件。

### 4.4 重启存活（change A 的核心保证）

```bash
kill $(lsof -ti:3080); sleep 3
cd ~/Documents/workspace/deepseek-harness && pnpm dsh web & sleep 30
curl -s $B/helmsman-dashboard/api/state | python3 -c "import sys,json;print([(t['id'],t['status']) for t in json.load(sys.stdin)['tasks']])"
```

期望：重启前完成的任务仍在列表中（本机实测为 `[('t-...','COMPLETED')]`）。

### 4.5 门控三态（change C 核心）

**① 无令牌 → 拒绝**

```bash
curl -s -o /tmp/m1.json -w "http=%{http_code}\n" -X POST "$B/helmsman-dashboard/api/task/$TID/merge" \
  -H 'content-type: application/json' -d '{"agents":["claude"]}'; cat /tmp/m1.json
```

期望：`http=500` + `{"error":"gate-denied: merge requires confirmation for scope merge:task:<TID> (missing-token)"}`

**② 申请 → 批准 → 拿一次性令牌**

```bash
curl -s -X POST "$B/helmsman-dashboard/api/approvals" -H 'content-type: application/json' \
  -d "{\"op\":\"merge\",\"taskId\":\"$TID\"}" | tee /tmp/appr.json
AID=$(python3 -c "import json;print(json.load(open('/tmp/appr.json'))['approvalId'])")
curl -s "$B/helmsman-dashboard/api/approvals/pending"          # 应看到这条挂起
curl -s -X POST "$B/helmsman-dashboard/api/approvals/$AID/decision" \
  -H 'content-type: application/json' -d '{"approve":true}' | tee /tmp/dec.json
```

期望：申请返回 `{"approvalId":"ap-...","scope":"merge:task:<TID>","expiresAt":<+300000>}`；
批准返回 `{"granted":true,"token":"<32 位 hex>",...}`。

**③ 带令牌 → 放行**

```bash
TOK=$(python3 -c "import json;print(json.load(open('/tmp/dec.json'))['token'])")
curl -s -o /tmp/m2.json -w "http=%{http_code}\n" -X POST "$B/helmsman-dashboard/api/task/$TID/merge" \
  -H 'content-type: application/json' -d "{\"agents\":[\"claude\"],\"confirmationToken\":\"$TOK\"}"; cat /tmp/m2.json
```

期望：`http=200` + `{"taskId":"...","results":[{"agent":"claude","ok":true,...,"conflictFiles":[]}]}`

**④ 令牌复用 → 拒绝**

```bash
curl -s -X POST "$B/helmsman-dashboard/api/task/$TID/merge" \
  -H 'content-type: application/json' -d "{\"agents\":[\"claude\"],\"confirmationToken\":\"$TOK\"}"
```

期望：`{"error":"gate-denied: ... (unknown-token)"}` —— **一次性令牌，不可复用**。

### 4.6 审计留痕（change C）

```bash
curl -s $B/helmsman-dashboard/api/audit | python3 -c "
import sys,json
for e in json.load(sys.stdin)['entries']:
    print(' type=%-14s op=%-7s decision=%-8s stage=%-8s source=%-4s outcome=%s%s' % (
      e.get('type'), e.get('operation'), e.get('decision') or '-', e.get('stage') or '-',
      e.get('source') or '-', e.get('outcome') or '-', ('  reason='+e['reason']) if e.get('reason') else ''))"
```

期望（示例，顺序即发生顺序）：

```
 type=run-completion op=run     decision=-        stage=-        source=-    outcome=completed
 type=decision       op=merge   decision=denied   stage=enforce  source=ui   reason=missing-token
 type=decision       op=merge   decision=granted  stage=decide   source=ui
 type=decision       op=merge   decision=granted  stage=enforce  source=ui
 type=run-completion op=merge   decision=-        stage=-        source=ui   outcome=completed
 type=decision       op=merge   decision=denied   stage=enforce  source=ui   reason=unknown-token
```

**要核对的三个点**：① `stage=decide` 出现 → 人工批准已入账；② `source=ui` → 来源归因正确；
③ `outcome` 由真实终态派生（取消的任务应为 `cancelled`、全失败为 `failed`，不是 `completed`）。

### 4.7 产物：任务包 + 去重（change D）

```bash
curl -s -X POST "$B/helmsman-dashboard/api/task/$TID/bundle" -H 'content-type: application/json' -d '{}' | tee /tmp/b1.json
curl -s -X POST "$B/helmsman-dashboard/api/task/$TID/bundle" -H 'content-type: application/json' -d '{}' | tee /tmp/b2.json
python3 -c "
import json
a=json.load(open('/tmp/b1.json')); b=json.load(open('/tmp/b2.json'))
print('1st:', a['patch']['id'][:10], a['patch']['duplicate'])
print('2nd:', b['patch']['id'][:10], b['patch']['duplicate'], '(id 相同且 duplicate=True 才对)')"
```

期望：两次 **id 相同**，第二次 `duplicate` 为 `true`（内容寻址去重生效）。

### 4.8 产物下载头（含中文文件名）

```bash
curl -s "$B/helmsman-dashboard/api/topology/export?group=$(python3 -c "import urllib.parse;print(urllib.parse.quote('作业服务'))")" | tee /tmp/topo.json
AID=$(python3 -c "import json;print(json.load(open('/tmp/topo.json'))['artifactId'])")
curl -s -D - -o /tmp/topo.yaml "$B/helmsman-dashboard/api/artifacts/$AID" | head -5
head -3 /tmp/topo.yaml
```

期望：

```
content-type: application/yaml
content-disposition: attachment; filename="helmsman-topology-____.yaml"; filename*=UTF-8''helmsman-topology-%E4%BD%9C%E4%B8%9A%E6%9C%8D%E5%8A%A1.yaml
```

正文是真正的 YAML（`projectGroup:` 开头）。**要点**：ASCII 回退名 + RFC 5987 `filename*`
中文名（CJK 安全），内容类型不再是误标的 `.json`。

---

## 5. 浏览器侧建议核对

| 页面 | 看什么 |
|---|---|
| `/helmsman-dashboard/` | 任务卡片、agent 状态；执行中任务的日志**实时刷新**（SSE，不是 1.5s 轮询的旧行为）；断网重连后不重复、不丢事件 |
| `/helmsman-diff/` | 冲突文件标注来自**真实冲突**（应用失败），不重叠的多 agent 改动**不再**被要求人工裁决；每个冲突文件可选「某 agent 方案 / 手动编辑保留 / 跳过」 |
| `/helmsman-workbench/` | 「📦 交付物」面板列出已注册产物并可下载 |

---

## 6. 任务看板（编写中，落地后补真实输出）

以下按 `openspec/changes/add-task-kanban-board/specs/task-kanban/spec.md` 的规格列出**将要验证**的点。
三个实现车道（`packages/board` / `packages/ui-board` / workbench 建档）正在并行开发，
落地后我会用真实输出替换本节并标注实测结果——**在此之前不要按本节判定通过**。

- 页面 `http://127.0.0.1:3080/helmsman-board/` 呈现四列：需求分析 / 规格设计 / 开发实施 / 验收归档
- 卡片显示标题 + 对话摘要（2–4 行截断）+ 角标（📄/💬/🧩）+ run 状态点
- 筛选（仓库/阶段/有无摘要）写入 URL query，刷新与分享保持状态
- 开发列按**冲突域**（`仓库:模块`）分组显示 `在跑/上限`；同仓库不同模块可并行，同域超限进入排队并给出原因
- 推进门：`规格→开发` 需 spec 已定稿；`开发→归档` 需 ≥1 个 run 已合并且有审计记录；不满足则列出缺口并**拒绝推进**
- 详情抽屉：摘要可编辑、关联分区可跳转（文档/对话/服务/worktree/runs/产物），点击不回拷内容
- run 面板：SSE 实时时间线；冲突**只标注并跳转 diff**，页面内**不存在**自动合并/一键采纳控件
- 建档：页面「+ 新建任务」与聊天侧「保存为任务」都能建卡，并自动带一段对话摘要

---

## 7. 收尾与清理

```bash
# 停止 harness
kill $(lsof -ti:3080)

# 清掉本次验证的残留（按需）
rm -rf /tmp/helmsman-smoke /tmp/topo.yaml /tmp/m?.json /tmp/b?.json /tmp/appr.json /tmp/dec.json
```

若要连状态一起清干净（谨慎，会丢历史/审计/产物）：

```bash
rm -rf ~/.helmsman/{history,audit,artifacts}
```

---

## 8. 遇到问题怎么定位

| 现象 | 先查 |
|---|---|
| harness 起不来，报 `declares no dsh.bundle` | §2.3 静态检查；该包缺 `dsh.bundle.patch` 或补丁文件 |
| 插件没出现在日志里 | `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 是否列出该包；改完是否 `pnpm build` + 重启 |
| 改了代码但行为没变 | profile 是 `link:` 加载 `dist/`，必须重建 + 重启 |
| 合并返回 `no changes to merge` | agent 没产生改动（常见于 claude 写入被权限拒绝），换只读提示词 |
| 产物下载 404 | `~/.helmsman/artifacts/manifest.json` 是否有该 id；`available:true` 是否成立 |
| 外来 Origin 403 | 属**预期**——DSH 的 Origin 围栏，UI 必须同源（§3.5） |
