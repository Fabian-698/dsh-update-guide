---
name: dsh-update-guide
description: 指导并修复 DeepSeek Harness (dsh) 从 0.1.2 升级到 0.1.5+——升级流程（备份→切 tag/快进→pnpm install/build→dshmarket 重启）与升级后故障：旧会话打不开/报错、session.events/snapshotEvents 崩溃、UNKNOWN_MODEL、session.v3.jsonl.zstd 与 V3 格式、v0 会话迁移被拒（resume failed / refuses this format v0 Session）、ctx.agent 移除与插件不兼容(含 0.1.5 服务 inject 缺失导致启动即崩)、verify-session S8/S12 判定、配置死干预。任何设备刚升级 dsh 或问「怎么升级 dsh / 升级后旧会话打不开 / UNKNOWN_MODEL」时，先跑一键体检 scan-upgrade.mjs（版本感知），按本指南修复后用双闸门 verify-session + verify-patch 确认归零；纯日志分析走 dsh-session-logs，纯配置装配走 dsh-config-assembly，普通依赖更新（pnpm update 等）不适用。English — how to upgrade dsh from 0.1.2 to 0.1.5, can't open sessions after upgrading dsh, session resume failed, UNKNOWN_MODEL, session.events, snapshotEvents, V3 session format, ctx.agent, plugin incompatible, dsh upgrade health scan.
license: MIT
metadata:
  repository: https://github.com/Fabian-698/dsh-update-guide
  dsh-version-range: "0.1.2-rc.1 .. 0.1.5-rc.1"
  node: ">=18"
---

# dsh 更新与升级修复指南(0.1.2 → 0.1.5+)

> 本技能原名 `dsh-upgrade-fix-012`,现名 **`dsh-update-guide`**;覆盖 **0.1.2-rc.1 → 0.1.5-rc.1** 两代破坏性变更与升级后的断链修复。
> 仓库:https://github.com/Fabian-698/dsh-update-guide (安装、多平台发现、版本与依赖矩阵见仓库 README)。
> REQUIRED BACKGROUND:`../dsh-foundations/SKILL.md`(dsh 心智模型与安全红线);相关技能:`../dsh-run/SKILL.md`、`../dsh-session-logs/SKILL.md`、`../dsh-config-assembly/SKILL.md`。
> 0.1.2 代细节见 `references/breaking-changes-0.1.2.md`;0.1.5 代(含 V3 会话格式)见 `references/breaking-changes-0.1.5.md`。

## 版本与依赖(先核对,再动手)

| 项 | 约束 | 核对方式 |
|---|---|---|
| dsh | **0.1.2-rc.1 → 0.1.5-rc.1**(含端点);区间外只做人工判定,`scan-upgrade.mjs` 会先打印检测版本并按版本选检查集 | `dsh --version` |
| 升级链路 | 0.1.2-rc.1 → 0.1.3-alpha.1 → 0.1.3-alpha.2 → 0.1.5-alpha.1 → 0.1.5-alpha.2 → 0.1.5-rc.1(GitHub 上**无 0.1.4、无 0.1.5-rc.2**) | `git fetch --tags && git tag -l 'dsh-v0.1.*'` |
| Node | ≥ 18;全部脚本为 Node ESM,**只用 `node:` 内建模块,无第三方依赖** | `node -v` |
| 本技能 | 自足:体检/修复/boot 测试/自测/闸门都在本目录内;闸门副本在 `scripts/gates/` | `node scripts/selftest.mjs`、`node scripts/sync-gates.mjs --check` |
| 兄弟技能(推荐同装) | `dsh-foundations`(必读背景)、`dsh-session-logs`(verify-session owner)、`dsh-config-assembly`(verify-patch / verify-patch-surface owner)、`dsh-run`(启动与 dshmarket 重启);装在同一技能树目录下 | 与 `~/.dsh/skills/` 同级;缺失只影响 owner 解析,本技能仍可独立跑通(走 `scripts/gates/`) |
| 会话格式 | v0/v2 = `session.jsonl.zstd`;v3 = `session.v3.jsonl.zstd`(header `"version":3`);**V3 不可降级读取**,回退旧版前必须备份 | `node scripts/verify-session.mjs --all`(S12) |
| 破坏性写操作的前提 | 第 0 步 `repair-v0-sessions.mjs --apply` 要求 `sessions.bak-*` 中存在目标会话同相对路径的备份 | `node scripts/repair-v0-sessions.mjs --list` |

## 这个技能解决什么

dsh 的 **0.1.2-rc.1** 与 **0.1.5-rc.1** 各有一批不兼容改动(0.1.5-rc.1 的官方 Release Notes 本身就是自
0.1.2-rc.1 以来的累计汇总,1486 个提交)。**升级本身通常是成功的——坏的是"依赖旧 API 的东西"**:

- 自定义 agent preset 用旧 `session.events` → 旧会话恢复即崩(`undefined.some()`)(0.1.2 代)
- 第三方插件未适配 → 启用失败或运行时抛错(0.1.2 的 subagent API、0.1.5 的 `ctx.agent`/Inbox)
- 会话仍引用失效模型 id → `UNKNOWN_MODEL`(两代都发生;0.1.5 新默认模型 `deepseek-flash`)
- 会话日志升到 **V3**(`session.v3.jsonl.zstd`,header `"version":3`),旧读取器读不到/读旧文件 → 误判
- 自家校验工具没跟上新格式 → **误报**未知事件类型(0.1.2 的 S8/S10,0.1.5 的 S8);**S12 FAIL 不是误报**——v3 文件名与 header version 不一致是真问题(仅"旧文件名 + version=3"为 WARN)
- 旧 v0 会话被 0.1.5 迁移器的**冻结校验**拒绝 → 打开即 `resume failed`(插件消息 summary、descriptor v2、平铺 replayState;见第 0 步)

核心原则:**先体检定位 → 逐项修复 → 双闸门验证**。不要凭症状猜——同一症状(打不开会话)可能来自
preset 断链、模型失效、v0 迁移拒绝、V3 迁移、session 锁、子代理会话六种完全不同的原因,体检脚本按版本分流。

## 升级前必做

1. **备份会话日志**(V3 不支持降级读取,回退旧版 dsh 前必须有备份。备份失败必须当场发现,不能让 `|| true` 吞掉;
   `cp -R` 到已存在目录会嵌套成 `sessions.bak-.../sessions/`,所以用带时分秒的唯一名字):
   ```bash
   bak=~/.dsh/sessions.bak-$(date +%Y%m%d-%H%M%S)
   test ! -e "$bak" && cp -R ~/.dsh/sessions "$bak" && du -sh "$bak"
   ```
2. 确认版本与区间:`dsh --version`;0.1.2-rc.1 → 0.1.3-alpha.1 → 0.1.3-alpha.2 →
   0.1.5-alpha.1 → 0.1.5-alpha.2 → 0.1.5-rc.1(GitHub 上**无 0.1.4、无 0.1.5-rc.2**)。
3. **不要 kill/重启正在运行的 GUI**;配置热刷新只覆盖 home 级 patch,profile 级 cordis.patch.yml
   改动须重启才生效——重启走 dshmarket(先 `GET /dsh-market/status` 确认无锁,再
   `POST /dsh-market/restart` 带同源 Origin/Referer),不要裸 kill。
4. 升级/迁移期间**不要手改会话日志、不要重命名或删除迁移产物**(v2 原文件 + v3 后继都保留)。
5. 升级代码树时按官方步骤:先 `cp -R` 备份代码树,再 `git stash push -u` → `git fetch origin && git pull --ff-only`
   (或 checkout tag `dsh-v0.1.5-rc.1`) → `pnpm install && pnpm build && pnpm build:web`;升完记得 `git stash pop`。

## 升级流程(0.1.2 → 0.1.5+)

完整步骤见 `references/breaking-changes-0.1.5.md` 第 6 节,升级后逐项自检见第 7 节。最小路径:
1. 备份会话与代码树(见上)。
2. `git fetch --tags` → `git checkout dsh-v0.1.5-rc.1`(或 `git pull --ff-only` / `git stash pop`)。
3. `pnpm install && pnpm build && pnpm build:web`。
4. `node <skill>/scripts/scan-upgrade.mjs` 体检 → 按本页修复顺序处理(先第 0 步迁移,再模型/配置/插件)。
5. 双闸门 ALL PASS 后经 dshmarket 重启 dsh web,打开一个旧会话抽查。

## 一键体检(第一件事)

```bash
node <skill>/scripts/scan-upgrade.mjs [--dsh-home ~/.dsh] [--profile web] [--json]
```

- **版本感知**:按当前版本选择 **0.1.2 检查集 + 0.1.5 检查集**;不会再"未达 0.1.2 直接跳过剩余项"。
- 检查 7+ 类:版本核对、旧 API 残留(`session.events`/`header.seedLength`/`header-delta`/
  `reason:"fallback"`)、**0.1.5 新断链模式(`ctx.agent`、Inbox、conversation Slot、Detail 面板、
  `connection.rpc.handle` 缺 `webServer` inject)**、第三方插件断链、配置死干预、失效模型引用、未知事件类型、
  V3 迁移概览、**v0 会话可迁移性(`migration` 项,检查项 7)**。
  脚本落盘分类为 `version / source / config / model / events / v3 / migration` 七类。
- **静态模式有盲区**:只在插件 apply 时触发的断链(如 inject 缺失)扫描未必命中,而失效插件会让整棵插件树
  加载失败 → **启用任何第三方插件前先跑 `test-plugin-boot.mjs` 隔离启动测试**(见第 4 节)。
- **统计 V3 迁移进度**:列出 v2(`session.jsonl.zstd`)与 v3(`session.v3.jsonl.zstd`)会话数量,
  v3 为后继、v2 原文件保留。
- `--profile` 默认 `web`;`--json` 便于喂给后续步骤。
- 退出码 **0 = 无 blocker,1 = 有 blocker**。先跑一次看基线;修完必须重跑确认归零。

## 修复顺序

按体检输出的 blocker → warning 顺序处理。每类的详细定位/代码/验证见 `references/fix-patterns.md`。
**先修第 0 步**(它会让会话无法打开,也会挡住第 2 步的模型修复)。

### 0. v0 会话迁移被拒(打开即 `resume failed`)

0.1.5 的 v0→v1 迁移器是冻结校验,三种旧版本写入的历史形态会让会话**打开即失败**
(`resume failed ... SessionQueryError ... refuses this format v0 Session`):
- **A** 插件消息 `source` 带 `summary` 但 `form != notice`(旧版 dsh-mnemon;报 `summary requires notice form`)
- **B** `subagent/descriptor` 的 `version: 2`(字段与当前 v3 相同,仅版本号旧;报 `unsupported descriptor version 2`)
- **C** `assistant/chunk` finish 的 v1 平铺 `replayState`(顶层有 `kind`;当前格式是 `{ response, blocks }`;报 `unexpected member "kind"`)

体检 `migration` 项为 blocker 时:

```bash
node <skill>/scripts/repair-v0-sessions.mjs --list   # 先看涉及哪些会话与每类命中数(不改文件)
node <skill>/scripts/repair-v0-sessions.mjs --apply   # 要求已有 sessions.bak-*;离线全链校验,失败不落盘
```

- 只处理**没有 v3 后继**的 v0 会话(含子代理会话);只做三类最小规范化,不改事件语义;逐文件原子替换,不删原文件。
- `--apply` 的备份门禁要求 `sessions.bak-*` 中存在**目标会话的同相对路径备份**(空目录/无关文件不算);`--list` 文本模式会逐条列出可修复会话与三类命中数。
- 违规行若在最后一个 `turn/end` 之后(未提交尾部),打开时会被**静默丢弃**而不是拒绝——scan 报 warning,
  同一工具可保留这些尾部记录。
- 修完重跑 scan:无 `migration` blocker 后再做第 2 步;否则 `selectModel` 会先 `resume failed`。

### 1. preset/插件 `session.events` 与 0.1.5 新 API(最常崩)

**0.1.2 代**:`Session.events` 属性移除。全量遍历用 `session.snapshotEvents()`,按 seq 取单条用
`session.eventAt(seq)`。模式:先探测新 API 再回退旧引用 = 兼容层(已适配,不要动);只有无探测的
裸引用才是断链。

**0.1.5 代**还要逐项核对插件/preset:
- `ctx.agent` **已移除** → 调用方显式传递 Agent(fix-patterns 模式 8)
- `Inbox` 变**类型接口**,不再导出可构造类;通过 `agent.inbox` 读写,`hasPending`/`claim` 非公共接口(模式 9)
- 原 `conversation` Slot → `main` 的 `conversation` key;全局面板走 `sidebar.panellist` 与 `main`(模式 10)
- **Detail 面板已移除** → 能力迁到右侧 Sidebar(文件/产物用 Sidebar 预览,`deliverables/presented` 事件)
- 自定义 persona 拆成 **prefix / suffix**(模式 11)
- `minimal`/`sdk-minimal` 默认只有持久 shell,`str_replace_editor` 需显式启用(模式 12)
- 普通 subprocess handle **不再有 `pid`**(终端 handle 不受影响,模式 13)

改完对每个文件跑 `node --check`。preset 目录在 `~/.dsh/.agent-presets/<name>/`。
**preset 由进程启动时加载,改完必须重启 dsh web 才生效**(走 dshmarket)。若会话引用的 preset 已删除,
先按 fix-patterns 模式 6 建同名桩,否则会挡住第 2 步。

### 2. 失效模型引用(blocker)

会话"当前生效"的 provider/model 不在合法目录 → `UNKNOWN_MODEL`。判定:
取最后一个 `model/selection`(没有则最后一个 `request/header`);子代理会话跳过(继承父会话模型)。

**0.1.5 合法目录 = 内置 deepseek-official 集 ∪ settings.yaml `llm-deepseek.models` ∪
`llm-pi-ai.providers.<name>.models[*].id`**。0.1.5 内置集:**`deepseek-flash`(新默认)**、
`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`。

```bash
# 列出全部失效会话(dry-run,不改动):
node <skill>/scripts/fix-model-refs.mjs --list
# 批量切换(先 --dry-run 看请求,再执行;默认只切失效的,--all 强制全切):
node <skill>/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt --dry-run
node <skill>/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt
```

cookie 获取:`curl -c /tmp/dshcookies.txt -o /dev/null "http://127.0.0.1:3080/?token=<TOKEN>"`;该 cookie 等同完整 API 凭据——
`chmod 600 /tmp/dshcookies.txt`,修复完 `rm -f /tmp/dshcookies.txt`。
目标模型必须真实存在于并集内;能切 `deepseek-official` 就切它(内置集固定,不易再漂)。

**0.1.5 副作用提醒**:selectModel 成功后**会同时写全局默认模型**(内部走 agentDefaultModel.saveSelection,脚本会打印该提醒)——
批量前想清楚全局默认要停在哪;不想动全局就在执行后改回。完整复盘(含六个误报案例、批量脚本等价物、
验证命令)见 `references/model-fix.md`。
退出码:0 = 成功或无需修复,1 = 仍有失效未修(`--list` 发现失效时也返回 1),2 = 目标不在声明集或取不到 cookie。

### 3. 配置死干预行(warning)

`cordis.patch.yml` 顶层 disabled 行对应的 id 已不在装配树(dump-config 报 `"entry xxx not found"`)
→ 该行永远不生效,纯噪音。删除即可;profile 级 patch 改动需重启生效。
0.1.5 仍要**抄全 web 默认行的键集**(含 0.1.2 起就有的 `fetchProvider`),否则触发 config-clobber。

### 4. 第三方插件未适配(启用前必做 boot 测试)

**固定步骤:启用任何第三方插件前,先在隔离 DSH_HOME 里启动一次**——静态扫描覆盖不到只在插件 apply 时触发的
断链,而失效插件会让**整棵插件树**加载失败(dsh web 直接起不来):

```bash
node <skill>/scripts/test-plugin-boot.mjs          # 全量启用 → 失败项自动隔离 → 重试到启动成功
node <skill>/scripts/test-plugin-boot.mjs --json   # 机器可读;--keep 保留临时 home 与日志排查
```

脚本只读真实 `~/.dsh`(复制 profile 并软链 node_modules;settings/credentials 复制进 0700 临时目录,结束即删),
用临时 home 跑 `dsh web --port 0 --no-open`,看到 URL 后再等 15s 让晚失败的 entry 暴露;退出码 **0 = 全部可启用,
1 = 有不兼容项(已列清单),2 = 环境不满足**。本机 2026-09-10 实测:静态体检全绿,该脚本一轮抓到 mcp-manager 启动崩溃。

**0.1.5 新失败类:服务访问必须 inject**。`ctx.connection.rpc.handle(...)` 在调用方 fiber 上注册路由并取
`webServer` 服务;插件 `inject` 缺 `"webServer"` → 启动报 `cannot get property "webServer" without inject`。
已知 `@js2hou/dsh-mcp-manager` 0.1.5 命中(上游 issue #6 未修;本机实测仅补 inject 仍失败)→ 保持 disabled,
详见 `references/fix-patterns.md` 模式 4。

其余规则:
- 有兼容层的(mnemon 0.5.6/0.5.7、dsh-im 4.18.1 等):已是"探测新 API 后回退"写法,视为适配完成,不用动。
- 裸引用的(agent-teams 0.1.15 等):**保持 disabled 等上游适配**,不要自己改 node_modules(升级即丢)。
- 0.1.5 起实验性 **Agent Teams 包可从 npm 安装,但需显式添加 profile,不默认启用**;启用前先确认已适配
  `ctx.agent`/Inbox/Slot 三项变化。
- 想现在就用的:把插件目录复制到 `~/.dsh/plugins/<name>/` 本地维护再改,升级不丢(改完同样先跑 boot 测试)。

### 5. V3 会话格式与子代理会话(0.1.5 必读)

- 存储位置:`~/.dsh/sessions/<workspace>/<sessionId>/`。
- 旧格式文件 `session.jsonl.zstd`(header `"version":0`);0.1.5 V3 文件
  `session.v3.jsonl.zstd`(header `"version":3`)。
- **新会话是 V3-only**(没有 v2 兄弟文件);旧会话迁移后 **v2 原文件保留、v3 为后继**;V3 **不可降级读取**。
- `session.lock` 是 0.1.5 的 session 锁:同一 session 至多被一个进程持有;打开报 `agent-busy`/
  锁冲突先确认持有者,不要手工删锁文件。
- **子代理会话 header 特征**:`origin:"subagent"` 或 `kind:"subagent"` 或 `delegationDepth>0` 或
  存在 `parentSession`;顶层会话 `delegationDepth:0`。子代理打开报 `agent-busy` 是设计行为
  (需要父会话地址),不用修;scan/fix 都会跳过它们。
- 自定义读取器要**优先 v3、按 header version 分流**,不要重命名/回写迁移产物(见 fix-patterns 模式 7)。

## 验证:双闸门(收尾必跑)

```bash
# 会话日志完整性(owner 规范版;含 S12 V3 一致性检查)
node <skill>/scripts/verify-session.mjs --all
# 配置装配(T1 树/T2 mcp schema/T3 握手;--diff-default 另查 clobber/dead-patch)
node <skill>/scripts/verify-patch.mjs --profile web
node <skill>/scripts/verify-patch.mjs --profile web --diff-default
```

- **闸门 owner**:`verify-session.mjs` 规范版在 `dsh-session-logs/scripts/`;
  `verify-patch.mjs`(与 `verify-patch-surface.mjs`)规范版在 `dsh-config-assembly/scripts/`。
- **本技能 scripts/ 下这两个文件是解析到 owner 的 shim**:命令形态不变
  (`node <本技能>/scripts/verify-session.mjs --all` 仍可用),逻辑永远跟随 owner 更新,
  不要在本技能里手改这两个文件。
- verify-session 现有 8 项检查 **S1/S2/S6/S8-S12**(S3/S4/S5/S7 为历史保留编号):新增 **S12** 校验 `session.v3.jsonl.zstd` 文件名与 header
  `"version":3` 一致;**KNOWN_TYPES 已含 0.1.5 新类型**(system/message、tool/ptc-dispatch*、
  assistant/attempt、deliverables/presented、feedback/message-*、subagent/catalog、team/message/*)。
- 第三方扩展事件类型用 `--ignore-type t1,t2`;`--lenient-unknown` 降为 warn。
- **两个都 ALL PASS 才算修完;有 FAIL 禁止重启**(带损坏日志重启可能让 session 列表整体 500,先修再启)。
  若环境受限导致 dump-config 报 EROFS,按脚本提示在用户终端或更高权限下重跑。
- 改动本技能的脚本/事件表/闸门后,先跑确定性自测,再跑双闸门(自测覆盖 A 语法/B 事件表一致/C 内置模型 id/D 闸门解析/E fixtures 回归/F V3 优先/H S1 判定/I migration 判定/J 严格 inject 判定;`--full` 追加真实体检):
  ```bash
  node <skill>/scripts/selftest.mjs          # 快速档(不扫描真实会话)
  node <skill>/scripts/selftest.mjs --full   # 追加真实 scan-upgrade --json(要求无 blocker 且未被版本门控跳过)
  ```

## 回滚(升级出问题时)

1. 记录现场:`dsh --version`、`git rev-parse HEAD`/当前 tag,以及本次修复动过的文件。
2. 停 GUI:**走 dshmarket**(先 `GET /dsh-market/status` 确认无锁,再 `POST /dsh-market/restart`),不要裸 kill、不要删 `session.lock`。
3. 代码树回退:checkout 上一个 tag/commit → `pnpm install && pnpm build && pnpm build:web`。
4. 会话恢复:确认 GUI 已停后,用升级前的 `sessions.bak-*` 覆盖 `~/.dsh/sessions`;覆盖前先把当前树另存一份——回滚期间产生的 V3-only 新会话在旧版 dsh 不可读。
5. 回滚后不要手工改 v2/v3 日志;再次升级时从第 0 步重新体检。

## 已知坑(遇到别误诊)

**0.1.2 旧坑(仍适用)**:
- `Cannot read properties of undefined (reading 'some')` + 报错紧跟 `turn/start` → 就是 preset 的
  `session.events`,不是日志损坏。
- `resume failed ... preset "xxx" not found` → 会话引用的 preset 目录已被删,按内置 standard 重建同名桩
  (fix-patterns 模式 6),**桩不能事后删**;此问题会挡住模型引用修复。
- verify-session **S10** 报 `refs=19,638` 这种成对值 → 工具不认识 range-pairs(`[[19,638]]`),
  不是会话坏了;用本技能 shim(解析到 owner 最新版)。
- **S8** 报 `model/selection` 等未知 → 0.1.2 新事件类型,旧快照缺;同样用 shim/owner 版。
- **PTC 模式默认不暴露 `workflow` 工具**(改用 `run_code`;`tool-ralph` 还在)——功能变化非故障。
- 官方 `web` 默认行键集变了(含 `fetchProvider`)——覆写该行时要抄全,否则触发 clobber 闸门。
- `apiProxy` 服务被移除 → 迁移为 `typertGateway`;旧版 dsh-im/dsh-browser 需升级。
- 旧会话 `sourceEventSeqs` 两种合法形态:旧数组 `[15,16]` 与新 range-pairs `[[19,638]]`。

**0.1.5 新坑**:
- **v3 命名**:后继文件是 `session.v3.jsonl.zstd` 且 header `"version":3`;只认 `session.jsonl.zstd`
  的旧读卡器会"看不见"新会话或误读旧 v2 —— verify-session **S12** 专门查这个。
- **V3-only 新会话**:0.1.5 新建会话没有 v2 兄弟文件;v3 不能给旧版 dsh 读,回退前必须备份。
- **session.lock**:锁是生命周期行为,不是损坏;不要手工删锁,先确认持有者退出。
- **code → ptc 命名延续**:`tool/code-dispatch` 与 0.1.5 的 `tool/ptc-dispatch*` 并存(旧日志仍可读);
  旧校验快照会误报 S8。
- **默认工具/minimal**:持久 shell only,`str_replace_editor` 需显式启用(模式 12)。
- `ctx.agent`、Inbox、`conversation` Slot、persona prefix/suffix、subprocess pid 的修复见
  `references/breaking-changes-0.1.5.md` 与 fix-patterns 模式 8-13。
- **打开即 `resume failed` + `refuses this format v0 Session`**:这是格式迁移层拒绝,不是日志损坏
  (verify-session 仍会 ALL PASS);三类形态与修复见第 0 步与 fix-patterns 模式 15。
- 子代理会话 `agent-busy` = 设计行为;需要父会话地址,不是 bug。

## 其他设备快速复制

1. **首选技能 family 一起装**:`dsh-foundations`、`dsh-session-logs`、`dsh-config-assembly`、
   `dsh-run` 与本技能同装 —— 闸门 owner 与依赖解析都在,shim 直接可用。
2. 只带本技能时:**先在仍装有技能族的机器上**执行 `node <skill>/scripts/sync-gates.mjs --embed`(把 owner 版闸门复制到本技能 `scripts/gates/`),
   **然后整体复制本技能目录(含 `scripts/gates/`)**到目标机。目标机上 `scan-upgrade` / `fix-model-refs` / `repair-v0-sessions` 可完整使用;
   selftest 的 E/F/H 会因 owner 缺失而 FAIL/SKIP,属预期。目标机流程:scan → `repair-v0-sessions.mjs --list/--apply`(迁移 blocker)→ `fix-model-refs.mjs`(模型)。
   `--check` 用于校验内置副本与 owner 是否漂移。
3. 修完跑双闸门 → ALL PASS → 重启 dsh web → 打开一个旧会话抽查(V3 会话优先)。
4. 本技能脚本风格:Node ESM、只允许 `node:` 内建模块、无第三方依赖;注释/报错信息用中文;
   改动保持最小且聚焦。除第 0 步的 `repair-v0-sessions.mjs`(要求 `sessions.bak-*` 备份 + 全链校验 + 原子替换)外,禁止改 `~/.dsh/sessions` 下的任何文件。

## 资料索引

- `references/breaking-changes-0.1.2.md` — 0.1.2-rc.1 全部破坏性变更 + 每项的影响面与判定方法(逐条核对版)
- `references/breaking-changes-0.1.5.md` — 0.1.2 → 0.1.5 合并破坏性变更,每条给"变更 → 影响面 → 判定方法 → 修复"并映射本技能工具
- `references/fix-patterns.md` — 0.1.2 模式 1-6 + 0.1.5 模式 7-15(V3 读取器、ctx.agent、Inbox、面板 Slot、persona、minimal、subprocess pid、session 锁、v0 迁移被拒)
- `references/model-fix.md` — UNKNOWN_MODEL 完整复盘(0.1.5 版):合法目录并集、六个误报案例、selectModel 写全局默认的副作用、v3 优先
- `scripts/repair-v0-sessions.mjs` — 修复无法迁移到 V3 的 v0 会话(三类已知拒绝形态):`--list` / `--apply`(需 `sessions.bak-*` 备份);离线跑完整迁移链校验后才原子替换
- `scripts/test-plugin-boot.mjs` — 启用第三方插件前的隔离启动测试:复制 profile 到临时 DSH_HOME,全量启用并逐轮隔离失败插件,输出不兼容清单与首个错误行;退出码 0=全可启用/1=有不兼容/2=环境不满足
- `scripts/selftest.mjs` — 确定性自测(A 语法、B 事件表一致、C 内置模型 id、D 闸门解析、E V2/V3 fixtures 回归、F 目录优先 V3、H S1 活跃 turn 判定、I migration 判定、J 严格 inject 判定);`--full` 追加真实体检
- `scripts/sync-gates.mjs` — 闸门副本同步与漂移校验(`--list` / `--embed` / `--check`);`--embed` 用于本技能独立复制到别的机器
- 闸门 owner:`../dsh-session-logs/SKILL.md`(verify-session)、`../dsh-config-assembly/SKILL.md`(verify-patch / verify-patch-surface)
- 相关技能:`../dsh-foundations/SKILL.md`(必读背景)、`../dsh-run/SKILL.md`、`../dsh-session-logs/SKILL.md`、`../dsh-config-assembly/SKILL.md`
- `evals/` — 触发与任务评测集(`evals.json` + `trigger-eval.json`),可用 skill-creator 的 eval-viewer 复核
