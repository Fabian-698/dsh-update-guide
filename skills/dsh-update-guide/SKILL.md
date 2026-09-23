---
name: dsh-update-guide
description: 指导并修复 DeepSeek Harness (dsh) 升级(0.1.2-rc.1 → 0.1.7-rc.1)与升级后断链:备份→切 tag→pnpm install/build→dshmarket 重启;故障定位与修复。典型症状:旧会话打不开、Unknown agent preset(0.1.7 起 ~/.dsh/.agent-presets/ 不再被读取,预设须声明 preset-* 行)、UNKNOWN_MODEL(0.1.6-alpha.2 起内置 deepseek-official 只剩 deepseek-flash/deepseek-v4-pro)、session.events/snapshotEvents 崩溃、Session V4(session.v4.jsonl.zstd, header version:4)与 V3 格式、v0 迁移被拒(refuses this format v0 Session)、ctx.agent 移除与插件不兼容(含 0.1.5 inject 缺失致启动即崩)、workflow-worker-thread→workflow-ptc、Team spawn_teammate、maxInlineBytes→maxInlineTokens、verify-session S8/S12、配置死干预。刚升级 dsh 或问「怎么升级 dsh / 升级后旧会话打不开 / UNKNOWN_MODEL / 预设失效」时,先跑一键体检 scan-upgrade.mjs(版本感知),修完用双闸门 verify-session + verify-patch 确认归零。纯日志分析走 dsh-session-logs,纯配置装配走 dsh-config-assembly,普通依赖更新不适用。English — upgrade dsh, sessions won't open after upgrade, resume failed, Unknown agent preset, UNKNOWN_MODEL, V3/V4 session format, session.v4.jsonl.zstd, ctx.agent, plugin incompatible.
license: MIT
metadata:
  repository: https://github.com/Fabian-698/dsh-update-guide
  dsh-version-range: "0.1.2-rc.1 .. 0.1.7-rc.1"
  node: ">=22.15"
---

# dsh 更新与升级修复指南(0.1.2 → 0.1.7-rc.1)

> 本技能原名 `dsh-upgrade-fix-012`,现名 **`dsh-update-guide`**;覆盖 **0.1.2-rc.1 → 0.1.7-rc.1** 三代破坏性变更与升级后的断链修复。
> 仓库:https://github.com/Fabian-698/dsh-update-guide (安装、多平台发现、版本与依赖矩阵见仓库 README)。
> REQUIRED BACKGROUND:`../dsh-foundations/SKILL.md`(dsh 心智模型与安全红线);相关技能:`../dsh-run/SKILL.md`、`../dsh-session-logs/SKILL.md`、`../dsh-config-assembly/SKILL.md`。
> 0.1.2 代细节见 `references/breaking-changes-0.1.2.md`;0.1.5 代(含 V3 会话格式)见 `references/breaking-changes-0.1.5.md`;
> **0.1.5-rc.1 → 0.1.7-rc.1**(V4 会话、声明式 preset、settings 单次导入、PTC/workflow 改名、内置模型缩减)见 `references/breaking-changes-0.1.7.md`。

## 版本与依赖(先核对,再动手)

| 项 | 约束 | 核对方式 |
|---|---|---|
| dsh | **0.1.2-rc.1 → 0.1.7-rc.1**(含端点);区间外只做人工判定,`scan-upgrade.mjs` 会先打印检测版本并按版本分段选检查集(0.1.5 / 0.1.6 / 0.1.7) | `dsh --version` |
| 升级链路 | 0.1.2-rc.1 → 0.1.3-alpha.1 → 0.1.3-alpha.2 → 0.1.5-alpha.1 → 0.1.5-alpha.2 → 0.1.5-rc.1 → **0.1.5-rc.2 → 0.1.5-rc.3 → 0.1.6-alpha.1 → 0.1.6-alpha.2 → 0.1.7-alpha.1 → 0.1.7-alpha.2 → 0.1.7-rc.1**(GitHub 上无 0.1.4;0.1.5-rc.3 仅 tag 无 release note) | `git fetch --tags && git tag -l 'dsh-v0.1.*'` |
| Node | **≥ 22.15**;`selftest.mjs` / `repair-v0-sessions.mjs` 用 `node:zlib` 的 `zstdCompressSync`(22.15 / 23.8 起提供),其余脚本为 Node ESM、只用 `node:` 内建、无第三方 npm 依赖 | `node -v` |
| zstd CLI | **必需**:会话日志是 zstd 容器,`scan-upgrade` / `verify-session` / `fix-model-refs` / `repair-v0-sessions` 都靠它解压(缺失时相关检查降级为 warning / SKIP,不会假绿) | `zstd --version` |
| 本技能 | 自足:体检/修复/boot 测试/自测/闸门都在本目录内;闸门副本在 `scripts/gates/` | `node scripts/selftest.mjs`、`node scripts/sync-gates.mjs --check` |
| 兄弟技能(推荐同装) | `dsh-foundations`(必读背景)、`dsh-session-logs`(verify-session owner)、`dsh-config-assembly`(verify-patch / verify-patch-surface owner)、`dsh-run`(启动与 dshmarket 重启);装在同一技能树目录下 | 与 `~/.dsh/skills/` 同级;缺失只影响 owner 解析,本技能仍可独立跑通(走 `scripts/gates/`) |
| 会话格式 | 旧格式(脚本里记作 v2,逻辑 header `"version":0`)= `session.jsonl.zstd`;v3 = `session.v3.jsonl.zstd`(header `"version":3`);**0.1.7 V4 = `session.v4.jsonl.zstd`(header `"version":4`)**;权威文件按 **V4 > V3 > V2** 选;V3/V4 都不可降级读取,回退旧版前必须备份 | `node scripts/verify-session.mjs --all`(S12;owner 需 V4-aware) |
| 破坏性写操作的前提 | 第 0 步 `repair-v0-sessions.mjs --apply` 要求 `sessions.bak-*` 中存在目标会话同相对路径的备份 | `node scripts/repair-v0-sessions.mjs --list` |
| 声明式 preset | 0.1.7 起 `~/.dsh/.agent-presets/` **不再被读取**;会话引用的 preset 必须在装配树声明为 `preset-*` 行(`dsh --dump-config` 可见) | `node scripts/scan-upgrade.mjs`(category=preset) |
| 配置来源 | 0.1.7 起 `settings.yaml` 只导入一次并改名 `settings.yaml.imported`;模型/插件配置看 Profile `cordis.patch.yml` 或 dump-config | `ls ~/.dsh/settings.yaml*`;scan 的 model 分类会打印"声明来源" |

## 这个技能解决什么

dsh 的 **0.1.2-rc.1** 与 **0.1.5-rc.1** 各有一批不兼容改动(0.1.5-rc.1 的官方 Release Notes 本身就是自
0.1.2-rc.1 以来的累计汇总,1486 个提交)。**升级本身通常是成功的——坏的是"依赖旧 API 的东西"**:

- 自定义 agent preset 用旧 `session.events` → 旧会话恢复即崩(`undefined.some()`)(0.1.2 代)
- 第三方插件未适配 → 启用失败或运行时抛错(0.1.2 的 subagent API、0.1.5 的 `ctx.agent`/Inbox)
- 会话仍引用失效模型 id → `UNKNOWN_MODEL`(两代都发生;0.1.5 新默认模型 `deepseek-flash`)
- 会话日志升到 **V3**(`session.v3.jsonl.zstd`,header `"version":3`),旧读取器读不到/读旧文件 → 误判
- 自家校验工具没跟上新格式 → **误报**未知事件类型(0.1.2 的 S8/S10,0.1.5 的 S8);**S12 FAIL 不是误报**——v3 文件名与 header version 不一致是真问题(仅"旧文件名 + version=3"为 WARN)
- 旧 v0 会话被 0.1.5 迁移器的**冻结校验**拒绝 → 打开即 `resume failed`(插件消息 summary、descriptor v2、平铺 replayState;见第 0 步)
- **0.1.7 起会话 header 引用的 preset 不在装配树** → 打开即 `Unknown agent preset`(0.1.7 不再读 `~/.dsh/.agent-presets/`;见第 0.5 步,本机 137 个顶层会话里 73 个命中)
- **0.1.7 起会话升到 V4**、模型声明来源改到 Profile patch、内置模型集缩减 → 旧读取器/校验器"看不见新格式、读空配置、把已移除模型当合法"(见第 2 步与第 5 步)

核心原则:**先体检定位 → 逐项修复 → 双闸门验证**。不要凭症状猜——同一症状(打不开会话)可能来自
preset 断链、模型失效、v0 迁移拒绝、V3 迁移、session 锁、子代理会话六种完全不同的原因,体检脚本按版本分流。

## 升级前必做

1. **备份会话日志**(V3 不支持降级读取,回退旧版 dsh 前必须有备份。备份失败必须当场发现,不能让 `|| true` 吞掉;
   `cp -R` 到已存在目录会嵌套成 `sessions.bak-.../sessions/`,所以用带时分秒的唯一名字):
   ```bash
   bak=~/.dsh/sessions.bak-$(date +%Y%m%d-%H%M%S)
   test ! -e "$bak" && cp -R ~/.dsh/sessions "$bak" && du -sh "$bak"
   ```
2. 确认版本与区间:`dsh --version`;0.1.2-rc.1 → … → 0.1.5-rc.1 → 0.1.5-rc.2 → 0.1.5-rc.3 →
   0.1.6-alpha.1 → 0.1.6-alpha.2 → 0.1.7-alpha.1 → 0.1.7-alpha.2 → 0.1.7-rc.1(GitHub 上无 0.1.4;0.1.5-rc.3 仅 tag)。
3. **不要 kill/重启正在运行的 GUI**;配置热刷新只覆盖 home 级 patch,profile 级 cordis.patch.yml
   改动须重启才生效——重启走 dshmarket(先 `GET /dsh-market/status` 确认无锁,再
   `POST /dsh-market/restart` 带同源 Origin/Referer),不要裸 kill。
4. 升级/迁移期间**不要手改会话日志、不要重命名或删除迁移产物**(v2 原文件 + v3 后继都保留)。
5. 升级代码树时按官方步骤:先 `cp -R` 备份代码树,再 `git stash push -u` → `git fetch origin && git pull --ff-only`
   (或 checkout tag `dsh-v0.1.5-rc.1`) → `pnpm install && pnpm build && pnpm build:web`;升完记得 `git stash pop`。

## 升级流程(0.1.2 → 0.1.7-rc.1)

完整步骤见 `references/breaking-changes-0.1.7.md` 第 7 节(本区间)与 `breaking-changes-0.1.5.md` 第 6 节,升级后逐项自检见各自清单。最小路径:
1. 备份会话与代码树(见上)。
2. `git fetch --tags` → `git checkout dsh-v0.1.7-rc.1`(或 `git pull --ff-only` / `git stash pop`)。
3. `pnpm install && pnpm build && pnpm build:web`。
4. `node <skill>/scripts/scan-upgrade.mjs` 体检 → 按本页修复顺序处理(先第 0 步迁移 + 第 0.5 步 preset,再模型/配置/插件)。
5. 双闸门 ALL PASS 后经 dshmarket 重启 dsh web,打开一个旧会话(V4 优先)抽查。

## 一键体检(第一件事)

```bash
node <skill>/scripts/scan-upgrade.mjs [--dsh-home ~/.dsh] [--profile web] [--json]
```

- **版本感知**:按当前版本分段选择检查集(基础 / 0.1.5 / 0.1.6 / 0.1.7);不会再"未达 0.1.2 直接跳过剩余项"。
- 检查 9+ 类:版本核对、旧 API 残留(`session.events`/`header.seedLength`/`header-delta`/
  `reason:"fallback"`)、**0.1.5 新断链模式(`ctx.agent`、Inbox、conversation Slot、Detail 面板、
  `connection.rpc.handle` 缺 `webServer` inject)**、**0.1.6 断链(`workflow-worker-thread`→`workflow-ptc`、
  `agent/session-start`→`agent/created`、`subagent_fork`→`spawn_teammate`、`maxInlineBytes`→`maxInlineTokens`)**、
  第三方插件断链、配置死干预、失效模型引用、未知事件类型、**V4/V3/v2 迁移概览**、
  **v0 会话可迁移性(`migration` 项)**、**预设声明核对(`preset` 项)**、**旧预设目录残留(`legacy-presets` 项)**。
  脚本落盘分类为 `version / source / config / model / events / v3 / migration / preset / legacy-presets` 九类。
- **`preset` 是 0.1.7 的 P0**:报"会话引用的 agent preset 未在装配树声明: <id>(顶层 N / 子代理 M)"时,
  按第 0.5 步声明 `preset-*` 行——这是旧会话打不开的头号原因。
- **`model` 会打印"声明来源"**:应为 Profile `cordis.patch.yml`(∪ dump-config),不是已改名的 `settings.yaml`。
- **静态模式有盲区**:只在插件 apply 时触发的断链(如 inject 缺失)扫描未必命中,而失效插件会让整棵插件树
  加载失败 → **启用任何第三方插件前先跑 `test-plugin-boot.mjs` 隔离启动测试**(见第 4 节)。
- **统计格式迁移进度**:列出 V4(`session.v4.jsonl.zstd`)/ V3(`session.v3.jsonl.zstd`)/ 仅 v2 的会话数量与后继关系。
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

### 0.5 preset 未在装配树声明(0.1.7 起打开即 `Unknown agent preset`)★本区间 P0

**0.1.7-alpha.1 起 `~/.dsh/.agent-presets/<id>/` 不再被任何代码读取**(官方原文 "Nothing reads that directory any more."),
预设必须声明成装配树里的 `preset-*` 行或做成 plugin bundle。症状:打开旧会话报
`RemoteError('agent-preset/not-found', 'Unknown agent preset: <id>')`——与 0.1.2 的"preset 目录被删"同症状、不同根因,
**按第 1 步建同名桩已无效**。

体检 `preset` 项为 blocker 时会给出 preset 名与受影响顶层会话数;确认已声明集合:

```bash
dsh --profile web --dump-config | grep -A3 '^- id: preset-' | grep -E '^- id:|^    id:'   # config.id 集合
node <skill>/scripts/scan-upgrade.mjs    # preset(缺声明) + legacy-presets(旧目录残留) 两个分类
```

在 `profiles/web/cordis.patch.yml` 按模板声明,装配自检 + 隔离启动测试通过后**重启 dsh web 生效**:

```yaml
- insert:
    - id: preset-<id>
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: <id>                 # 必须等于会话 header.agentPreset
        order: 92
        plugins: [ ... ]          # 可直接复用当前 0.1.7 规范 preset 的插件列表
```

完整模板、旧 `agent.cordis.yml` 的必改点(旧 `persona.config.text`、`workflow-worker-thread`→`workflow-ptc`、ralph 默认关)
与验证命令见 `references/breaking-changes-0.1.7.md` 第 2 节与 `references/fix-patterns.md` 模式 16。
等 `legacy-presets` 只剩 info(无会话引用未声明 preset)后再删旧目录。

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

改完对每个文件跑 `node --check`。旧 preset 目录在 `~/.dsh/.agent-presets/<name>/`(0.1.7 起**不再被读取**,见第 0.5 步)。
**preset 由进程启动时加载,改完必须重启 dsh web 才生效**(走 dshmarket)。0.1.7 前若会话引用的 preset 已删除,
按 fix-patterns 模式 6 建同名桩;0.1.7 起改用模式 16 在装配树声明,否则会挡住第 2 步。

### 2. 失效模型引用(blocker)

会话"当前生效"的 provider/model 不在合法目录 → `UNKNOWN_MODEL`。判定:
取最后一个 `model/selection`(没有则最后一个 `request/header`);子代理会话跳过(继承父会话模型)。

**合法目录 = 当前版本内置 deepseek-official 集 ∪ `llm-deepseek.models` ∪
`llm-pi-ai.providers.<name>.models[*].id`**,声明来源优先 **Profile `cordis.patch.yml`**
(0.1.7 起 settings.yaml 只导入一次并改名 `settings.yaml.imported`),其次 `dsh --dump-config`。
**内置集随版本变化**:0.1.5 为 4 个(`deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`);
**0.1.6-alpha.2 起只剩 `deepseek-flash` + `deepseek-v4-pro`**(另两个已移除且无别名)。沿用旧 4-id 判定会把引用它们的旧会话**漏报**——
本机 0.1.7 实测 87 个顶层会话命中(`deepseek-v4-flash`×73、`-vision-exp`×14)。

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

**副作用提醒(0.1.5 起)**:selectModel 成功后**会同时写全局默认模型**(内部走 agentDefaultModel.saveSelection,脚本会打印该提醒)——
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

### 5. 会话格式(V4/V3)与子代理会话(0.1.7 必读)

- 存储位置:`~/.dsh/sessions/<workspace>/<sessionId>/`。
- 旧格式文件 `session.jsonl.zstd`(header `"version":0`);0.1.5 V3 = `session.v3.jsonl.zstd`(header `"version":3`);
  **0.1.7 V4 = `session.v4.jsonl.zstd`(header `"version":4`)**。
- **新会话是当前代-only**(没有旧兄弟文件);旧会话迁移后 **旧原文件保留、新代文件为后继**;**V3/V4 都不可降级读取**。
- 读取端按 **V4 > V3 > V2** 选权威文件,再按 header `version` 分流(见 fix-patterns 模式 7)。
- `session.lock` 是 0.1.5 的 session 锁:同一 session 至多被一个进程持有;打开报 `agent-busy`/
  锁冲突先确认持有者,不要手工删锁文件。
- **子代理会话 header 特征**:`origin:"subagent"` 或 `kind:"subagent"` 或 `delegationDepth>0` 或
  存在 `parentSession`;顶层会话 `delegationDepth:0`。子代理打开报 `agent-busy` 是设计行为
  (需要父会话地址),不用修;scan/fix 都会跳过它们。
- 自定义读取器要**按 V4 > V3 > V2 选权威文件、再按 header version 分流**,不要重命名/回写迁移产物(见 fix-patterns 模式 7)。

## 验证:双闸门(收尾必跑)

```bash
# 会话日志完整性(owner 规范版;含 S12 V3/V4 一致性检查)
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
- verify-session 现有 8 项检查 **S1/S2/S6/S8-S12**(S3/S4/S5/S7 为历史保留编号):**S12** 校验 `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd`
  文件名与 header `"version":3` / `"version":4` 一致;**KNOWN_TYPES 需含 0.1.5-0.1.7 新类型**(system/message、tool/ptc-dispatch*、
  assistant/attempt、deliverables/presented、feedback/message-*、subagent/catalog、team/message/*、workspace/changes、image/offload、developer/message)。
- **owner 必须 V4-aware**:只认 `session.v3.jsonl.zstd` 的旧版闸门会**完全看不见 V4 会话**并照样报 ALL PASS(假绿);
  用 `node scripts/verify-session.mjs --all` 时应能在计数/概览里看到 `session.v4.jsonl.zstd`。
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
4. 会话恢复:确认 GUI 已停后,用升级前的 `sessions.bak-*` 覆盖 `~/.dsh/sessions`;覆盖前先把当前树另存一份——回滚期间产生的 V4-only 新会话(0.1.5 时代为 V3-only)在旧版 dsh 不可读。
5. 回滚后不要手工改 v2/v3/v4 日志;再次升级时从第 0 步重新体检。

## 已知坑(遇到别误诊)

**0.1.2 旧坑(仍适用)**:
- `Cannot read properties of undefined (reading 'some')` + 报错紧跟 `turn/start` → 就是 preset 的
  `session.events`,不是日志损坏。
- `resume failed ... preset "xxx" not found` → 会话引用的 preset 目录已被删,按内置 standard 重建同名桩
  (fix-patterns 模式 6),**桩不能事后删**;此问题会挡住模型引用修复。
- verify-session **S10** 报 `refs=19,638` 这种成对值 → 工具不认识 range-pairs(`[[19,638]]`),
  不是会话坏了;用本技能 shim(解析到 owner 最新版)。
- **S8** 报 `model/selection` 等未知 → 0.1.2 新事件类型,旧快照缺;同样用 shim/owner 版。
- **PTC 模式默认不暴露 `workflow` 工具**(改用 `run_code`;0.1.7 起 `tool-ralph` 默认关闭,需显式启用)——功能变化非故障。
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

**0.1.6 / 0.1.7 新坑**:
- **`Unknown agent preset: <id>`**(打开即失败):0.1.7 起 `~/.dsh/.agent-presets/` 不再被读取,建桩无效;必须声明 `preset-*` 行(第 0.5 步)。
- **模型成片"失效"**:多半是校验器读了已改名的 `settings.yaml`(空文件)。合法目录要看 Profile patch / dump-config。
- **内置模型缩减**:0.1.6-alpha.2 起 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 已移除;旧校验器会把引用它们的会话**漏报**(本机 87 个)。
- **V4 假绿**:只找 `session.v3.jsonl.zstd` / `session.jsonl.zstd` 的读取器完全看不见 `session.v4.jsonl.zstd`;闸门口径必须 V4-aware。
- **`snapshotEvents`/`eventAt`/`ownEvents` 已弃用**(0.1.6-alpha.1 起,0.1.7 仍可运行):新代码建议迁移到异步事件 API。
- **`workflow-worker-thread`→`workflow-ptc`**、**`agent/session-start`→`agent/created`**、**Team 用 `spawn_teammate`**、
  **`maxInlineBytes`→`maxInlineTokens`**、**默认关 Ralph、移除 E2B**:见 `references/breaking-changes-0.1.7.md`。
- **插件安装/启动新增 DSH 版本兼容性检查**(0.1.7-rc.1):第三方插件声明不匹配会被拒,先升级插件。

## 其他设备快速复制

1. **首选技能 family 一起装**:`dsh-foundations`、`dsh-session-logs`、`dsh-config-assembly`、
   `dsh-run` 与本技能同装 —— 闸门 owner 与依赖解析都在,shim 直接可用。
2. 只带本技能时:**先在仍装有技能族的机器上**执行 `node <skill>/scripts/sync-gates.mjs --embed`(把 owner 版闸门复制到本技能 `scripts/gates/`),
   **然后整体复制本技能目录(含 `scripts/gates/`)**到目标机。目标机上 `scan-upgrade` / `fix-model-refs` / `repair-v0-sessions` 可完整使用;
   selftest 的 E/F/H 会因 owner 缺失而 FAIL/SKIP,属预期(K/L 用合成 home + 假 dsh,不依赖 owner)。目标机流程:scan → `repair-v0-sessions.mjs --list/--apply`(迁移 blocker)→ `fix-model-refs.mjs`(模型)。
   `--check` 用于校验内置副本与 owner 是否漂移。
3. 修完跑双闸门 → ALL PASS → 重启 dsh web → 打开一个旧会话抽查(V4 会话优先)。
4. 本技能脚本风格:Node ESM、只允许 `node:` 内建模块、无第三方依赖;注释/报错信息用中文;
   改动保持最小且聚焦。除第 0 步的 `repair-v0-sessions.mjs`(要求 `sessions.bak-*` 备份 + 全链校验 + 原子替换)外,禁止改 `~/.dsh/sessions` 下的任何文件。

## 资料索引

- `references/breaking-changes-0.1.2.md` — 0.1.2-rc.1 全部破坏性变更 + 每项的影响面与判定方法(逐条核对版)
- `references/breaking-changes-0.1.5.md` — 0.1.2 → 0.1.5 合并破坏性变更,每条给"变更 → 影响面 → 判定方法 → 修复"并映射本技能工具
- `references/breaking-changes-0.1.7.md` — 0.1.5-rc.1 → 0.1.7-rc.1 破坏性变更(tag 矩阵、Session V4、声明式 preset、settings 单次导入、PTC/workflow 改名、内置模型缩减、Agent/Remote API 变更)+ 升级步骤与自检清单
- `references/fix-patterns.md` — 0.1.2 模式 1-6 + 0.1.5 模式 7-15(V3 读取器、ctx.agent、Inbox、面板 Slot、persona、minimal、subprocess pid、session 锁、v0 迁移被拒)+ **0.1.7 模式 16-17(声明式 preset、settings 单次导入)**
- `references/model-fix.md` — UNKNOWN_MODEL 完整复盘(0.1.5 → 0.1.7 版):合法目录并集与 0.1.7 声明来源、七个误报案例(含内置集缩减导致的漏报)、selectModel 写全局默认的副作用、V4 > V3 > V2
- `scripts/repair-v0-sessions.mjs` — 修复无法迁移到 V3 的 v0 会话(三类已知拒绝形态):`--list` / `--apply`(需 `sessions.bak-*` 备份);离线跑完整迁移链校验后才原子替换
- `scripts/test-plugin-boot.mjs` — 启用第三方插件前的隔离启动测试:复制 profile 到临时 DSH_HOME,全量启用并逐轮隔离失败插件,输出不兼容清单与首个错误行;退出码 0=全可启用/1=有不兼容/2=环境不满足
- `scripts/selftest.mjs` — 确定性自测(A 语法、B 事件表一致、C 内置模型 id、D 闸门解析、E V2/V3 fixtures 回归、F 目录优先 V3、H S1 活跃 turn 判定、I migration 判定、J 严格 inject 判定、**K V4/preset 核对、L 模型目录回退**);`--full` 追加真实体检与"本机 0 blocker"断言
- `scripts/sync-gates.mjs` — 闸门副本同步与漂移校验(`--list` / `--embed` / `--check`);`--embed` 用于本技能独立复制到别的机器
- 闸门 owner:`../dsh-session-logs/SKILL.md`(verify-session)、`../dsh-config-assembly/SKILL.md`(verify-patch / verify-patch-surface)
- 相关技能:`../dsh-foundations/SKILL.md`(必读背景)、`../dsh-run/SKILL.md`、`../dsh-session-logs/SKILL.md`、`../dsh-config-assembly/SKILL.md`
- `evals/` — 触发与任务评测集(`evals.json` + `trigger-eval.json`),可用 skill-creator 的 eval-viewer 复核
