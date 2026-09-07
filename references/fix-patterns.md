# 修复模式与验证命令

每个问题 → 定位 → 修复示例 → 验证。前缀 ★ = 本机实战验证过的步骤。

## 模式 1:preset/插件 `session.events` 断链 ★

**定位**(体检脚本已标出文件与行):
```bash
grep -rn "session\.events" ~/.dsh/.agent-presets --include="*.mjs"
```
**区分适配层**:命中行所在文件若同时有 `snapshotEvents`/`eventAt` 调用,是"先探测新 API 再回退"的兼容写法,**不要动**(dsh-mnemon 0.5.2、dsh-im 4.9.1 即此类)。

**修复**(只改自己维护的 preset 文件,不改 node_modules):
```js
// 旧:const events = session.events                     → 升级后 undefined.some() 崩
const events = session.snapshotEvents()                // 全量只读快照(数组)
const one = session.eventAt(seq)                       // 按 seq 取单条,不物化全量
```
注意 `snapshotEvents()` 返回的数组可能是只读/投影视图,只遍历不修改。原先 `events[index]` 下标访问逻辑不变(`snapshotEvents()` 仍是数组)。

**验证**:
```bash
node --check <改过的文件>
node <skill>/scripts/verify-session.mjs <会话目录>    # 用内置版复核该会话可恢复
# 重启 dsh web(必须走 dshmarket,勿裸 kill):
curl -s -X POST http://127.0.0.1:3080/dsh-market/restart -H 'Origin: http://127.0.0.1:3080' -H 'Referer: http://127.0.0.1:3080/'
# 重启后打开一个此前崩溃的会话,确认能进入模型调用(turn/start → request/header → assistant/chunk)
```

## 模式 2:失效模型引用 ★

**定位**:
```bash
node <skill>/scripts/scan-upgrade.mjs   # model 分类输出失效 provider/model
# 或直接查会话 header:
zstd -dc <session.jsonl.zstd> | grep '"request/header"' | tail -1
```
判定规则:取最后一个 `model/selection`(没有则最后一个 `request/header`)里的 provider/model,
与 settings.yaml 声明集 + deepseek-official 官方集比对。子代理会话跳过(继承父会话模型)。
真实案例:旧会话写 `ark-coding-plan/deepseek-v4-flash`,而 settings.yaml 里该 provider 已改名
为 `deepseek-v4-flash-ga-260731` → 名字对不上 → UNKNOWN_MODEL。

**修复**(会话级,不动全局 settings、不改日志文件):
```bash
# 列失效会话(默认 dry-run):
node <skill>/scripts/fix-model-refs.mjs --list
# 批量切(先 --dry-run 再看执行;--all 强制所有顶层会话统一):
node <skill>/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-v4-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt --dry-run
node <skill>/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-v4-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt
```
cookie 前置:`curl -c /tmp/dshcookies.txt -o /dev/null "http://127.0.0.1:3080/?token=<TOKEN>"`。
等价的手工 RPC:
```bash
curl -s -b <cookie> -H 'Content-Type: application/json' -X POST http://127.0.0.1:3080/api/session/selectModel \
  -d '{"type":"client-request","rpcId":"1","method":"session/selectModel","payload":{"args":{"request":{"sessionId":"<sid>","provider":"deepseek-official","model":"deepseek-v4-flash","reasoningEffort":"high"}}}}'
```
**建议先单会话试通,再批量**;目标模型必须真实存在于声明集(脚本会预检,不在则拒绝执行)。
用户默认方案:**deepseek-official / deepseek-v4-flash**(官方内置集,不易再漂)。

**验证**:重跑 scan-upgrade → model 分类 OK;抽查会话最后一条 selection;打开任一旧会话
发起模型调用不再报 UNKNOWN_MODEL(turn/start → request/header → assistant/chunk 正常)。

## 模式 3:配置死干预行 ★

**定位**:
```bash
dsh --profile web --dump-config 2>&1 | grep 'not found'   # 输出行形如: patch: entry "skillhub" not found
```
**修复**:在 `~/.dsh/profiles/web/cordis.patch.yml` 删除对应 `- id: xxx` + `disabled: true` 两行。这些是 bundle 已移除后残留的行,删掉无副作用;profile 级 patch 改动**重启后生效**。

**验证**:
```bash
node <skill>/scripts/verify-patch.mjs --profile web        # T1/T2/T3 ALL PASS
node <skill>/scripts/verify-patch.mjs --profile web --diff-default   # 无 clobber/dead-patch
node <skill>/scripts/verify-patch-surface.mjs --profile web --check  # 干预面 S1 全命中(如有该脚本)
```

## 模式 4:第三方插件未适配(agent-teams 等)★

事实:@nanmicoder/dsh-agent-teams 0.1.15(npm 最新)源码用 `child.session.events.slice(...)` + `ctx.subagents.registerContinuableSetup`,在 0.1.2-rc.1 下**启用必失败**(dshmarket 日志:`entry update failed — ... is not a function`)。
- **正确动作**:保持该插件 `disabled: true`,等作者发布适配版。不要本地改 node_modules(下次升级即丢)。
- 若必须现在用:把插件目录复制到 `~/.dsh/plugins/<name>/` 本地维护,改 `session.events.slice(...)` → `session.snapshotEvents().slice(...)`,`header.seedLength` 读取改 `isSeeded` 语义,并去掉 `registerContinuableSetup` 调用(该 API 0.1.2 中已不存在,需按新 subagent API 重写,超出简单修复范围)。

**验证**:`dshmarket --profile web` 日志无 `on ok=false`;`cd ~/.dsh/profiles/web && node scripts/verify-patch.mjs` 不变红。

## 模式 5:校验工具误报修复 ★(本技能已内置)

- verify-session.mjs:S10 支持 range-pairs;KNOWN_TYPES 已同步官方 0.1.2 全集(源:`dsh-operations/scripts/`,本技能 scripts/ 同版)
- verify-patch.mjs:parseTree 跳过 `!!js` 多行块标量续行(修 mnemon-bundle 式 clobber 误报)
- 若你机器上还想更新旧的 dsh-operations 版本:`cp <skill>/scripts/verify-session.mjs <dsh-operations>/scripts/` 与 `cp <skill>/scripts/verify-patch.mjs ...`(本机源在 `<your-home>/projects/dsh-operations/scripts/`),然后 `node <dsh-operations>/test/run-gate-tests.mjs` 应 35 PASS

## 模式 6:会话引用的 preset 已删除 → resume 失败 ★(2026-09-08 实战)

**症状**:对会话发 `session/selectModel` 报 `gateway/internal: resume failed for session ...: preset "router-flash" not found (available: ...)`。旧会话在 UI 打开/恢复同样失败。与 UNKNOWN_MODEL 相互独立,但会**挡住模式 2 的修复**(selectModel 内部先 resume)。

**定位**:错误信息直接给出缺失 preset 名;统计各会话引用了哪些已删 preset:
```bash
zstd -dc <session.jsonl.zstd> | grep -aoE '"(router-[a-z]*|code)"' | sort | uniq -c
```
注意:session RPC 面(selectModel/rename/fork/...)**没有**切 preset 的方法,无法远程改会话的 preset 引用。

**修复**:按内置 standard 重建同名桩 preset(preset.yml + agent.cordis.yml 两个文件,无相对引用,复制即用):
```bash
STD=$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard
mkdir -p ~/.dsh/.agent-presets/<缺失名>
cp $STD/agent.cordis.yml ~/.dsh/.agent-presets/<缺失名>/
# preset.yml 写 name(加"兼容桩"标注)/description/order: 9x 放列表尾部
```
**桩不能事后删**——删了这些会话立刻再次无法 resume。preset 目录启动时加载,建完必须重启 dsh web(走 dshmarket)。
本机案例:20 个会话分别引用已删的 `router-flash`(12)/`router-standard`(2)/`code`(6),建桩+重启后批量切换 20/20 成功。

**验证**:重启后重跑 fix-model-refs(幂等,只切仍失效的)→ 0 失败;scan-upgrade 归零。

## 双闸门解读(常见结果)

| 输出 | 含义 | 动作 |
|---|---|---|
| verify-session ALL PASS | 会话日志可完整恢复 | — |
| S10 FAIL refs=成对值 | 工具旧(该用内置版) | 换脚本 |
| S8 WARN model/selection | 工具快照旧(该用内置版)或第三方扩展 | 换脚本 / --ignore-type |
| S9 FAIL 单帧 | 真损坏:session.list 会 500 | 用旧版本导出恢复(参考官方说明) |
| S6 WARN 空洞 | 压缩投影正常痕迹 | 忽略 |
| verify-patch T1 FAIL | 配置树装配问题 | 看 dump-config stderr 定位 |
| T2 FAIL | mcp 配置 !!/schema 问题 | 带/不带 token 双环境排查 |
| T3 WARN 连不上 | 远程 MCP 需鉴权或网络 | INFO 级,不阻断 |
| S1 死干预 ID | patch 行对应 bundle 已移除 | 删行 |
