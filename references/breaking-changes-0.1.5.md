# dsh 0.1.5-rc.1 破坏性变更(0.1.2 → 0.1.5 合并版)

来源:官方 0.1.5-rc.1 Release Notes(自 v0.1.2-rc.1 以来的累计汇总,1486 commits / 改动 300 文件)
      + 本机 0.1.5-rc.1 实测(2026-09-10)。
版本区间:0.1.2-rc.1 → 0.1.3-alpha.1 → 0.1.3-alpha.2 → 0.1.5-alpha.1 → 0.1.5-alpha.2 → 0.1.5-rc.1
(GitHub 上无 0.1.4、无 0.1.5-rc.2)。旧代变更见同目录 breaking-changes-0.1.2.md。
每条列:变更 → 影响面 → 判定方法 → 修复,并标注本技能哪个工具能定位/修/验证。
★★=阻断级(不修会崩或会话打不开);★=重要;○=留意即可。

## 1. 会话格式与生命周期

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★★1 | **会话日志格式升至 V3**:文件 `session.v3.jsonl.zstd`,header `{"type":"session","version":3,...}`;旧日志自动迁移生成 v3 后继并**保留 v2 原文件**;升级后的会话**不支持降级读取** | 自定义日志读取器、校验/统计工具、备份策略;回退旧版 dsh 前必须有备份 | `ls <会话目录>` 看是否存在 session.v3.jsonl.zstd;zstd -dc 后首行 version 是 0(v2)还是 3(V3);scan-upgrade 会统计 v2/v3 迁移进度;verify-session S12 校验文件名与 header version 一致 | 读取端优先 v3、按 header `version` 分流(见 fix-patterns.md 模式 7);升级前 `cp -R ~/.dsh/sessions ~/.dsh/sessions.bak-$(date +%Y%m%d)`;不要手工重命名/删除迁移产物 |
| ★★2 | **Session 生命周期变更**:persistence API 改为生命周期持有的 `SessionHandle`;`agentLoop.create()` 变**异步**;新增 **session 锁**,同一 session 至多被一个进程持有(目录里可见 `session.lock`) | 直接调持久化 API 的插件、自动化脚本、并发打开同一会话的流程 | 代码 grep `agentLoop.create(` 是否漏 await;打开会话报 `agent-busy`/锁冲突时 `ls <会话目录>` 看 session.lock,并用 `ps` 确认有无其它 dsh 进程持有 | 调用点补 await;改走 SessionHandle 暴露的生命周期 API;不要并发打开同一会话,**不要手工删 session.lock**;确认持有者退出后重试 |
| ★★3 | **默认工具调整**:SDK/Headless/ACP 默认用 `read`/`write`/`edit` 编辑文件;Web `minimal` 与 Python `sdk-minimal` 默认**仅提供持久 shell**,`str_replace_editor` 需**显式启用**;持久 Bash 输出统一报告退出或超时状态 | minimal/sdk-minimal 会话里模型没有文件编辑工具;按旧行为写的自动化脚本 | 请求 header 里的工具清单(解压日志后 grep request/header);`dsh --profile <p> --dump-config` | 显式启用 str_replace_editor,或换用默认带 read/write/edit 的 preset;见 fix-patterns.md 模式 12;verify-patch T1 复核装配 |

### 1.1 v0→v1 迁移器"冻结校验":三种打开即失败的历史形态(2026-09-10 本机实测)

0.1.5 的 v0→v1 迁移器(包 `@deepseek-ai/dsh-session-format-v0-to-v1`)是**冻结校验**:只接受 v0 规范内的形态,
旧版本写入的以下三种历史形态会被直接拒绝,会话**打开即失败**(不生成 v3 后继,source v0 原文件保持不变)。
典型报错:`resume failed ... SessionQueryError: ... @deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session: <下表之一>; source v0 artifact remains unchanged`。
本机 676 个"仅 v2(v0 格式)"会话里 117 个本来可迁移、559 个被拒(429 含 A、380 含 B、186 含 C,有重叠),
三类都由 `repair-v0-sessions.mjs` 规范化后全部修复成功。

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★★A | **插件消息 source 带 `summary` 但 `form != "notice"`**(旧版 dsh-mnemon 注入的 instructions/recall 消息);报错 `user/message N source summary requires notice form` | 装过旧版注入类插件(dsh-mnemon 等)的历史会话 | scan-upgrade 检查项 7(category=migration)报 blocker;或离线解压后查带 summary 的 source 行 | `repair-v0-sessions.mjs --list` 预览 → 有 `sessions.bak-*` 备份后 `--apply`;见 fix-patterns.md 模式 15 |
| ★★B | **`subagent/descriptor` 的 `data.version === 2`**(字段与当前 v3 完全相同,只是版本号旧);报错 `subagent/descriptor N uses unsupported descriptor version 2` | 含子代理派发记录的历史会话(顶层会话同样被拒) | 同上;或解压后定位 `"type":"subagent/descriptor"` 行看 `"version":2` | 同上 |
| ★★C | **`assistant/chunk` 的 finish chunk 用 v1 平铺 `replayState`**(顶层有 `kind`;当前格式是 `{ response, blocks }`);报错 `assistant/chunk N chunk replayState has unexpected member "kind"` | 旧版本写入 replayState 的 finish chunk | 同上;或解压后定位 `assistant/chunk` 行看 `replayState` 是否平铺 | 同上 |

**尾部"可丢弃"记录**:违规行若出现在最后一个 `turn/end` **之后**(未提交尾部),recoverable 解码会
**静默丢弃该行**而不是拒绝——会话本就能打开,只丢该行的 replay/描述元数据。scan 把这种情况报成
`migration` **warning**(不是 blocker);想保留这些尾部记录同样跑 repair 工具。

## 2. 插件 API

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★★4 | **移除 `ctx.agent`**:插件 Agent API 调整,调用方需**显式传递 Agent**;同时修正可继续对话子代理的归属(不再被当根会话参与定时调度) | 所有用 `ctx.agent` 取当前 agent 的 preset/插件 | scan-upgrade 0.1.5 检查集命中 ctx.agent;grep `ctx\.agent`(排除 node_modules) | 由调用点把 Agent 作为参数显式传入,见 fix-patterns.md 模式 8;node --check + 插件启用日志 |
| ★★5 | **Inbox API 调整**:`Inbox` 改为**类型接口**,不再导出可构造的运行时类;`hasPending` 与 `claim` 不再属于公共接口;插件通过 `agent.inbox` 读写待处理消息 | 构造 Inbox 实例或调 hasPending/claim 的插件 | scan-upgrade 0.1.5 检查集命中 Inbox 用法;grep `new Inbox`、`hasPending`、`claim` | 改用 `agent.inbox`;等待/认领语义对照当前包内 Inbox 类型定义重写,见 fix-patterns.md 模式 9 |
| ★6 | **自定义 persona 配置拆分为 prefix / suffix**,旧配置及相关常量需适配 | 配置了自定义 persona 的 profile/patch | grep settings.yaml / cordis.patch.yml 里的 persona 配置;scan-upgrade 0.1.5 检查集 | 按 prefix/suffix 两字段拆分旧值,见 fix-patterns.md 模式 11;dump-config + verify-patch |
| ★★7 | **Web 插件面板 API 调整**:插件可通过 `sidebar.panellist` 与 `main` 注册全局面板;原 `conversation` Slot 迁移为 `main` 的 `conversation` key;**Detail 面板已移除**,能力迁至右侧 Sidebar(多标签/分栏/全屏,Markdown、代码、HTML、PDF、图片预览,含子代理与未激活会话的文件) | 注册 conversation Slot 或依赖 Detail 面板的 client 插件/自定义 UI | scan-upgrade 0.1.5 检查集命中 conversation Slot / Detail;grep 插件 client 源码的 slot 注册与 Detail | 全局面板改注册到 `sidebar.panellist` 与 `main`;会话面板用 `main.conversation`;Detail 交互迁 Sidebar,见 fix-patterns.md 模式 10 |

## 3. 模型 / Provider

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★★8 | **新会话默认模型变为 `deepseek-flash`**(DeepSeek-V41-Flash,支持文本/图片/会话历史中的系统提示词更新);配置文件显式指定模型时以配置值为准 | 旧校验脚本的内置集没有这个 id → 新会话被误报 UNKNOWN_MODEL;批量切模型时目标选错 | scan-upgrade 的 model 分类;fix-model-refs.mjs --list | 合法性用**并集**判定:内置 deepseek-official 集 ∪ settings.yaml `llm-deepseek.models` ∪ `llm-pi-ai.providers.<name>.models[*].id`;内置集 4 个 id 为 deepseek-flash / deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp;见 model-fix.md |
| ★9 | **selectModel 成功后同时写全局默认模型**(0.1.5 起,内部 `agentDefaultModel.saveSelection`) | 批量修复旧会话会把全局默认模型一起改掉 | fix-model-refs.mjs 执行时会打印该提醒 | 执行前想清楚全局默认要停在哪;若只想修会话不想动全局,执行后到设置面板/配置里把默认模型改回期望值 |
| ○10 | pi-ai 升至 0.85.1;模型探测支持自定义 provider 的 models 对象与 Anthropic 原生列表,回填名称/上下文窗口/最大输出 token;失效目录只影响单项并提供诊断入口 | 旧 provider 目录漂移仍会导致 UNKNOWN_MODEL | 同 #8 | 修会话引用,不要为旧名恢复声明(会复现漂移);详见 model-fix.md |

## 4. 工具、子进程与事件类型

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★11 | **普通 subprocess handle 不再暴露 `pid`**(终端 handle 不受影响);改善 Windows/部分 Linux 的普通子进程清理 | 用 pid 判活/杀进程的插件 | grep 插件源码 `.pid`;运行报 undefined/not a function | 改用 handle 的等待/终止 API;确需 pid 的场景改用 terminal handle,见 fix-patterns.md 模式 13 |
| ★12 | **PTC 命名延续 code → ptc**:0.1.5 事件类型含 `tool/ptc-dispatch`/`tool/ptc-dispatch-start`(旧日志里 `tool/code-dispatch*` 仍可读) | 只影响校验工具的事件类型快照 | verify-session S8 报 tool/ptc-dispatch* = 快照旧 | 用本技能 shim(解析到 owner 最新版)复核;第三方类型用 --ignore-type/--lenient-unknown |
| ★13 | **新增事件类型**:system/message、tool/ptc-dispatch*、assistant/attempt、deliverables/presented、feedback/message-*、subagent/catalog、team/message/* 等 | 旧 KNOWN_TYPES 快照会误报 S8 | verify-session S8 | owner 版 verify-session 已补齐;scan-upgrade 的未知类型统计同步 |
| ★14 | **`FS_NOT_OBSERVED` 统一诊断**:未观察文件写入/编辑失败保留文件路径、结构化错误码和原始原因 | 按错误字符串匹配旧报错的插件/脚本 | 看错误对象里的 code 字段 | 改判 `FS_NOT_OBSERVED` + 结构化字段,不要匹配整段文案 |

## 5. Agent Teams 与 UI / 平台(留意)

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★15 | 实验性 **Agent Teams 包可从 npm 安装,但需显式添加 profile,不默认启用** | 期望升级后自动出现团队能力,或旧 profile 里残留引用 | 检查 profile/patch 是否有显式 agent-teams 行;scan-upgrade 的插件分类 | 显式添加 profile 才启用;团队消息事件 team/message/* 已入 KNOWN_TYPES |
| ○16 | Web 右侧 Sidebar(含子代理/未激活会话文件预览、模型显式交付文件 deliverables/presented)、「在应用中打开」、反馈可独立提交、通用文件上传、长会话性能、代理环境变量(HTTP_PROXY 等)、Windows 修复等 | 体验变化,非故障 | — | 无需修复动作;文档/自动化按新 UI 路径更新 |
| ○17 | PTC 模式支持展开查看命令及输出;Skill 选择器模糊搜索;斜杠命令中文化;会话统计改两个可展开摘要 | 纯 UI/体验 | — | 无需动作 |

## 6. 升级步骤(0.1.2-rc.1 → 0.1.5-rc.1)

```bash
# 1) 先备份会话日志(V3 不支持降级读取;备份失败必须当场发现)
bak=~/.dsh/sessions.bak-$(date +%Y%m%d-%H%M%S)
test ! -e "$bak" && cp -R ~/.dsh/sessions "$bak" && du -sh "$bak"

# 2) 暂存本地改动(含未跟踪文件) → 快进到目标版本
git stash push -u -m "wip before 0.1.5-rc.1"
git fetch origin && git pull --ff-only origin master
# 或锁定 tag:git checkout dsh-v0.1.5-rc.1

# 3) 安装依赖并构建
pnpm install && pnpm build
pnpm build:web       # 若使用浏览器 GUI

# 4) 重启 dsh 服务后刷新界面(本 GUI 场景走 dshmarket restart,勿裸 kill)
#    http://127.0.0.1:3080
```

## 7. 迁移后自检清单(逐项对应上表)

- [ ] 会话历史能正常打开(V3 自动迁移,原文件保留)——#1
- [ ] 仅 v2 的旧会话不再被迁移器拒绝(scan 检查项 7 migration 无 blocker;被拒的用 repair-v0-sessions.mjs 修复)——#1.1 / fix-patterns 模式 15
- [ ] 自定义日志读取器/插件已适配 V3,优先读 session.v3.jsonl.zstd——#1、fix-patterns 模式 7
- [ ] 插件不再依赖 `ctx.agent`,改用显式传入的 Agent——#4
- [ ] 插件不再使用旧 `conversation` Slot,改用 `main.conversation`;Detail 交互迁 Sidebar——#7
- [ ] 若依赖 `str_replace_editor`,确认已显式启用——#3
- [ ] 自定义 persona 已按 prefix/suffix 拆分——#6
- [ ] 不再从普通 subprocess handle 读取 `pid`——#11
- [ ] 确认新会话默认模型 `deepseek-flash` 是否符合预期(或已在配置中固定模型),旧会话引用已用并集判定并修复——#8/#9
- [ ] verify-session --all 与 verify-patch --profile web 双闸门 ALL PASS(含 S12)——见 SKILL.md 验证章节

## 8. 官方来源

- 发布说明(本区间累计汇总):https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1
- 全量对比(1486 commits):https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.2-rc.1...dsh-v0.1.5-rc.1
- Session 格式迁移说明:仓库内 `packages/session/session-format-v2-to-v3/README.zh.md`
- v0→v1 迁移器(冻结校验)实现:包 `@deepseek-ai/dsh-session-format-v0-to-v1`;本机修复工具 `scripts/repair-v0-sessions.mjs`
- 相关技能:dsh-session-logs(闸门 owner)、dsh-config-assembly(闸门 owner)、dsh-run、dsh-foundations
