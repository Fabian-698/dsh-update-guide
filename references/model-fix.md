# 模型修复(UNKNOWN_MODEL)完整复盘(0.1.5 版)

> 升级 0.1.2-rc.1 / 0.1.5-rc.1 后,旧会话发起模型调用报 `UNKNOWN_MODEL` 的定位、修复、验证全过程。
> 2026-09-05 首轮实战:16+1 个会话,先单会话试通、批量切换、统一方案,全部归零。
> 2026-09-10 按 0.1.5 复核:新默认模型、合法目录并集、selectModel 写全局默认的副作用一并写入本版。

## 0. 前置条件:先修 v0 迁移,再修模型

UNKNOWN_MODEL 会话如果**同时**命中 v0 迁移拒绝(0.1.5 的 v0→v1 迁移器拒绝旧版写入的三类历史形态,报
`refuses this format v0 Session`),`session/selectModel` 会在内部先 resume,**直接 resume failed**,根本走不到模型切换那一步。
此时先修模型只会一直失败,很容易误判成"模型名还是不对"。正确顺序:

1. `node <skill>/scripts/scan-upgrade.mjs` → 看 `migration` 分类(检查项 7);
2. 有 blocker 先按 fix-patterns.md 模式 15 用 `repair-v0-sessions.mjs` 修迁移:`--list` 预览 → 确认存在 `sessions.bak-*` 备份 → `--apply`;
3. 再回来跑本文的 `scan-upgrade.mjs`(model 分类)/`fix-model-refs.mjs --list`/`--apply`。

本机 6 个 old-model 会话正是这样"先修迁移、再切模型"一次通过的。

## 1. 症状与根因

**症状**:升级后打开历史会话尝试发消息 → 报 `UNKNOWN_MODEL`,turn 起不来;新会话正常
(全局默认模型不受旧引用影响)。只影响"记录了旧模型引用"的旧会话。

**根因**:模型解析走**声明式 provider 目录**——会话日志里记录的 provider/model 必须命中
当前合法目录才合法。模型 id 改名、provider 下架、或默认模型换代后,旧会话里写死的引用没有跟着变
→ 对不上 → UNKNOWN_MODEL。

**0.1.5 的两处变化**:
1. **新会话默认模型变为 `deepseek-flash`**(DeepSeek-V41-Flash);配置文件显式指定模型时以配置值为准。
2. **合法目录是三者的并集**:
   - 内置 `deepseek-official` 模型集(0.1.5 共 4 个 id)——
     `deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`;
   - settings.yaml 的 `llm-deepseek.models[*].id`(**扩展** deepseek-official 内置集,例如
     `deepseek-v4.1-flash-expires-on-0910`);
   - settings.yaml 的 `llm-pi-ai.providers.<name>.models[*].id`(第三方 provider 声明,例如
     `ark-coding-plan` 下的 `deepseek-v4-flash-ga-260731`)。

本机 0.1.2 真实案例(配置漂移):

```yaml
# 会话 request/header 记录的:
provider: ark-coding-plan
model:    deepseek-v4-flash          # 旧名,无后缀

# settings.yaml 里该 provider 只声明了:
models:
  - id: deepseek-v4-flash-ga-260731  # 新名,带日期后缀
  - id: deepseek-v4-pro-ga-260813
```

→ 名字对不上 → UNKNOWN_MODEL。**修法是修会话引用,不是把旧名重新声明回去**(后者会复现漂移)。

## 2. 定位(判定"当前生效"引用)

原则:**优先取会话最后一个 `model/selection` 事件;没有则取最后一个 `request/header` 的
provider/model**——这才是会话下次调用时会用的模型,历史早期引用不算数。

```bash
# 单个会话(v3 文件优先;两个文件都在时读 v3,见第 3 节误报 6)
D=~/.dsh/sessions/<workspace>/<sessionId>
zstd -dc "$D/session.v3.jsonl.zstd" 2>/dev/null | grep '"model/selection"' | tail -1
zstd -dc "$D/session.v3.jsonl.zstd" 2>/dev/null | grep '"request/header"'   | tail -1
zstd -dc "$D/session.jsonl.zstd"    2>/dev/null | grep '"model/selection"' | tail -1
zstd -dc "$D/session.jsonl.zstd"    2>/dev/null | grep '"request/header"'   | tail -1

# 全量:run 体检脚本(自动跳过子代理会话)
node <skill>/scripts/scan-upgrade.mjs    # model 分类列出失效 provider/model
node <skill>/scripts/fix-model-refs.mjs --list   # 等价的逐会话清单
```

**子代理会话不用查**:它继承父会话模型(spawn 时决定),父会话修好即可。识别特征(header 任意一条命中):
`origin:"subagent"` / `kind:"subagent"` / `delegationDepth>0` / 存在 `parentSession`;顶层会话
`delegationDepth:0`。scan-upgrade 与 fix-model-refs 都会跳过它们。

## 3. 六个常见误报案例(检查器必须避开)

1. **新默认模型 `deepseek-flash` 不在旧内置集里**。0.1.2 时代的内置集只有 3 个 id,0.1.5 新会话
   默认写 `deepseek-flash` → 旧检查器把它报成 UNKNOWN_MODEL。
   正确判定:内置集补上 `deepseek-flash`(0.1.5 共 4 个),或直接用当前版本包的目录。
2. **`llm-deepseek.models` 是对内置集的扩展**。例如 `deepseek-v4.1-flash-expires-on-0910`
   只在 settings.yaml 里声明,不在硬编码内置集里 → 只查内置集会误报。
   正确判定:内置集 ∪ `llm-deepseek.models`。
3. **`llm-pi-ai.providers` 段没被解析**。第三方 provider 的模型 id 合法与否只能看这段
   (缩进层级 `providers` → `<name>` → `models` → `- id`);解析器漏读/provider 名含特殊字符时会误报。
   正确判定:按 YAML 层级解析 providers 全部 `models[*].id`,与内置集合并。
4. **拿历史 `request/header` 代替当前 `model/selection`**。会话早期用过的 provider 可能早已下架,
   但最后一条 selection 已经切到合法模型 → 用旧 header 判定会误报。
   正确判定:最后一条 `model/selection` 优先;只有没有任何 selection 时才回退 header。
5. **子代理/嵌套会话的旧引用**。子代理 header 里可能保留父会话当时的旧模型,父会话已修好,子代理无需修
   (打开子代理本来就要父会话地址)。不跳过 → 父会话修完仍报失效。
   正确判定:按第 2 节四个 header 特征跳过子代理/嵌套会话。
6. **迁移后的 v3 后继 vs v2 原文件**。0.1.5 迁移旧会话时保留 `session.jsonl.zstd`(旧引用仍在),
   另生成 `session.v3.jsonl.zstd`(可能已带新 selection)。只扫 v2 → 误报"仍失效"。
   正确判定:v3 文件优先;两个文件都在时读 v3(scan/fix 均版本感知)。

> 另有两种"看似失效、其实合法"的情形无需动作:没有任何 selection/header 的空会话(跳过不判);
> 配置里被注释掉或不属于当前 profile 的 provider(不参与该 profile 的判定)。

## 4. 修复(会话级 RPC,不改文件)

### 4.1 方案选择

| 方案 | 说明 | 结论 |
|---|---|---|
| 会话级 `session/selectModel` | 逐会话切换引用,不动全局 | ✅ 首选:精准、可批量、可审计(写 model/selection 事件) |
| 改 settings.yaml 恢复旧引用 | 把失效名重新声明出来 | 保留"不该存在的旧名",复现漂移 |
| 改会话日志文件 | 改写记录的 provider/model | 危险:日志是审计链,不可篡改 |

### 4.2 单会话试通(先证明路径可行)

```bash
# 1) 拿 cookie(登录 token 从浏览器地址栏 /?token=... 获取):
curl -c /tmp/dshcookies.txt -o /dev/null "http://127.0.0.1:3080/?token=<TOKEN>"

# 2) 对单个会话发 selectModel(切到并集内存在的模型;0.1.5 新默认 deepseek-flash):
curl -s -b /tmp/dshcookies.txt -X POST -H 'Content-Type: application/json' \
  http://127.0.0.1:3080/api/session/selectModel \
  --data-binary '{"type":"client-request","rpcId":"sm1","method":"session/selectModel",
    "payload":{"args":{"request":{"sessionId":"<sid>","provider":"deepseek-official",
    "model":"deepseek-flash","reasoningEffort":"high"}}}}'
```

### 4.3 批量切换(有脚本,别手写循环)

```bash
# 列出全部失效会话(默认 dry-run,不改动):
node <skill>/scripts/fix-model-refs.mjs --list
# 先看将要发的请求:
node <skill>/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt --dry-run
# 确认后批量执行:
node <skill>/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt
# 若想统一所有顶层会话(不只失效的):加 --all
```

脚本行为:对每个**当前引用无效**的顶层会话,把它的引用切到指定模型
(只切无效的,不动本来就有效的;`--all` 才强制全部重切);目标合法性用第 1 节的**并集**预检,
不在并集内直接拒绝执行;响应 `"ok":false` 会计数报错并继续,最后打印成功/失败数。
失败多半是 token 过期、会话被锁(session.lock)或会话正忙,重跑即可(幂等)。

**⚠ 0.1.5 副作用:selectModel 成功后会同时写全局默认模型**(内部走 `agentDefaultModel.saveSelection`)。脚本会打印该提醒;这意味着批量修复
可能把"新会话默认模型"一并改掉。执行前想清楚全局默认要停在哪(`deepseek-flash` 是 0.1.5 的
出厂默认);如果只想修旧会话、不想动全局,执行后到设置面板/settings.yaml 把默认模型改回期望值。

### 4.4 修复后遗留的"旧引用"解释

切完后,会话日志里旧的 `request/header` 仍在(那是历史记录,不改),但**新追加的
`model/selection` 事件表示"当前生效模型"**,引擎优先用它。验证时看最后一条
`model/selection`,不是 grep 到任意一条。

## 5. 验证

```bash
# 1) 体检 model 分类 OK(按并集判定):
node <skill>/scripts/scan-upgrade.mjs
#   → model | ok | 会话当前模型引用全部有效(顶层共扫描 N 会话,跳过子代理 M)

# 2) 抽查修复过的会话,最后一条 selection(v3 优先):
zstd -dc <会话目录>/session.v3.jsonl.zstd 2>/dev/null | grep '"model/selection"' | tail -1
zstd -dc <会话目录>/session.jsonl.zstd   | grep '"model/selection"' | tail -1
#   → {"provider":"deepseek-official","model":"deepseek-flash",...}

# 3) 打开旧会话发一条消息:turn/start → request/header → assistant/chunk 正常走

# 4) 收尾双闸门(含 V3 一致性 S12):
node <skill>/scripts/verify-session.mjs --all
node <skill>/scripts/verify-patch.mjs --profile web
```

## 6. 复用要点(其他设备)

1. 先跑 `scan-upgrade.mjs` 看 model 分类(失效 provider/model 列表),或
   `fix-model-refs.mjs --list` 看逐会话清单;两者都跳过子代理会话、v3 优先。
2. 确认漂移模式:旧名 vs 新名(改名、加日期后缀、换 provider;或默认模型换代)。
3. **能切 `deepseek-official` 就切它**(内置集固定,不易再漂);0.1.5 建议目标 `deepseek-flash`
   (新默认),老会话原本用 `deepseek-v4-flash` 也可保留。第三方 provider 只选并集内真实声明的 id。
4. 先单会话试通 → 再批量;批量前确认 **selectModel 会写全局默认模型**这一副作用能否接受。
5. 切完重跑 scan → model OK → 打开旧会话抽查 → 双闸门 ALL PASS。
6. 独立复制到别的机器:先在装有 owner 技能的机器上 `node <skill>/scripts/sync-gates.mjs --embed` 生成内置副本,
   再整体复制本技能目录(含 `scripts/gates/`);目标机才谈得上"shim 解析不到 owner 时用内置副本"。