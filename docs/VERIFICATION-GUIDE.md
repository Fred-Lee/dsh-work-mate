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
rm -rf ~/.helmsman/{history,audit,artifacts,board}   # 保留 worktrees/topologies/vault
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

期望（本机实测，derive-dependencies-from-calls 落地后）：`Test Files 38 passed`、`Tests 477 passed`。
（历史：写入时 25 文件 / 199 用例；看板、依赖图与依赖推导变更后数字会继续上升。）

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

### 3.6 依赖拓扑：服务级边、按对去重与图体检（simplify-service-dependencies）

用只读/可复现的 curl 链路验证三件事：**只选两个服务即一条边**、**重复添加仍只一行（幂等）**、
**成环被体检报出**。全部走真实 HTTP 路由，无需 agent。

```bash
B=http://127.0.0.1:3080
API=$B/helmsman-dashboard/api
G=dep-check-demo
```

**① 保存一条服务级边（`endpoints: []` + `method: '*'`）**

```bash
curl -s -X POST $API/topology/save -H 'content-type: application/json' -d '{
  "topology": {
    "projectGroupId": "dep-check-demo",
    "services": { "svc-a": { "name": "svc-a" }, "svc-b": { "name": "svc-b" } },
    "restDependencies": { "svc-a": [ { "toServiceId": "svc-b", "endpoints": [], "method": "*" } ] }
  }
}'
curl -s "$API/topology?group=$G" | python3 -c 'import json,sys;t=json.load(sys.stdin)["topology"];rows=t["restDependencies"].get("svc-a",[]);print("rows:",len(rows),json.dumps(rows,ensure_ascii=False))'
```

期望（恰好一行；`endpoints` 保持空数组、`method` 保持 `'*'`——**没有被填成 `GET` 或占位路径**）：

```
rows: 1 [{"toServiceId": "svc-b", "endpoints": [], "method": "*"}]
```

**② 同一对服务再添加一次（带明细）→ 仍只有一行，明细并入**

```bash
curl -s -X POST $API/topology/save -H 'content-type: application/json' -d '{
  "topology": {
    "projectGroupId": "dep-check-demo",
    "services": { "svc-a": { "name": "svc-a" }, "svc-b": { "name": "svc-b" } },
    "restDependencies": { "svc-a": [
      { "toServiceId": "svc-b", "endpoints": [], "method": "*" },
      { "toServiceId": "svc-b", "endpoints": ["/api/orders"], "method": "GET" }
    ] }
  }
}'
curl -s "$API/topology?group=$G" | python3 -c 'import json,sys;t=json.load(sys.stdin)["topology"];rows=t["restDependencies"].get("svc-a",[]);print("rows:",len(rows),json.dumps(rows,ensure_ascii=False))'
```

期望（两行合并为一行，明细留在同一对服务上）：

```
rows: 1 [{"toServiceId": "svc-b", "endpoints": ["/api/orders"], "method": "GET"}]
```

把**同一条命令再执行一次**（同样的 payload），`rows` 仍为 `1` 且内容不变 —— 保存幂等。
配置页同样只需两个下拉（端点明细收在「端点明细（可选）」折叠区），依赖区块显示一行
`svc-a ──▶ svc-b`。

**③ 构造 `A → B → A`，体检报告出环及成员**

```bash
curl -s -X POST $API/topology/save -H 'content-type: application/json' -d '{
  "topology": {
    "projectGroupId": "dep-check-demo",
    "services": { "svc-a": { "name": "svc-a" }, "svc-b": { "name": "svc-b" } },
    "restDependencies": {
      "svc-a": [ { "toServiceId": "svc-b", "endpoints": [], "method": "*" } ],
      "svc-b": [ { "toServiceId": "svc-a", "endpoints": [], "method": "*" } ]
    }
  }
}'
curl -s "$API/topology/health?group=$G" | python3 -c 'import json,sys;h=json.load(sys.stdin)["health"];print("cyclic:",h["cyclic"],"cycles:",h["cycles"],"dangling:",h["dangling"],"isolated:",h["isolated"])'
```

期望（环被报出且**含成员**；配置页保存后同样出现 🔁 告警条，但**不阻断保存**）：

```
cyclic: True cycles: [['svc-a', 'svc-b']] dangling: [] isolated: []
```

**④ 悬空引用与孤立服务**

```bash
curl -s -X POST $API/topology/save -H 'content-type: application/json' -d '{
  "topology": {
    "projectGroupId": "dep-check-demo",
    "services": { "svc-a": { "name": "svc-a" }, "svc-c": { "name": "svc-c" } },
    "restDependencies": { "svc-a": [ { "toServiceId": "ghost", "endpoints": [], "method": "*" } ] }
  }
}'
curl -s "$API/topology/health?group=$G" | python3 -c 'import json,sys;h=json.load(sys.stdin)["health"];print("cyclic:",h["cyclic"],"cycles:",h["cycles"],"dangling:",h["dangling"],"isolated:",h["isolated"])'
```

期望（`ghost` 未登记 → 悬空；`svc-c` 无入边无出边 → 孤立）：

```
cyclic: False cycles: [] dangling: [{'from': 'svc-a', 'to': 'ghost'}] isolated: ['svc-c']
```

**⑤ 干净图无告警**（两个服务、一条边）：`cyclic: False ... dangling: [] isolated: []`，
配置页不显示告警条（`health` 三项全空即整块不渲染）。

```bash
curl -s -X POST $API/topology/save -H 'content-type: application/json' -d '{
  "topology": {
    "projectGroupId": "dep-check-demo",
    "services": { "svc-a": { "name": "svc-a" }, "svc-b": { "name": "svc-b" } },
    "restDependencies": { "svc-a": [ { "toServiceId": "svc-b", "endpoints": [], "method": "*" } ] }
  }
}'
curl -s "$API/topology/health?group=$G" | python3 -c 'import json,sys;h=json.load(sys.stdin)["health"];print("cyclic:",h["cyclic"],"cycles:",h["cycles"],"dangling:",h["dangling"],"isolated:",h["isolated"])'
```

```
cyclic: False cycles: [] dangling: [] isolated: []
```

**收尾**：临时群建议在配置面板 🗑️ 删除（`POST /api/topology/delete` 默认需一次性确认令牌），
或直接 `rm -f ~/.helmsman/topologies/dep-check-demo.json`。

> 说明：`GET api/topology/health` 是只读路由（无变更面）；未装 memory-topology 时该路由不挂载
> （宿主 404），装了但版本较早（无 `checkHealth`）时返回 `{"available": false, "health": null}`。

### 3.7 依赖推导候选：扫描 → 证据 → 确认（derive-dependencies-from-calls）

在一个**临时仓库**上跑完整链路，核对四件事：**候选与其证据**、**确认后仍只有一行**、
**未登记目标登记后不留悬空引用**、**成环候选被单独标注**。全程走真实 HTTP 路由，无需 agent。

**① 造一个含真实形态 Feign 客户端 + 出站调用的临时仓库**

```bash
B=http://127.0.0.1:3080
API=$B/helmsman-dashboard/api
G=derive-check-demo
R=/tmp/helmsman-derive-smoke
rm -rf $R && mkdir -p $R/src/main/java/com/example/client $R/src/main/resources

cat > $R/src/main/java/com/example/client/InternalBcEsClient.java <<'EOF'
package com.example.client;

@FeignClient(name = "${project.feign-client-config.internal-bc-es.name}",
             url = "${project.feign-client-config.internal-bc-es.url}",
             path = "${project.feign-client-config.internal-bc-es.path}",
             configuration = { FeignConfiguration.class, FeignInterceptorConfiguration.class })
public interface InternalBcEsClient {

  @GetMapping("/es_wrong_question/list/{subjectId}")
  Result getWrongQuesList(@PathVariable Integer subjectId, @SpringQueryMap Map<String, Object> queryMap);
}
EOF

cat > $R/src/main/java/com/example/HomeworkCaller.java <<'EOF'
package com.example;

public class HomeworkCaller {
  private final RestTemplate restTemplate = new RestTemplate();

  public String load(String hwId) {
    return restTemplate.getForObject("http://internal-homework:8080/api/homework/" + hwId, String.class);
  }
}
EOF

cat > $R/src/main/resources/application.yml <<'EOF'
project:
  feign-client-config:
    internal-bc-es:
      name: internal-bc-es
      url: http://internal-bc-es:8080
      path: /api
EOF
```

**② 登记两个服务（调用方带 localPath，被调用方带一个已声明端点）**

```bash
curl -s -X POST $API/topology/save -H 'content-type: application/json' -d "{
  \"topology\": {
    \"projectGroupId\": \"$G\",
    \"services\": {
      \"homework-server\":   { \"name\": \"homework-server\", \"localPath\": \"$R\" },
      \"internal-homework\": { \"name\": \"internal-homework\",
                              \"apiEndpoints\": [ { \"method\": \"GET\", \"path\": \"/api/homework/{hwId}\" } ] }
    },
    \"restDependencies\": {}
  }
}" > /dev/null

cp ~/.helmsman/topologies/$G.json /tmp/derive-before.json     # 用于核对「推导不写库」
```

**③ 跑推导（只读）并核对候选与证据**

```bash
curl -s "$API/topology/derive?group=$G" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('available:', d['available'], 'scanned:', d['result']['scanned'], 'skipped:', d['result']['skipped'])
for c in d['result']['candidates']:
    print('-', c['from'], '->', c['to'], '| 置信度', c['confidence'], '| 目标已登记', c['targetDeclared'],
          '| 成环', c['wouldCreateCycle'], '| 端点明细', c['endpoints'])
    for e in c['evidence']:
        print('    ', e['kind'], e['file'] + (':' + str(e['line']) if e.get('line') else ''), '|', e['detail'],
              ('| ' + e['note']) if e.get('note') else '')"
```

期望（**本机对上面这份 fixture 实测**得到的候选与证据；`/api/topology/derive` 只是把同一份
推导结果经只读路由透出，路由与错误语义另有单测覆盖）：

```
available: True scanned: ['homework-server'] skipped: [{'serviceId': 'internal-homework', 'reason': '未配置本地路径（localPath）'}]
- homework-server -> internal-bc-es | 置信度 high | 目标已登记 False | 成环 False | 端点明细 []
     feign src/main/java/com/example/client/InternalBcEsClient.java:3 | @FeignClient(name = "${project.feign-client-config.internal-bc-es.name}", url = "${project.feign-client-config.internal-bc-es.url}", path = "${project.feign-client-config.internal-bc-es.path}")
     feign src/main/java/com/example/client/InternalBcEsClient.java:9 | @GetMapping("/es_wrong_question/list/{subjectId}")
     config src/main/resources/application.yml:4 | project.feign-client-config.internal-bc-es.name = internal-bc-es
     config src/main/resources/application.yml:5 | project.feign-client-config.internal-bc-es.url = http://internal-bc-es:8080
     config src/main/resources/application.yml:6 | project.feign-client-config.internal-bc-es.path = /api
- homework-server -> internal-homework | 置信度 high | 目标已登记 True | 成环 False | 端点明细 ['/api/homework/{hwId}']
     call src/main/java/com/example/HomeworkCaller.java:7 | RestTemplate.getForObject(…) http://internal-homework:8080/api/homework/{}
     endpoint src/main/java/com/example/HomeworkCaller.java:7 | /api/homework/{} ↔ GET /api/homework/{hwId}（internal-homework 已声明该端点） | 按段形状归一化匹配
```

**要核对的四个点**：
1. Feign 的目标名来自**占位符键段**（`internal-bc-es`），不是字面量；`url`/`path`/`name` 三个键的值
   能在本地配置里找到 → 每个都进入证据（`config … application.yml:4/5/6`）。把
   `src/main/resources/application.yml` 删掉再跑一遍，这两条证据会消失、`@FeignClient` 那条仍在，
   并多出「值未解析（本地配置中未找到 project.feign-client-config.internal-bc-es.name）」的标注
   —— 线索不因解析不到值而丢失（`pnpm exec vitest run packages/memory-topology` 里有对应单测）。
2. `homework-server → internal-homework` 是**两档合并**的结果：`RestTemplate` 绝对 URL 给出
   **高**（名称档，主机名命中已登记服务）+ 路径命中给出**中**（端点明细 `/api/homework/{hwId}`）
   → 置信度取高档、证据/端点取并集，**只占一条候选**。调用侧的 `/api/homework/{}`（字符串拼接
   归一化后的形态）与已声明的 `/api/homework/{hwId}` 按段形状归一化命中，标注为
   「按段形状归一化匹配」而不是精确匹配。
3. 未登记目标 `internal-bc-es` 仍产出候选并标 `targetDeclared: False`（不会被过滤掉）——
   真实仓库里 7 个 Feign 目标有 6 个是这种状态。
4. `skipped` 说明被调用方没有本地路径、没有被扫描——扫描范围只覆盖调用方；
   目标端点的匹配依据是拓扑里**已声明**的 `apiEndpoints`。

**④ 推导不写库**

```bash
diff -q /tmp/derive-before.json ~/.helmsman/topologies/$G.json && echo "topology file unchanged"
curl -s "$API/topology?group=$G" | python3 -c 'import json,sys;print("rows:",json.load(sys.stdin)["topology"]["restDependencies"])'
```

期望：`topology file unchanged` 且 `rows: {}`（推导只在只读入口产出候选）。

**⑤ 确认候选：已存在的对只占一行、明细并入**

```bash
curl -s -X POST $API/topology/apply-candidates -H 'content-type: application/json' -d "{
  \"group\": \"$G\",
  \"candidates\": [ { \"from\": \"homework-server\", \"to\": \"internal-homework\", \"endpoints\": [\"/api/homework/{hwId}\"], \"method\": \"GET\" } ]
}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("applied:",d["applied"],"registered:",d["registered"])'

# 再确认一次（同一条），核对仍只有一行
curl -s -X POST $API/topology/apply-candidates -H 'content-type: application/json' -d "{
  \"group\": \"$G\",
  \"candidates\": [ { \"from\": \"homework-server\", \"to\": \"internal-homework\", \"endpoints\": [\"/api/homework/{hwId}\"], \"method\": \"GET\" } ]
}" > /dev/null
curl -s "$API/topology?group=$G" | python3 -c 'import json,sys;t=json.load(sys.stdin)["topology"];rows=t["restDependencies"]["homework-server"];print("rows:",len(rows),json.dumps(rows,ensure_ascii=False))'
```

期望（两次确认后仍**恰好一行**、明细不重复）：

```
applied: 1 registered: []
rows: 1 [{"toServiceId": "internal-homework", "endpoints": ["/api/homework/{hwId}"], "method": "GET"}]
```

> 这一步就是 spec 的「确认候选后依赖更新且不重复」：确认走的是服务端
> `mergeDependencyEdge` + 保存去重的同一路径（`pnpm exec vitest run packages/memory-topology`
> 的 `TopologyService derive + confirm candidates` 用例逐步断言了这些行数）。

**⑥ 未登记目标：登记并确认 → 不留悬空引用**

```bash
curl -s -X POST $API/topology/apply-candidates -H 'content-type: application/json' -d "{
  \"group\": \"$G\",
  \"candidates\": [ { \"from\": \"homework-server\", \"to\": \"internal-bc-es\", \"register\": true } ]
}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("registered:",d["registered"])'

curl -s "$API/topology/health?group=$G" | python3 -c 'import json,sys;h=json.load(sys.stdin)["health"];print("dangling:",h["dangling"],"cyclic:",h["cyclic"])'
```

期望：服务条目与依赖边在同一次确认里建立，体检**没有**悬空引用：

```
registered: ['internal-bc-es']
dangling: [] cyclic: False
```

**⑥′ 负向对照：只确认依赖（不登记）→ 体检必须报出来，而不是静默接受**

```bash
curl -s -X POST $API/topology/apply-candidates -H 'content-type: application/json' -d "{
  \"group\": \"$G\",
  \"candidates\": [ { \"from\": \"homework-server\", \"to\": \"internal-qp\" } ]
}" > /dev/null

curl -s "$API/topology/health?group=$G" | python3 -c 'import json,sys;h=json.load(sys.stdin)["health"];print("dangling:",h["dangling"])'
```

期望（`internal-qp` 未登记也未被登记过 → 悬空引用被报出；界面上这个动作要先经过
「确认后 … 仍未登记为服务，该依赖边会被体检报为「悬空引用」。仍然只确认依赖？」的弹窗）：

```
dangling: [{'from': 'homework-server', 'to': 'internal-qp'}]
```

**⑦ 成环候选被单独标注（不丢弃）**

```bash
# 造一条已有边 internal-homework → homework-server，并让两个服务都有本地路径
curl -s -X POST $API/topology/save -H 'content-type: application/json' -d "{
  \"topology\": {
    \"projectGroupId\": \"$G\",
    \"services\": {
      \"homework-server\":   { \"name\": \"homework-server\", \"localPath\": \"$R\" },
      \"internal-homework\": { \"name\": \"internal-homework\", \"localPath\": \"$R\",
                              \"apiEndpoints\": [ { \"method\": \"GET\", \"path\": \"/api/homework/{hwId}\" } ] }
    },
    \"restDependencies\": { \"internal-homework\": [ { \"toServiceId\": \"homework-server\", \"endpoints\": [], \"method\": \"*\" } ] }
  }
}" > /dev/null

curl -s "$API/topology/derive?group=$G" | python3 -c "
import sys,json
for c in json.load(sys.stdin)['result']['candidates']:
    print(c['from'],'->',c['to'],'| 成环',c['wouldCreateCycle'],'| 目标已登记',c['targetDeclared'])"
```

期望：

```
homework-server -> internal-bc-es | 成环 False | 目标已登记 False
homework-server -> internal-homework | 成环 True | 目标已登记 True
internal-homework -> internal-bc-es | 成环 False | 目标已登记 False
```

要点：`homework-server → internal-homework` 与既有 `internal-homework → homework-server` 构成
`A → B → A`，所以 `成环 True`——它在界面上带「将形成环」标记且**默认不勾选**，
「✅ 全部确认（不含成环项）」不会带上它（即使手工勾上也一样，需逐条点该行的「✅ 确认」才会写）。
自环（`internal-homework` 自己命到自己）在推导层就被排除，所以列表里不会出现
`internal-homework → internal-homework`。

**收尾**：

```bash
rm -rf $R /tmp/derive-before.json
rm -f ~/.helmsman/topologies/$G.json      # 或配置面板 🗗️ 删除（需一次性确认令牌）
```

> 说明：`GET api/topology/derive` 是只读路由（无变更面）；确认走
> `POST api/topology/apply-candidates`，它在服务端复用与保存/导入**同一条**持久化路径
> （`mergeDependencyEdge` + 保存去重），故「一对服务只有一行」对这条写入路径同样成立。
> 未装 memory-topology 时两条路由都不挂载（宿主 404）；装了但版本较早时返回
> `{"available": false}`（界面提示手工录入，不会静默失败）。

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
| `/helmsman-dashboard/` | 任务卡片、agent 状态；执行中任务的日志**实时刷新**（SSE，不是 1.5s 轮询的旧行为）；断网重连后不重复、不丢事件；配置面板 🕸️ 依赖拓扑里点「🔍 推导候选」可看到逐条证据与置信度徽标（成环项默认不勾选） |
| `/helmsman-diff/` | 冲突文件标注来自**真实冲突**（应用失败），不重叠的多 agent 改动**不再**被要求人工裁决；每个冲突文件可选「某 agent 方案 / 手动编辑保留 / 跳过」 |
| `/helmsman-workbench/` | 「📦 交付物」面板列出已注册产物并可下载 |

---

## 6. 任务看板（已实测，输出为本机真实结果）

页面：`http://127.0.0.1:3080/helmsman-board/`（独立页；SPA 资源 `app.js` 约 176 KB）。
看板 API 前缀 `BB=http://127.0.0.1:3080/helmsman-board`。

### 6.1 四列与页面资源

```bash
BB=http://127.0.0.1:3080/helmsman-board
curl -s $BB/api/items | python3 -c "
import sys,json;d=json.load(sys.stdin)
print('columns:', [(c['stage'], c['label'], c['count']) for c in d['columns']])"
```

期望（实测）：

```
columns: [('requirements', '需求分析', 0), ('spec', '规格设计', 0), ('dev', '开发实施', 0), ('done', '验收归档', 0)]
```

顶层另有 `items`（扁平卡片数组）、`wip`（各冲突域计数）、`repos`、`config`。

```bash
curl -s -o /dev/null -w "index.html %{http_code} %{content_type}\n" $BB/
curl -s -o /dev/null -w "app.js     %{http_code} %{size_download}\n" $BB/app.js
# 实测：index.html 200 text/html; charset=utf-8 / app.js 200 175808
```

### 6.2 建档

```bash
A=$(curl -s -X POST $BB/api/item -H 'content-type: application/json' \
  -d '{"title":"看板冒烟A","baseRepo":"/tmp/helmsman-board-smoke","module":"alpha"}')
AID=$(echo "$A" | python3 -c "import sys,json;print(json.load(sys.stdin)['item']['id'])")
```

期望：`{"ok":true,"item":{"id":"wi_...","stage":"requirements","stageLabel":"需求分析",...}}`

### 6.3 门控：未定稿 spec 被拦，置位后放行

```bash
# ① 需求 → 规格（应放行）
curl -s -X POST $BB/api/item/$AID/advance -H 'content-type: application/json' -d '{}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('ok=',d['ok'],'to=',d['to'])"
# 实测：ok= True to= spec

# ② 规格 → 开发（未定稿，应被拒）
curl -s -X POST $BB/api/item/$AID/advance -H 'content-type: application/json' -d '{}' \
  | python3 -c "
import sys,json;d=json.load(sys.stdin)
print('ok=',d['ok'],'moved=',d['moved'],'stage=',d['item']['stageLabel'])
[print('   gap:',g['key'],'|',g['label']) for g in d['gaps']]"
# 实测：ok= False moved= False stage= 规格设计
#       gap: spec-finalized | 缺少已定稿的 spec

# ③ 置位 specFinalized
curl -s -X PATCH $BB/api/item/$AID -H 'content-type: application/json' -d '{"specFinalized":true}' >/dev/null

# ④ 再推进（应放行进开发）
curl -s -X POST $BB/api/item/$AID/advance -H 'content-type: application/json' -d '{}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('ok=',d['ok'],'moved=',d['moved'],'stage=',d['item']['stageLabel'])"
# 实测：ok= True moved= True stage= 开发实施
```

**要点**：被拒时 `moved=false` 且卡片阶段不变——看板不会本地移动卡片。

### 6.4 冲突域 WIP：同仓不同模块并行，同域排队（核心场景）

```bash
R=/tmp/helmsman-board-smoke
mk() { curl -s -X POST $BB/api/item -H 'content-type: application/json' \
  -d "{\"title\":\"$1\",\"baseRepo\":\"$R\",\"module\":\"$2\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['item']['id'])"; }
toDev() { curl -s -X POST $BB/api/item/$1/advance -H 'content-type: application/json' -d '{}' >/dev/null
  curl -s -X PATCH $BB/api/item/$1 -H 'content-type: application/json' -d '{"specFinalized":true}' >/dev/null
  curl -s -X POST $BB/api/item/$1/advance -H 'content-type: application/json' -d '{}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('  ok=',d['ok'],'moved=',d['moved'],'stage=',d['item']['stageLabel'],'queue=',d.get('queueingReason'))"; }

BID=$(mk "看板冒烟B" beta); toDev "$BID"    # 同仓、不同模块 → 应放行
CID=$(mk "看板冒烟C" alpha); toDev "$CID"   # 同仓、同模块 alpha → 应被拒
```

期望（实测）：

```
  ok= True  moved= True  stage= 开发实施 queue= None
  ok= False moved= False stage= 规格设计 queue= 冲突域 "/tmp/helmsman-board-smoke:alpha" 已达 WIP 上限(1/1)
```

各域计数：

```bash
curl -s $BB/api/board/wip | python3 -c "
import sys,json;d=json.load(sys.stdin)
print('source=',d['source'])
for x in d['domains']: print('  %-44s running=%s/%s' % (x['key'], x['running'], x['limit']))"
# 实测（节选）：
#   source= service
#     /tmp/helmsman-board-smoke:alpha            running=1/1
#     /tmp/helmsman-board-smoke:beta             running=1/1
```

**这就是"一个仓库可以并行跑不同需求"的落地**：同仓库不同模块各自计数并放行；同域达上限则拒绝，并给出含域名与计数的中文排队原因。

### 6.5 归档门：无已合并 run 被拦

```bash
curl -s -X POST $BB/api/item/$AID/advance -H 'content-type: application/json' -d '{}' \
  | python3 -c "
import sys,json;d=json.load(sys.stdin)
print('ok=',d['ok'],'moved=',d['moved'],'stage=',d['item']['stageLabel'])
[print('   gap:',g['key'],'|',g['label']) for g in d['gaps']]"
# 实测：ok= False moved= False stage= 开发实施
#       gap: run-merged       | 该卡片尚未关联任何 run
#       gap: audit-on-record  | 无法确认合并审计记录:未配置 gate probe
```

### 6.6 会话建档（真实模型摘要）

```bash
SID=$(curl -s http://127.0.0.1:3080/helmsman-workbench/api/sessions \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['sessions'][0]['id'])")
curl -s -X POST http://127.0.0.1:3080/helmsman-workbench/api/task-from-conversation \
  -H 'content-type: application/json' \
  -d "{\"title\":\"会话建档冒烟\",\"repo\":\"/tmp/helmsman-board-smoke\",\"sessionId\":\"$SID\"}" \
  | python3 -c "
import sys,json;d=json.load(sys.stdin);it=d['item'];s=it['summary']
print('ok=',d['ok'],'id=',it['id'],'stage=',it['stageLabel'])
print('generatedBy=',s['generatedBy'],'chars=',len(s['text']))
print('head=',s['text'][:110].replace(chr(10),' '))"
```

期望（实测，摘要内容随会话而变）：

```
ok= True id= wi_26aaab310c534863 stage= 需求分析
generatedBy= model chars= 257
head= 对话主题是用 Helmsman 深度研究工作流为"MCP 协议一句话解释"产出结构化行业研究笔记。…
```

**要点**：`generatedBy=model` 表示走了真实模型摘要；模型不可用时退化为 `fallback`（最近消息前 ~200 字），**卡片仍会被创建**（不因摘要失败丢卡）。
该路由的仓库字段名是 `repo`（不是 `baseRepo`）；缺仓库且无法从会话 cwd 推导时返回 400
`invalid repo: 需要 repo 或 projectGroup(或提供能解析出 cwd 的 sessionId)`。

### 6.7 冲突裁决仍由人决定（设计约束，非功能缺失）

看板 run 面板对冲突**只标注并跳转 `/helmsman-diff/`**，页面内没有自动合并或一键采纳控件；
`packages/ui-board/src/client/run-panel.test.tsx` 有专门断言守护这一点，防止回归成系统代选。

### 6.8 已知未实现（如实记录）

**聊天消息侧「保存为任务」按钮**未实现：当前建档入口是看板页「+ 新建任务」表单，以及上面
可直接调用的 `POST api/task-from-conversation`。聊天消息动作属 DSH client slot 增强，留待后续。

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
rm -rf ~/.helmsman/{history,audit,artifacts,board}
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
