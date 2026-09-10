# 修复模式与验证命令

每个问题 → 定位 → 修复示例 → 验证。前缀 ★ = 本机实战验证过的步骤。
模式 1-6 针对 0.1.2 代断链,模式 7-15 针对 0.1.5 代(V3 格式与插件 API、v0 迁移修复)。
闸门脚本已收归 owner:verify-session 规范版在 dsh-session-logs/scripts/,
verify-patch(与 verify-patch-surface)规范版在 dsh-config-assembly/scripts/;
本技能 scripts/ 下的是解析到 owner 的 shim,命令形态不变。

## 目录

- 模式 1:preset/插件 `session.events` 断链 ★
- 模式 2:失效模型引用 ★
- 模式 3:配置死干预行 ★
- 模式 4:第三方插件未适配与启用前 boot 测试 ★
- 模式 5:校验工具误报修复 ★(闸门已收归 owner)
- 模式 6:会话引用的 preset 已删除 → resume 失败 ★(2026-09-08 实战)
- 模式 7:V3 日志读取器适配(0.1.5)★
- 模式 8:ctx.agent 移除(0.1.5)★
- 模式 9:Inbox 类型接口(0.1.5)★
- 模式 10:面板 Slot 迁移(0.1.5)★
- 模式 11:persona prefix/suffix 拆分(0.1.5)★
- 模式 12:minimal 工具集适配(0.1.5)★
- 模式 13:普通 subprocess pid 移除(0.1.5)★
- 模式 14:session.lock / agent-busy 判因(0.1.5)★
- 模式 15:v0 会话迁移被拒(打开即 resume failed)★(2026-09-10 实战)
- 双闸门解读(常见结果)

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
node <skill>/scripts/verify-session.mjs <会话目录>    # shim → owner 规范版复核该会话可恢复
# 重启 dsh web(必须走 dshmarket,勿裸 kill):
curl -s http://127.0.0.1:3080/dsh-market/status   # 先确认无锁/无安装任务
curl -s -X POST http://127.0.0.1:3080/dsh-market/restart -H 'Origin: http://127.0.0.1:3080' -H 'Referer: http://127.0.0.1:3080/'
# 重启后打开一个此前崩溃的会话,确认能进入模型调用(turn/start → request/header → assistant/chunk)
```

## 模式 2:失效模型引用 ★

**定位**:
```bash
node <skill>/scripts/scan-upgrade.mjs   # model 分类输出失效 provider/model
# 或直接查会话 header(优先 v3 文件,见模式 7):
zstd -dc <会话目录>/session.v3.jsonl.zstd 2>/dev/null | grep '"request/header"' | tail -1
zstd -dc <会话目录>/session.jsonl.zstd   | grep '"request/header"' | tail -1
```
判定规则:取最后一个 `model/selection`(没有则最后一个 `request/header`)里的 provider/model,
与**并集**比对 = 内置 deepseek-official 集 ∪ settings.yaml `llm-deepseek.models` ∪ `llm-pi-ai.providers.<name>.models[*].id`。
子代理会话跳过(继承父会话模型;header 含 origin:"subagent"/kind:"subagent"/delegationDepth>0/有 parentSession)。
真实案例:旧会话写 `ark-coding-plan/deepseek-v4-flash`,而 settings.yaml 里该 provider 已改名为
`deepseek-v4-flash-ga-260731` → 名字对不上 → UNKNOWN_MODEL。

**修复**(会话级,不动全局 settings、不改日志文件):
```bash
# 列失效会话(默认 dry-run):
node <skill>/scripts/fix-model-refs.mjs --list
# 批量切(先 --dry-run 再看执行;--all 强制所有顶层会话统一):
node <skill>/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt --dry-run
node <skill>/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt
```
cookie 前置:`curl -c /tmp/dshcookies.txt -o /dev/null "http://127.0.0.1:3080/?token=<TOKEN>"`。
等价的手工 RPC:
```bash
curl -s -b <cookie> -H 'Content-Type: application/json' -X POST http://127.0.0.1:3080/api/session/selectModel \
  -d '{"type":"client-request","rpcId":"1","method":"session/selectModel","payload":{"args":{"request":{"sessionId":"<sid>","provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"high"}}}}'
```
**建议先单会话试通,再批量**;目标模型必须在并集内(脚本会预检,不在则拒绝执行)。
0.1.5 用户默认方案:**deepseek-official / deepseek-flash**(0.1.5 新默认、内置集固定);
老会话若原先用 deepseek-v4-flash,也可继续切它。
**注意 0.1.5 副作用**:selectModel 成功后同时写**全局默认模型**(脚本会打印提醒)——
批量前想清楚全局默认要停在哪,不想动全局就在执行后改回。

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
node <skill>/scripts/verify-patch.mjs --profile web        # T1/T2/T3 ALL PASS(shim → owner)
node <skill>/scripts/verify-patch.mjs --profile web --diff-default   # 无 clobber/dead-patch
node <dsh-config-assembly>/scripts/verify-patch-surface.mjs --profile web --check  # 干预面 S1 全命中
```

## 模式 4:第三方插件未适配与启用前 boot 测试 ★

**固定步骤:启用任何第三方插件前,先做隔离 boot 测试**——静态扫描覆盖不到只在插件 apply 时触发的断链,
而失效插件会让**整棵插件树**加载失败(dsh web 直接起不来):

```bash
node <skill>/scripts/test-plugin-boot.mjs          # 复制 profile 到临时 DSH_HOME,全量启用并逐轮隔离失败项
node <skill>/scripts/test-plugin-boot.mjs --json   # 机器可读;--keep 保留临时 home 与日志排查
```

脚本只读真实 `~/.dsh`(复制 profile、排除 node_modules 后软链;settings/credentials 复制进 0700 临时目录,
结束即删),用 `dsh web --port 0 --no-open` 启动,看到 URL 后再等 15s 让晚失败的 entry 暴露;失败项按
`failed to apply loader entry <id> (<包名>)` 自动 quarantine 后重试。退出码 `0`=全部可启用,`1`=有不兼容项
(已列清单),`2`=环境不满足或非插件单点失败。本机 2026-09-10 实测:静态 scan 全绿,该脚本一轮就抓到
`@js2hou/dsh-mcp-manager` 启动即崩。

**0.1.5 新失败类:服务访问必须 inject**。0.1.5 的 `ctx.connection.rpc.handle(...)` 在**调用方 fiber** 上
注册路由并取 `webServer` 服务;插件 `inject` 缺 `"webServer"` → 启动报
`cannot get property "webServer" without inject`,**整棵插件树加载失败**(scan 检查项 2 会标 blocker;插件已
disabled 时降为 warning)。
- 实例:`@js2hou/dsh-mcp-manager` 0.1.5(npm 与 GitHub 均为最新;上游 issue #6 同因未修)→ **保持 disabled 等上游**。
- 本机实测给该插件 inject 补 `"webServer"` 后**仍然失败**,说明不只是 inject 表面缺失,不要自行硬改 node_modules
  (升级即丢);确需本地维护就复制到 `~/.dsh/plugins/<name>/`,并同样先跑 boot 测试。
- 同类形态:插件直接 `ctx.connection.rpc` 拿通道注册器的,先查自己 inject 有没有 `webServer`。

事实(0.1.2 代):@nanmicoder/dsh-agent-teams 0.1.15(npm 最新)源码用 `child.session.events.slice(...)` +
`ctx.subagents.registerContinuableSetup`,在 0.1.2-rc.1 下**启用必失败**(dshmarket 日志:`entry update failed
— ... is not a function`)。
- **正确动作**:保持该插件 `disabled: true`,等作者发布适配版。不要本地改 node_modules(下次升级即丢)。
- 若必须现在用:把插件目录复制到 `~/.dsh/plugins/<name>/` 本地维护,改 `session.events.slice(...)` →
  `session.snapshotEvents().slice(...)`,`header.seedLength` 读取改 `isSeeded` 语义,并去掉
  `registerContinuableSetup` 调用(该 API 0.1.2 中已不存在,需按新 subagent API 重写,超出简单修复范围)。
- 0.1.5 起 Agent Teams 包可从 npm 安装,但**需显式添加 profile,不默认启用**;启用前先确认插件已适配
  `ctx.agent` 移除、Inbox 类型接口、conversation Slot 迁移(模式 8-10)。

**验证**:`node <skill>/scripts/test-plugin-boot.mjs` 退出码 0 且无 quarantine;dshmarket 日志无 `on ok=false`;
`node <skill>/scripts/verify-patch.mjs --profile web` 不变红。

## 模式 5:校验工具误报修复 ★(闸门已收归 owner)

- verify-session.mjs(owner:dsh-session-logs/scripts/)S10 支持 range-pairs;KNOWN_TYPES 已同步
  0.1.5 全集,并新增 **S12**(session.v3 文件名与 header version:3 一致性)。
- verify-patch.mjs(owner:dsh-config-assembly/scripts/)parseTree 跳过 `!!js` 多行块标量续行
  (修 mnemon-bundle 式 clobber 误报)。
- 本技能 `scripts/verify-session.mjs`、`scripts/verify-patch.mjs` 是**解析到 owner 的 shim**:
  仍按原命令跑 `node <skill>/scripts/verify-session.mjs --all` 即可,逻辑跟随 owner 更新,
  不要在本技能里手改这两个文件(会覆盖 shim)。
- **独立复制到别的机器**:先在仍装有 owner 技能的机器上运行 `node <skill>/scripts/sync-gates.mjs --embed`,
  把 owner 版复制到本技能 `scripts/gates/`,再整体复制本技能目录(含 `scripts/gates/`);
  目标机 shim 解析顺序 gates/ 优先、owner 次之。`--check` 校验内置副本与 owner 是否漂移(只在源机有意义)。

## 模式 6:会话引用的 preset 已删除 → resume 失败 ★(2026-09-08 实战)

**症状**:对会话发 `session/selectModel` 报 `gateway/internal: resume failed for session ...: preset "router-flash" not found (available: ...)`。旧会话在 UI 打开/恢复同样失败。与 UNKNOWN_MODEL 相互独立,但会**挡住模式 2 的修复**(selectModel 内部先 resume)。

**定位**:错误信息直接给出缺失 preset 名;统计各会话引用了哪些已删 preset:
```bash
# v2/v3 两个文件都查(v3 优先);目录名含 workspace 编码,路径按实际替换
zstd -dc <会话目录>/session.v3.jsonl.zstd 2>/dev/null | grep -aoE '"(router-[a-z]*|code)"'
zstd -dc <会话目录>/session.jsonl.zstd   | grep -aoE '"(router-[a-z]*|code)"' | sort | uniq -c
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

## 模式 7:V3 日志读取器适配(0.1.5)★

**背景**:0.1.2 的旧格式文件是 `session.jsonl.zstd`(header `"version":0`);0.1.5 的 V3 是
`session.v3.jsonl.zstd`(header `"version":3`)。**新会话是 V3-only**;旧会话迁移后 **v2 原文件保留、v3 为后继**(本机已确认两者并存)。
V3 **不支持降级读取**——旧版 dsh 读不了 v3。

**定位**:
```bash
ls ~/.dsh/sessions/<workspace>/<sessionId>/          # 可能同时有 session.jsonl.zstd 与 session.v3.jsonl.zstd
zstd -dc <会话目录>/session.v3.jsonl.zstd 2>/dev/null | head -1   # {"type":"session","version":3,...}
zstd -dc <会话目录>/session.jsonl.zstd   | head -1                 # {"type":"session","version":0,...}
node <skill>/scripts/scan-upgrade.mjs     # 输出 v2/v3 迁移进度统计
```

**修复示例**(Node ESM,最小改动读取端):
```js
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// 旧:写死 v2 文件名
// const file = join(sessionDir, 'session.jsonl.zstd')

// 新:优先 v3,按 header version 分流
const candidates = ['session.v3.jsonl.zstd', 'session.jsonl.zstd']
const file = candidates.map(n => join(sessionDir, n)).find(existsSync)
if (!file) throw new Error('会话日志不存在')

const z = spawnSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
if (z.status !== 0) throw new Error('zstd 解压失败')
const header = JSON.parse(z.stdout.split('\n', 1)[0])
const format = header.version   // 0 = v2 旧格式;3 = V3
// 事件行结构两者都是 type/seq/data;差异点按 header.version 分支处理
```
规则:不要重命名/删除迁移产物;不要用 v3 内容回写 v2;报告/统计工具同时覆盖两种文件名。

**验证**:
```bash
node <skill>/scripts/verify-session.mjs <会话目录> --json   # 含 S12:文件名与 header version 一致
node <skill>/scripts/verify-session.mjs --all                    # 全量闸门 ALL PASS
```

## 模式 8:ctx.agent 移除(0.1.5)★

**背景**:插件 Agent API 调整,`ctx.agent` 被移除,调用方需**显式传递 Agent**;同时可继续对话的
子代理归属被修正(不再被当根会话参与定时调度)。

**定位**:
```bash
node <skill>/scripts/scan-upgrade.mjs        # 0.1.5 检查集命中 ctx.agent
grep -rn 'ctx\.agent' ~/.dsh/plugins ~/.dsh/.agent-presets --include='*.mjs' --include='*.js' --include='*.cjs' 2>/dev/null | grep -v node_modules
```

**修复示例**:由调用点显式把 Agent 传进来,不要在插件上下文里隐式取:
```js
// 旧(0.1.5 起 ctx.agent 为 undefined)
const agent = ctx.agent

// 新:显式传参(具体形参名按你的插件签名调整)
export function apply(ctx, config, agent) {
  // 或用调用点拿到的 Agent
  doSomething(agent)
}
```
若插件是第三方包,优先等上游适配版;自己维护的 preset 按上述改。改完 `node --check`。

**验证**:
```bash
node --check <改过的文件>
node <skill>/scripts/scan-upgrade.mjs        # 该条消失
# 重启后看插件启用:dshmarket 日志无 on ok=false / ctx.agent is not a function
```

## 模式 9:Inbox 类型接口(0.1.5)★

**背景**:`Inbox` 改为**类型接口**,不再导出可构造的运行时类;`hasPending` 与 `claim` 不再属于公共接口;
插件通过 `agent.inbox` 读写待处理消息。

**定位**:
```bash
node <skill>/scripts/scan-upgrade.mjs   # 0.1.5 检查集命中 Inbox 用法
grep -rn 'new Inbox\|\.hasPending\|\.claim(' ~/.dsh/plugins --include='*.mjs' --include='*.js' 2>/dev/null | grep -v node_modules
```

**修复示例**:
```js
// 旧:const inbox = new Inbox(); if (inbox.hasPending()) ...
// 新:从 Agent 上拿 inbox
const inbox = agent.inbox
// 待处理消息的读取/写入走 agent.inbox 公共 API;
// hasPending / claim 不再是公共接口,等待/认领语义按当前包内 Inbox 类型定义重写
```

**验证**:
```bash
node --check <改过的文件>
node <skill>/scripts/scan-upgrade.mjs   # 该条消失
```

## 模式 10:面板 Slot 迁移(0.1.5)★

**背景**:Web 插件面板 API 调整——可通过 `sidebar.panellist` 与 `main` 注册全局面板;原 `conversation`
Slot 迁移为 `main` 的 `conversation` key;**Detail 面板已移除**,能力迁至右侧 Sidebar(多标签/分栏/全屏,
Markdown、代码、HTML、PDF、图片预览,含子代理与未激活会话的文件)。

**定位**:
```bash
node <skill>/scripts/scan-upgrade.mjs   # 0.1.5 检查集命中 conversation Slot / Detail
grep -rn "slot.*conversation\|'conversation'\|Detail" <你的 client 插件 src> 2>/dev/null
```

**修复示例**(概念迁移,具体 API 名对照当前 dsh 客户端包):
```js
// 旧:把面板挂到 conversation Slot
// ctx.slot('conversation', MyPanel)

// 新:全局面板注册到 sidebar.panellist 与 main;
//     会话级面板用 main 的 conversation key
ctx.main?.conversation  // key 迁移
ctx.sidebar?.panellist  // 全局面板容器
// 原 Detail 面板的文件/产物预览改用右侧 Sidebar;
// 交付文件走 deliverables/presented 事件(详见 breaking-changes-0.1.5.md #7)
```

**验证**:
```bash
cd <插件目录> && pnpm build   # client bundle 构建通过
node <skill>/scripts/verify-patch.mjs --profile web   # 插件挂载后装配仍 ALL PASS
# 刷新 GUI:右侧 Sidebar 出现面板,原 Detail 入口不再报错
```

## 模式 11:persona prefix/suffix 拆分(0.1.5)★

**背景**:自定义 persona 配置拆分为前缀(prefix)和后缀(suffix),旧配置及相关常量需适配。

**定位**:
```bash
grep -rn 'persona' ~/.dsh/settings.yaml ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/.agent-presets 2>/dev/null | grep -v node_modules
node <skill>/scripts/scan-upgrade.mjs   # 0.1.5 检查集命中 persona 旧写法
```

**修复示例**(YAML,字段名以当前 schema 为准):
```yaml
# 旧:persona: |
#   <整段文本>
# 新:拆成两段
personaPrefix: |
  <开头部分>
personaSuffix: |
  <结尾部分>
```
旧常量(如代码里拼接的整段 persona)同步拆成两个常量,不要保留旧字段。

**验证**:
```bash
dsh --profile web --dump-config >/dev/null   # 树能装配
node <skill>/scripts/verify-patch.mjs --profile web   # ALL PASS 再重启
# 重启后开新会话,确认系统提示词里 persona 前后段都在(可用 dsh-session-logs 技能看 request/header)
```

## 模式 12:minimal 工具集适配(0.1.5)★

**背景**:0.1.5 起 SDK/Headless/ACP 默认用 `read`/`write`/`edit` 编辑文件;Web `minimal` 与
Python `sdk-minimal` 默认**仅提供持久 shell**,`str_replace_editor` 需**显式启用**;持久 Bash 输出统一报告退出或超时状态。

**定位**:
```bash
# 看某个会话请求头里的工具清单(v3 优先)
zstd -dc <会话目录>/session.v3.jsonl.zstd 2>/dev/null | grep 'request/header' | tail -1
# 看 preset/装配
node <skill>/scripts/scan-upgrade.mjs --profile web
dsh --profile web --dump-config | grep -i str_replace_editor
```

**修复示例**(显式启用,具体 patch 形态按你的 preset 写):
```yaml
# cordis.patch.yml / preset 装配里显式挂上 str_replace_editor 工具包
- insert:
    - id: str-replace-editor
      name: <对应的工具插件包名>
      config: {}
```
若不依赖它,改用默认带 read/write/edit 的 preset,不要继续按 0.1.2 的"默认有编辑器"假设写自动化。

**验证**:
```bash
node <skill>/scripts/verify-patch.mjs --profile web   # T1 条目在树中
# 新开 minimal 会话发一条命令,工具清单包含所需工具;或检查 request/header
```

## 模式 13:普通 subprocess pid 移除(0.1.5)★

**背景**:普通 subprocess handle **不再暴露 `pid`**(终端 handle 不受影响);同时改善了
Windows 和部分 Linux 环境的子进程清理。

**定位**:
```bash
grep -rn '\.pid\b' ~/.dsh/plugins --include='*.mjs' --include='*.js' 2>/dev/null | grep -v node_modules
node <skill>/scripts/scan-upgrade.mjs   # 0.1.5 检查集
```

**修复示例**:
```js
// 旧:const pid = handle.pid   // 0.1.5 普通 subprocess handle 上为 undefined
// 新:用 handle 的等待/终止/状态 API 判活
await handle.wait()
handle.kill()
// 确需 pid 的场景改用 terminal handle(terminal 的 pid 保留)
```

**验证**:
```bash
node --check <改过的文件>
node <skill>/scripts/scan-upgrade.mjs   # 该条消失
# 重启后跑一次用该插件的流程,无 undefined/not a function
```

## 模式 14:session.lock / agent-busy 判因(0.1.5)★

**背景**:0.1.5 新增 session 锁,同一 session 至多被一个进程持有;打开子代理会话本来就会报
`agent-busy`(需要父会话地址,设计行为)。**锁冲突不等于日志损坏**。

**定位**:
```bash
ls -la ~/.dsh/sessions/<workspace>/<sessionId>/     # 看 session.lock 是否存在
ps -ef | grep -i dsh | grep -v grep                        # 确认是否还有别的 dsh 进程/子代理在跑
zstd -dc <会话目录>/session.v3.jsonl.zstd 2>/dev/null | head -1   # 看 origin/delegationDepth/parentSession
```

**处理**:
- 子代理会话(origin:"subagent" / kind:"subagent" / delegationDepth>0 / 有 parentSession):
  `agent-busy` 是设计行为,不用修,从父会话进入。
- 顶层会话被锁:先停掉仍持有该会话的进程,再重试;**不要手工删 session.lock**,也不要改会话文件。
- 若锁文件与进程都无异常但仍打不开:转模式 2(preset/模型)与双闸门复查。

**验证**:
```bash
node <skill>/scripts/verify-session.mjs --all --json   # S1/S2/S6/S8-S12 无 FAIL
# 再次打开该会话:能进入模型调用即可
```

## 模式 15:v0 会话迁移被拒(打开即 resume failed)★(2026-09-10 实战)

**症状**:打开/恢复旧会话报
`resume failed ... SessionQueryError: ... @deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session: <原因>; source v0 artifact remains unchanged`。
0.1.5 的 v0→v1 迁移器是**冻结校验**,只认 v0 规范形态;被拒的会话**不会**生成 v3 后继,source v0 原文件字节不变。原因只有三类:

- A. **插件消息 source 带 `summary` 但 `form != "notice"`**(旧版 dsh-mnemon 注入的 instructions/recall 消息)
  → 报 `user/message N source summary requires notice form`
- B. **`subagent/descriptor` 的 `data.version === 2`**(字段与当前 v3 完全相同,只是版本号旧)
  → 报 `subagent/descriptor N uses unsupported descriptor version 2`
- C. **`assistant/chunk` 的 finish chunk 用 v1 平铺 `replayState`**(顶层有 `kind`;当前格式是 `{ response, blocks }`)
  → 报 `assistant/chunk N chunk replayState has unexpected member "kind"`

**定位**:
```bash
# 首选:体检脚本检查项 7(category=migration);已提交的拒绝形态=blocker,尾部可丢弃行=warning
node <skill>/scripts/scan-upgrade.mjs
# 逐会话预览(默认动作,只体检不写盘;--json 机器可读):
node <skill>/scripts/repair-v0-sessions.mjs --list
# 手工核对(仅 v2、无 v3 后继的会话):
zstd -dc <会话目录>/session.jsonl.zstd | grep -nE '"summary"|subagent/descriptor|replayState'
```
速查正则:A = 行内出现 `"summary"` 且同一 source 对象没有 `"form":"notice"`;B = `"type":"subagent/descriptor"` 且其 `"version":2`;C = `"type":"assistant/chunk"` 且 `chunk.replayState` 顶层出现 `"kind"`。

**修复**(必须已有备份;repair 只就地原子替换 v0 原文件,不删其它任何文件):
```bash
# 0) 备份(apply 在没有非空 sessions.bak-* 时会直接拒绝):
bak=~/.dsh/sessions.bak-$(date +%Y%m%d-%H%M%S)
test ! -e "$bak" && cp -R ~/.dsh/sessions "$bak" && du -sh "$bak"
# 1) 先体检:确认"可修复"数量与 scan 的 migration blocker 对得上
node <skill>/scripts/repair-v0-sessions.mjs --list
# 2) 执行(可用 --limit N 分批;流程:离线解压 → 三类最小规范化 → dsh 自带 sessionFormatCatalog
#    跑完整迁移链校验 → 多帧压缩 → 再校验真实字节 → 原子替换;任何一步不通过都不写盘)
node <skill>/scripts/repair-v0-sessions.mjs --apply
```
> 备份门禁要求 `sessions.bak-*` 含目标会话的同路径备份(空目录不算);`--list` 文本模式会逐条列出可修复会话与命中数。
> `--limit N` 只限制"待修复会话"数量(已可迁移/不可修复不占配额),达到上限后停止分类;与 scan 对账时不要带 `--limit`。
退出码:`0` = 无需修复或全部成功,`1` = 有不可修复/apply 失败,`2` = 环境不满足(找不到 catalog 或无备份)。
只处理**没有 `session.v3.jsonl.zstd` 后继**的 v0 会话;`--force` 可跳过备份检查但**不建议**。

**验证**:
```bash
node <skill>/scripts/repair-v0-sessions.mjs --list    # 可修复项归零
node <skill>/scripts/scan-upgrade.mjs                 # migration 分类 = ok
node <skill>/scripts/verify-session.mjs --all --json  # S1/S2/S6/S8-S12 无 FAIL
node <skill>/scripts/verify-session.mjs <会话目录>    # 单会话复核
# 打开抽查:原先 resume failed 的会话能进入模型调用(turn/start → request/header → assistant/chunk)
```

**尾部 warning 的解释**:违规行若出现在最后一个 `turn/end` **之后**(未提交尾部),recoverable 解码会**静默丢弃该行**而不是拒绝——会话本就能打开,只是丢该行的 replay/描述元数据。scan 因此报 `migration` **warning**(不是 blocker);想保住这些尾部记录再跑 repair 的 `--list/--apply`。

**边界**:repair 只改 v0 原文件里的 **3 个已知字段**——删掉非 notice 的 `source.summary`、把 `subagent/descriptor.version` 从 2 改成 3、把平铺 `replayState` 归一化为 `{ response, blocks }`(平铺成员移入 `response`),**不改事件语义**;已有 v3 后继的会话一律跳过;修完仍由 0.1.5 正常完成 v3 迁移(或首次打开时惰性完成)。

## 双闸门解读(常见结果)

| 输出 | 含义 | 动作 |
|---|---|---|
| verify-session ALL PASS | 会话日志可完整恢复 | — |
| S10 FAIL refs=成对值 | 工具旧(该用 owner/shim 版) | 换脚本 |
| S8 WARN model/selection 等 | 工具快照旧或第三方扩展 | 换 shim / --ignore-type |
| S9 FAIL 单帧 | 真损坏:session.list 会 500 | 用旧版本导出恢复(参考官方说明) |
| S6 WARN 空洞 | 压缩投影正常痕迹 | 忽略 |
| S12 FAIL | session.v3 文件名与 header version 不一致(迁移/拷贝残缺) | 从备份恢复该会话目录,勿手改文件 |
| verify-patch T1 FAIL | 配置树装配问题 | 看 dump-config stderr 定位 |
| T2 FAIL | mcp 配置 `!!js`/schema 问题 | 带/不带 token 双环境排查 |
| T3 WARN 连不上 | 远程 MCP 需鉴权或网络 | INFO 级,不阻断 |
| S1 死干预 ID | patch 行对应 bundle 已移除 | 删行 |
| migration blocker / warning | v0 会话被迁移器拒绝(打开即 resume failed);尾部行只是被静默丢弃 | blocker 按模式 15 用 repair-v0-sessions.mjs 修复;warning 可忽略或一并修 |
