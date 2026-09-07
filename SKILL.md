---
name: dsh-upgrade-fix-012
description: 修复 DeepSeek Harness (dsh) 升级到 0.1.2-rc.1（及 0.1.2 系候选版）后出现的断链：旧会话打开报 "Cannot read properties of undefined (reading 'some')"、UNKNOWN_MODEL、turn 崩溃、插件启用失败（如 agent-teams）、verify-session 全量扫描 S10/S8 误报、配置死干预行不生效。任何设备刚升级 dsh 后请先跑本技能：一键体检脚本 scan-upgrade.mjs 输出问题清单，按清单修复后用双闸门（verify-session + verify-patch）确认归零。触发场景："升级后旧会话打不开/报错"、"dsh 0.1.2"、"Session.events/snapshotEvents"、"UNKNOWN_MODEL"、"verify-session S10 失败"、"升级后插件挂了"、正在另一台机器上装 dsh 且要把这套修复经验带走。
---

# dsh 0.1.2-rc.1 升级修复

## 这个技能解决什么

dsh 0.1.2-rc.1(2026-09-03 发布,2026-09-05 装机实战)是 0.1.2 系列首个候选版,内部 API 与日志格式有多处不兼容改动。**升级本身是成功的——坏的是"依赖旧 API 的东西"**:

- 自定义 agent preset 用旧 `session.events` → 旧会话恢复即崩(`undefined.some()`)
- 第三方插件未适配 → 启用失败或运行时抛错
- 会话仍引用失效模型 id → `UNKNOWN_MODEL`
- 自家校验工具没跟上新格式 → **误报**会话损坏(13 个会被误判)

核心原则:**先体检定位,再逐项修复,最后双闸门验证**。不要凭症状猜——同一症状(打不开会话)可能来自 preset 断链、模型失效、子代理会话三种完全不同的原因,体检脚本帮你分流。

## 一键体检(第一件事)

```bash
node <skill>/scripts/scan-upgrade.mjs [--dsh-home ~/.dsh] [--json]
```

检测 6 类问题:版本核对、旧 API 残留(含兼容层识别)、第三方插件断链(含 disabled 降级)、配置死干预、失效模型引用(跳过子代理会话)、未知事件类型。退出码 0=无阻断,1=有 blocker。**本机(修复完成态)跑出来应为 0 blocker**,可先跑一次看基线。

## 修复顺序

按体检输出的 blocker → warning 顺序处理:

### 1. 自定义 preset 的 `session.events`(最常崩,blocker)

0.1.2 移除了 `Session.events` 属性,换成按需 API。**全量遍历用 `snapshotEvents()`,按 seq 取单条用 `eventAt(seq)`**。模式:先探测新 API 再回退旧引用(兼容层,常见于已适配插件),只有无探测的裸引用才是断链:

```js
// 旧(0.1.2 必崩)
const events = session.events
events.some(e => e.type === 'tool/call')

// 新
const events = session.snapshotEvents()
events.some(e => e.type === 'tool/call')
// 或单条:
const ev = session.eventAt(seq)
```

改完 `node --check` 每个文件。preset 目录:`~/.dsh/.agent-presets/<name>/`(其他设备的 DSH_HOME 下同)。**注意:预设文件由进程启动时加载,已实例化的 agent 仍持旧模块——改完必须重启 dsh web 才生效**(重启必须走 dshmarket:先 `GET /dsh-market/status` 确认无锁,再 `POST /dsh-market/restart` 带同源 Origin/Referer;不要裸 kill)。

### 2. 失效模型引用(blocker)

会话"当前生效"的 provider/model 不在 settings.yaml 声明集(或官方 deepseek-official 内置集)里
→ `UNKNOWN_MODEL`。**这不是配置坏了,而是模型 id 改名(常加日期后缀)后,旧会话里写死的引用没跟着变。**
取"当前生效"引用 = 最后一个 `model/selection`,没有则取最后一个 `request/header`;子代理会话跳过
(继承父会话模型)。体检脚本的 model 分类会直接列出失效的 provider/model 与被影响会话。

**修法(会话级,不动全局、不改日志文件)**:

```bash
# 列出全部失效会话(dry-run,不改动):
node <skill>/scripts/fix-model-refs.mjs --list
# 批量切换到目标模型(先 --dry-run 看请求,再执行;默认只切失效的,--all 强制全切):
node <skill>/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-v4-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt --dry-run
node <skill>/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-v4-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt
```

cookie 获取:`curl -c /tmp/dshcookies.txt -o /dev/null "http://127.0.0.1:3080/?token=<TOKEN>"`。
目标模型必须真实存在于 settings.yaml;**能切 `deepseek-official` 就切它**(内置集固定,不易再漂);
第三方 provider 只选声明过的 id。切换是合法审计事件(`model/selection`),后续打开会话即生效。
完整复盘(含本机 16+1 会话真实案例、批量脚本等价物、验证命令)见 `references/model-fix.md`。

### 3. 配置死干预行(warning)

`cordis.patch.yml` 顶层 disabled 行对应的 id 已不在装配树(dump-config 报 `entry "xxx" not found`)→ 该行永远不生效,纯噪音。删除即可;profile 级 patch 改动需重启生效。

### 4. 第三方插件未适配(按体检建议)

- 有兼容层的(mnemon 0.5.2、dsh-im 4.9.1 等):已是"探测新 API 后回退"写法,视为适配完成,不用动
- 裸引用的(agent-teams 0.1.15):**保持 disabled 等上游适配**,不要自己改 node_modules(升级即丢)
- 想现在就用的:改 `session.events` → `snapshotEvents()`,`registerContinuableSetup` 等 subagent API 等作者更新

## 验证(双闸门,收尾必跑)

```bash
# 会话日志完整性(修复版:支持 range-pairs + 0.1.2 事件类型全集)
node <skill>/scripts/verify-session.mjs --all
# 配置装配(T1 树/T2 mcp schema/T3 握手;--diff-default 另查 clobber/dead-patch)
node <skill>/scripts/verify-patch.mjs --profile web
node <skill>/scripts/verify-patch.mjs --profile web --diff-default
```

两个都 ALL PASS 才算修完。verify-session 若报第三方事件类型未知,用 `--ignore-type t1,t2`;`--lenient-unknown` 降为 warn。

## 已知坑(遇到别误诊)

- **`Cannot read properties of undefined (reading 'some')` + 报错紧跟 `turn/start`** → 就是 preset 的 `session.events`,不是日志损坏
- **selectModel/打开旧会话报 `resume failed ... preset "xxx" not found`** → 会话引用的 preset 目录已被删,按内置 standard 重建同名桩(见 fix-patterns.md 模式 6),桩不能事后删;此问题会挡住模型引用修复
- **verify-session S10 报 `refs=19,638` 这种成对值** → 是工具不认识 range-pairs(`[[19,638]]`),不是会话坏了;本技能内置的 verify-session.mjs 是修复版
- **S8 报 `model/selection` 未知** → 0.1.2 新事件类型,旧快照缺;同样用内置版
- **子代理会话(402 个)打开报 `agent-busy`** → 设计行为:子代理会话需要父会话地址(`kind:"subagent"` + parentSessionId/childSessionId),不是 bug,不用修
- **`apiProxy` 服务被移除** → 迁移为 `typertGateway`(Remote 网关);dsh-im 4.9.1 已适配,再旧版本要升级
- **PTC 模式默认不暴露 `workflow` 工具**(改用 `run_code`;`tool-ralph` 还在)——功能变化非故障
- **官方 `web` 默认行键集变了**(加了 `fetchProvider`,公网 WebFetch 默认启用)——覆写该行时要抄全,否则触发 clobber 闸门
- **旧会话的 `sourceEventSeqs` 两种合法形态**:旧数组 `[15,16]` 与新 range-pairs `[[19,638]]`,都是合法的

## 其他设备快速复制

1. 拷贝本技能目录到目标机(用 DSH 自带技能安装方式,或手动放 `~/.dsh/skills/dsh-upgrade-fix-012/`)
2. 跑 `node scripts/scan-upgrade.mjs` → 按输出修(模型引用用 `scripts/fix-model-refs.mjs`)
3. 修完跑双闸门 → ALL PASS → 重启 dsh web → 打开一个旧会话抽查
4. 自定义 preset 的 API 修复是持久化的(文件级);若目标机有 dsh-operations 技能组,把本技能 scripts 下的 verify-session/verify-patch 同步回它的 scripts/ 覆盖旧版(源:`dsh-operations/scripts/`,与本技能内版本一致)

## 资料索引

- `references/breaking-changes.md` — 0.1.2-rc.1 全部破坏性变更 + 每项的影响面与判定方法(发版说明逐条核对版)
- `references/fix-patterns.md` — 每种问题的修复代码示例、验证命令、常见陷阱
- `references/model-fix.md` — UNKNOWN_MODEL 完整复盘:真实案例(模型 id 改名漂移)、单会话试通到批量切换、验证命令
