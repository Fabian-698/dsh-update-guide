# 模型修复(UNKNOWN_MODEL)完整复盘

> 升级 0.1.2-rc.1 后,旧会话发起模型调用报 `UNKNOWN_MODEL` 的定位、修复、验证全过程。
> 2026-09-05 本机实战:16+1 个会话,先单会话试通、批量切换、统一方案,全部归零。

## 1. 症状与根因

**症状**:升级后打开历史会话尝试发消息 → 报 `UNKNOWN_MODEL`,turn 起不来;新会话正常
(全局默认模型 `agent-default-model` 不受影响)。只影响"记录了旧模型引用"的旧会话。

**根因**:0.1.2 的模型解析走**声明式 provider 目录**——settings.yaml 里
`llm-pi-ai.providers.<name>.models[*].id` + 官方内置 `deepseek-official` 模型集。
**会话日志里记录的 provider/model 必须命中这个目录才合法。**

本机真实案例(配置漂移):

```yaml
# 会话 request/header 记录的:
provider: ark-coding-plan
model:    deepseek-v4-flash          # 旧名,无后缀

# 0.1.2 的 settings.yaml 里该 provider 只声明了:
models:
  - id: deepseek-v4-flash-ga-260731  # 新名,带日期后缀
  - id: deepseek-v4-pro-ga-260813
```

→ 名字对不上 → UNKNOWN_MODEL。**模型 id 改名后,旧会话里写死的引用没有跟着变。**

## 2. 定位(判定"当前生效"引用)

原则:**优先取会话最后一个 `model/selection` 事件;没有则取最后一个 `request/header` 的
provider/model**——这才是会话下次调用时会用的模型,历史早期引用不算数。

```bash
# 单个会话:
f=$(find ~/.dsh/sessions -path '*<session-id>/session.jsonl.zstd' | head -1)
zstd -dc "$f" | grep '"model/selection"' | tail -1   # 有则看这条
zstd -dc "$f" | grep '"request/header"'   | tail -1  # 无 selection 则看这条

# 全量:run 体检脚本(自动跳过子代理会话)
node <skill>/scripts/scan-upgrade.mjs    # model 分类列出失效 provider/model
```

比对基准 = settings.yaml 声明集;`deepseek-official` 官方内置集:
`deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`。

**子代理会话不用查**:它继承父会话模型(spawn 时决定),父会话修好即可。

## 3. 修复(会话级 RPC,不改文件)

### 3.1 方案选择

| 方案 | 说明 | 结论 |
|---|---|---|
| 会话级 `session/selectModel` | 逐会话切换引用,不动全局 | ✅ 首选:精准、可批量、无副作用 |
| 改 settings.yaml 恢复旧引用 | 把失效名重新声明出来 | 保留"不该存在的旧名",复现漂移 |
| 改会话日志文件 | 改写记录的 provider/model | 危险:日志是审计链,不可篡改 |

### 3.2 单会话试通(先证明路径可行)

```bash
# 1) 拿 cookie(登录 token 从浏览器地址栏 /?token=... 获取):
curl -c /tmp/dshcookies.txt -o /dev/null "http://127.0.0.1:3080/?token=<TOKEN>"

# 2) 对单个会话发 selectModel(切到声明集内存在的模型):
curl -s -b /tmp/dshcookies.txt -X POST -H 'Content-Type: application/json' \
  http://127.0.0.1:3080/api/session/selectModel \
  --data-binary '{"type":"client-request","rpcId":"sm1","method":"session/selectModel",
    "payload":{"args":{"request":{"sessionId":"<sid>","provider":"deepseek-official",
    "model":"deepseek-v4-flash","reasoningEffort":"high"}}}}'
```

### 3.3 批量切换(有脚本,别手写循环)

```bash
# 列出全部失效会话(默认 dry-run,不改动):
node <skill>/scripts/fix-model-refs.mjs --list
# 或在 3.2 的 curl 之外,直接让脚本批量修:
node <skill>/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-v4-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt
# 先看将要发的请求:--list 或 --dry-run;确认后去掉 --dry-run 执行
```

脚本行为:对每个**当前引用无效**的顶层会话,把它的引用切到指定模型
(只切无效的,不动本来就有效的;`--all` 才强制全部重切);响应 `"ok":false`
会计数报错并继续,最后打印成功/失败数。失败多半是 token 过期或会话正忙,
重跑即可(幂等)。

### 3.4 修复后遗留的"旧引用"解释

切完后,会话日志里旧的 `request/header` 仍在(那是历史记录,不改),但**新追加的
`model/selection` 事件表示"当前生效模型"**,引擎优先用它。验证时看最后一条
`model/selection`,不是 grep 到任意一条。

## 4. 验证

```bash
# 1) 体检 model 分类 OK:
node <skill>/scripts/scan-upgrade.mjs
#   → model | ok | 会话当前模型引用全部有效(顶层共扫描 N 会话,跳过子代理 M)

# 2) 抽查修复过的会话,最后一条 selection:
zstd -dc <session.jsonl.zstd> | grep '"model/selection"' | tail -1
#   → {"provider":"deepseek-official","model":"deepseek-v4-flash",...}

# 3) 打开旧会话发一条消息:turn/start → request/header → assistant/chunk 正常走
```

## 5. 复用要点(其他设备)

1. 先跑 `scan-upgrade.mjs` 看 model 分类(失效的 provider/model 列表)
2. 确认漂移模式:旧名 vs 新名(改名、加日期后缀、换 provider)
3. **能切 `deepseek-official` 就切它**(内置集固定,不易再漂);第三方 provider
   只选 settings.yaml 里真实声明的 id
4. 先单会话试通 → 再批量;别 16 个全失败才找原因
5. 切完重跑 scan → model OK → 打开旧会话抽查
