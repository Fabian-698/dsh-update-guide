# dsh 0.1.7-rc.1 破坏性变更(0.1.5-rc.1 → 0.1.7-rc.1)

来源:官方 0.1.5-rc.3...0.1.7-rc.1 变更与 release notes + 本机 0.1.7-rc.1 实测(2026-09-23)。
每条列:**变更 → 影响面 → 判定方法 → 修复**,并标注本技能哪个工具能定位/修/验证。
★★=阻断级(不修会崩 / 会话或配置打不开);★=重要;○=留意即可。
上一段区间见同目录 `breaking-changes-0.1.5.md`,`breaking-changes-0.1.2.md`。

## 0. 版本矩阵(这段区间发了 7 个 tag)

| tag | 性质 | 与升级相关的破坏面 |
|---|---|---|
| dsh-v0.1.5-rc.1 | 上一段区间终点 | V3 会话、ctx.agent/Inbox/Slot 等(见 0.1.5 篇) |
| dsh-v0.1.5-rc.2 | 体验优化 | 无破坏性变更 |
| dsh-v0.1.5-rc.3 | 仅 tag,无 release note | 无破坏性变更 |
| dsh-v0.1.6-alpha.1 | 大量破坏性变更 | PTC/workflow 改名、默认关 Ralph、移除内置 E2B、官方 DeepSeek 适配器收敛、Agent/Remote/Sandbox API 变更 |
| dsh-v0.1.6-alpha.2 | 插件依赖/预设架构变更 | **内置 deepseek-official 模型列表缩减**(见 #6) |
| dsh-v0.1.7-alpha.1 | V4 会话格式 + settings/预设迁移 | **Session V4**、**preset 改由插件组合包声明**、**settings.yaml 只导入一次** |
| dsh-v0.1.7-alpha.2 | spill-policy 改名 | `maxInlineBytes` → `maxInlineTokens` |
| dsh-v0.1.7-rc.1 | 汇总 RC | 插件安装/启动新增 DSH 版本兼容性检查 |

`scan-upgrade.mjs` 的版本门控按上表分段:< 0.1.5-rc.1 只跑基础集;>= 0.1.5-rc.1 加 V3/v0/0.1.5 断链;
>= 0.1.6-alpha.1 加 0.1.6 断链;>= 0.1.6-alpha.2 切换内置模型集;>= 0.1.7-alpha.1 加 V4 / preset / 旧目录检查。

## 1. 会话格式:V3 → V4(0.1.7-alpha.1)

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★★1 | **会话日志升至 V4**:新文件 `session.v4.jsonl.zstd`,header `{"type":"session","version":4,...}`;**V4 不支持降级读取**;旧 v0/v2/v3 会话打开时**惰性迁移**成 v4 后继,旧原文件保留。V4 语义变化:工具结果里 user 角色消息提升为 `role:'tool'`(且 `content[0].toolCallId → message.toolCallId`);新增事件类型 `workspace/changes`、`image/offload`、`developer/message` | 自定义日志读取器、校验/统计脚本、备份与回滚策略;旧读取器"看不见"新会话 → 假绿 | `ls <会话目录>` 找 `session.v4.jsonl.zstd`;`zstd -dc <file> | head -1` 看 `"version":4`;scan-upgrade 的 `v3` 概览现在同时统计 V4/V3/v2;verify-session 需 V4-aware(见 task-4 / dsh-session-logs owner) | 读取端按 **V4 > V3 > V2** 选权威文件并按 header `version` 分流(fix-patterns.md 模式 7);升级前 `cp -R ~/.dsh/sessions ~/.dsh/sessions.bak-$(date +%Y%m%d-%H%M%S)`;不要手工重命名/删除迁移产物;回退旧版 dsh 前必须有备份 |
| ★2 | **子代理会话文件**:V4 会话没有 v2/v3 兄弟文件;同一会话目录可能出现 `session.jsonl.zstd`(原文件)+ `session.v3.jsonl.zstd`/`session.v4.jsonl.zstd`(后继) | 统计/校验脚本把"三代同名会话"重复计数,或误读旧原文件 | `ls` 看目录内文件组合;scan-upgrade 会分别报 `V4 会话 N(其中 M 保留 v2/v3 旧文件)` / `V3 会话 K(其中 J 保留 v2 原文件)` / `仅 v2 待惰性迁移 P` | 以最高版本后继为权威;旧原文件只作回滚备份,不参与"当前状态"判定 |

## 2. Agent preset 改由插件组合包声明(0.1.7-alpha.1)★★ 本区间最大坑

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★★3 | **`~/.dsh/.agent-presets/<id>/` 目录不再被任何代码读取**(官方原文 "Nothing reads that directory any more.")。预设必须在装配树里声明为 Loader 行:`- id: preset-<id>` + `name: '@deepseek-ai/dsh-agent-preset'` + `config: { id, order, plugins: [...] }`(或做成 plugin bundle 安装)。设置页也移除了"复制/删除/打开目录"入口 | 所有引用旧目录 preset 的历史会话**打开即失败**:`RemoteError('agent-preset/not-found', 'Unknown agent preset: <id>')`。本机实测 137 个顶层会话里 **73 个**命中(含子代理共 413 个);本目录修复 3 个兼容桩后仍有 6 个顶层会话引用 `liangshen` | scan-upgrade 的 `preset` 分类(blocker):报"会话引用的 agent preset 未在装配树声明: <id>(顶层 N / 子代理 M)";声明集来自 `dsh --profile <p> --dump-config` 的 `- id: preset-*` 行的 `config.id`,并内置 standard/ptc/minimal/cordis;另见 `legacy-presets` 分类(旧目录残留逐 id 计数) | 按下面模板在 `profiles/<p>/cordis.patch.yml` 声明仍需使用的 preset,重启 dsh web(走 dshmarket);确认无会话引用后再删旧目录。见 fix-patterns.md 模式 16 |

声明模板(插件列表可直接复用当前 0.1.7 的规范 preset,避免踩"包名已改名"的坑):

```yaml
# profiles/web/cordis.patch.yml 追加
- insert:
    - id: preset-<id>                     # Loader 行 id,约定 preset-<presetId>
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: <id>                           # 会话 header.agentPreset 引用的就是这个值
        order: 92
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a coding agent powered by the {{model}} model.
              suffix: Your working directory is {{cwd}}.
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config: { maxBytes: 65536 }
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
```

装配与验证(**不要**直接手改线上 profile 后就宣称成功):

```bash
# 1) 装配自检(不写配置): 必须出现 preset-<id> 行且退出码 0
cd ~/.dsh/profiles/web && dsh --profile web --dump-config --patch /path/to/presets.yml | grep '^- id: preset-'
# 2) 隔离启动测试(临时 DSH_HOME,复制 profile + 软链 node_modules)
node <skill>/scripts/test-plugin-boot.mjs        # 或 DSH_HOME=$TMP dsh web --port 0 --no-open
# 3) 体检: preset 分类无 blocker
node <skill>/scripts/scan-upgrade.mjs
```

常见必改点(旧 preset 迁移时):
- `persona` 的 `config.text` 已废弃(0.1.5 起 schema 是 `prefix` 必填 + `suffix` 默认 ""),照抄会 activation 失败。
- `@deepseek-ai/dsh-workflow-worker-thread` 已改名 `@deepseek-ai/dsh-workflow-ptc`(见 #4)。
- `dsh-tool-ralph` 在 0.1.7 默认关闭,需要就显式启用(见 #5)。

## 3. settings.yaml → Profile 插件配置,只导入一次(0.1.7-alpha.1)

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★★4 | **设置改由当前 Profile 的插件配置保存**;`~/.dsh/settings.yaml` **只尝试导入一次**,导入后改名为 `settings.yaml.imported`(本机 2026-09-19 已导入) | 仍在读 `$DSH_HOME/settings.yaml` 的脚本/校验器会读到"空配置" → 把本来合法的 provider/model 全判成失效(本机旧 scan 的 26 条模型报错里 21 条就是这个原因);手工改 settings.yaml 不再生效 | `ls ~/.dsh/settings.yaml*`;模型声明应改看 `profiles/<p>/cordis.patch.yml` 或 `dsh --profile <p> --dump-config` | 校验器改为:优先 `profiles/<p>/cordis.patch.yml`,再 `dsh --dump-config`(补 bundle 声明),最后才回退 `settings.yaml` / `settings.yaml.imported`;要改配置就改 Profile patch(需重启),不要改 `.imported` |

## 4. PTC / workflow 改名与执行模型(0.1.6-alpha.1)

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★5 | PTC 包名/服务名统一为 `ptc-runtime` 系列,旧名不再兼容;工作流执行器 `@deepseek-ai/dsh-workflow-worker-thread` → **`@deepseek-ai/dsh-workflow-ptc`** | 引用旧包名/旧服务名的 preset、插件、patch 行 | scan-upgrade `source` 分类命中 `workflow-worker-thread`(未同时出现 workflow-ptc 时);grep 配置与插件源码 | 更新包名与 Loader 行 `name`(config 字段不变);见 fix-patterns.md 模式 8 |
| ○6 | Node PTC 改独立进程执行,`process.env` 为空 | 在 PTC 里读环境变量的插件/脚本 | 运行时报环境变量 undefined | 不要把环境变量当隐式输入;显式传参或用 dsh 配置注入 |

## 5. 官方 DeepSeek 适配器与其他运行时变更(0.1.6-alpha.1 / 0.1.6-alpha.2)

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★7 | **官方 DeepSeek 适配器仅走 Messages API**:移除 Chat Completions 与 `protocol` 选项;手配旧官方根地址要改成 `https://api.deepseek.com/anthropic` | 手配 `llm-deepseek` 的基础地址/协议选项 | grep `llm-deepseek` 配置里的 `protocol` / `baseURL`;`dsh --profile <p> --dump-config` 看装配后的 config | 删除 `protocol`,baseURL 改为 Messages API 端点(本机 `llm-deepseek` 为空,无需处理) |
| ★★8 | **默认模型列表缩减**(0.1.6-alpha.2):内置 `deepseek-official` 只剩 **`deepseek-flash`** 与 **`deepseek-v4-pro`**;移除 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`(无别名映射) | 旧会话若把当前生效模型记为这两个 id → 继续对话报 `UNKNOWN_MODEL`。**本机实测 87 个顶层会话命中**(deepseek-v4-flash ×73、vision-exp ×14,均无 model/selection,当前生效模型取自最后一条 `request/header`)。旧的 0.1.5 版校验器把这两个 id 当合法,所以一直没报 | 校验器**按版本**切换内置集(0.1.6-alpha.2 起用 2 个 id);scan-upgrade 的 `model` 分类(blocker)会带每个 ref 的 ×N 计数;判"当前生效"= 最后一条 `model/selection`(若有),否则最后一条 `request/header` 的 `data.header.config`(与 dsh 的 `model-selection-projection` 一致) | 批量切换:`node <skill>/scripts/fix-model-refs.mjs --list` → `--provider <并集内的 provider> --model <该 provider 下的模型> [--dry-run]`(先用 `--list` 确认目标在并集内;能切内置 `deepseek-official` 就切它,自定义 provider 的声明会随 profile 漂移);0.1.5 起 selectModel 会同时写全局默认模型,先想清楚落点 |
| ★9 | **默认不再启用 Ralph**;`tool-ralph` 需显式启用 | 依赖 Ralph 的 preset/工作流 | dump-config 看 `tool-ralph` 行是否 disabled | 在 preset/patch 里显式插入并启用 |
| ○10 | **移除内置 E2B 执行后端** | 依赖 E2B sandbox 的插件/配置 | grep `e2b` | 改用其他 sandbox provider |

## 6. 插件/Agent/Remote API 变更(0.1.6-alpha.1)

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★11 | `agent/session-start` → **异步串行的 `agent/created`** | 订阅/触发 session 启动的插件 | scan-upgrade `source` 分类命中 `agent/session-start`(未同时出现 `agent/created`) | 改订阅 `agent/created` |
| ★12 | **弃用同步历史读取** `snapshotEvents` / `eventAt` / `ownEvents`(0.1.7-rc.1 仍可运行) | 用同步 API 遍历/取单条事件的插件 | scan-upgrade `source` 分类 info 提示;grep 三个词 | 迁移到异步事件 API;过渡期保留"探测新 API 再回退"的兼容层 |
| ★13 | `SandboxProvider.confine` / `ShellExecutor.start` 改为**可取消的异步接口**;Remote 工作区文件读取统一为 **`readBytes`** | 实现 sandbox/shell provider 或读远端文件的插件 | 调用点返回 Promise 但未 await;grep `readFile` 旧远程路径 | 调用点补 await / 支持取消信号;远程读取改 `readBytes` |
| ★14 | **Team 模式统一 `spawn_teammate`**,不再提供 `subagent` / `subagent_fork` | 用旧子代理 API 的插件/脚本(含 agent-teams 旧版) | scan-upgrade `source` 分类命中 `subagent_fork` | 改用 `spawn_teammate`;旧插件保持 disabled 等上游适配 |
| ★15 | 自定义 `spill-policy` 的 `maxInlineBytes` → **`maxInlineTokens`**(语义从字节数改为 token 数)(0.1.7-alpha.2) | 自定义 spill-policy 的配置 | scan-upgrade `source` 分类命中 `maxInlineBytes`;grep 配置 | 改配置键并复核阈值语义 |
| ○16 | **插件安装/启动新增 DSH 版本兼容性检查**(0.1.7-rc.1) | 声明了引擎/兼容范围的第三方插件 | 安装/启动日志的兼容性拒绝 | 升级插件到声明支持 0.1.7 的版本;不要绕过检查 |

## 7. 升级步骤(0.1.5-rc.1 → 0.1.7-rc.1)

```bash
# 0) 体检现阶段(只读): 先知道要修什么
node <skill>/scripts/scan-upgrade.mjs --json

# 1) 备份会话(V4 不可降级读取;备份失败必须当场发现)
bak=~/.dsh/sessions.bak-$(date +%Y%m%d-%H%M%S)
test ! -e "$bak" && cp -R ~/.dsh/sessions "$bak" && du -sh "$bak"

# 2) 备份代码树 → 快进/切 tag
git stash push -u -m "wip before 0.1.7-rc.1"
git fetch --tags && git checkout dsh-v0.1.7-rc.1
pnpm install && pnpm build && pnpm build:web   # 用浏览器 GUI 时

# 3) 重启 dsh web(走 dshmarket,勿裸 kill):
#    GET /dsh-market/status 确认无锁 → POST /dsh-market/restart(带同源 Origin/Referer)

# 4) 升级后逐项修复: preset(第 2 节)→ 模型(第 5 节 #8)→ 插件(第 6 节)
node <skill>/scripts/scan-upgrade.mjs          # 重跑确认归零
```

## 8. 迁移后自检清单

- [ ] `scan-upgrade.mjs` 版本行显示"检查集覆盖 0.1.2-rc.1 .. 0.1.7-rc.1",不再报"高于覆盖范围"——门控
- [ ] `preset` 分类无 blocker:所有被会话引用的 preset 都在 `dump-config` 的 `preset-*` 行里——#3
- [ ] `legacy-presets` 分类只剩 info(旧目录里的预设均已声明或已无引用),可以清理 `~/.dsh/.agent-presets/`——#3
- [ ] `model` 分类无 blocker:无会话引用已缩减的内置模型(deepseek-v4-flash / -vision-exp)或未声明的 provider/model——#8
- [ ] 模型声明来源是 Profile patch / dump-config,不是已改名的 settings.yaml——#4
- [ ] 自定义日志读取器按 **V4 > V3 > V2** 选文件并按 header `version` 分流,能看见 `session.v4.jsonl.zstd`——#1
- [ ] 事件类型快照含 `workspace/changes`、`image/offload`、`developer/message`——#1 / #12
- [ ] 插件不再用 `agent/session-start` / `snapshotEvents` / `subagent_fork` / `workflow-worker-thread` / `maxInlineBytes`——#5..#15
- [ ] 自定义 persona 已按 prefix/suffix 拆分,workflow 包名已改 `workflow-ptc`——#3 常见必改点
- [ ] 启用任何第三方插件前跑过隔离 boot 测试(`test-plugin-boot.mjs`)——见 0.1.5 篇 #18
- [ ] 双闸门 ALL PASS:`verify-session.mjs --all`(需 V4-aware)+`verify-patch.mjs --profile <p>`——见 SKILL.md

## 9. 官方来源

- 对比 diff:https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.5-rc.3...dsh-v0.1.7-rc.1
- 发布说明:https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1
- 会话格式迁移说明:仓库内 `packages/session/session-format-v3-to-v4/README.zh.md`
- 事件类型权威清单(0.1.7 安装树):`node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js`
- 模型生效判定实现:`node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/model-selection-projection.js`
- 相关技能:dsh-session-logs(verify-session owner)、dsh-config-assembly(verify-patch owner)、dsh-run、dsh-foundations
