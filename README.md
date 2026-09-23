# dsh-update-guide

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Agent Skill](https://img.shields.io/badge/Agent%20Skills-SKILL.md-4B32C3)](https://agentskills.io)

**仓库**：<https://github.com/Fabian-698/dsh-update-guide> · **技能目录**：`skills/dsh-update-guide/` · **技能名**：`dsh-update-guide`

DeepSeek Harness（dsh）**升级与升级后断链修复**的执行型技能（Agent Skill，标准 `SKILL.md` 格式）。覆盖 **0.1.2-rc.1 → 0.1.7-rc.1** 三代破坏性变更：升级流程（备份 → 切 tag/快进 → `pnpm install && pnpm build && pnpm build:web` → 经 dshmarket 重启）与升级后故障（旧会话打不开、`Unknown agent preset`、`UNKNOWN_MODEL`、Session V4/V3 格式、v0 会话迁移被拒、`ctx.agent`/Inbox/Slot/`inject` 插件不兼容、`settings.yaml` 改为 Profile 配置只导入一次、配置死干预）。

核心原则：**先体检定位 → 逐项修复 → 双闸门验证**。同一症状（打不开会话）可能来自 preset 未声明、模型失效、v0 迁移拒绝、V4/V3 迁移、session 锁、子代理会话六种完全不同的原因，`scan-upgrade.mjs` 按版本（0.1.5 / 0.1.6 / 0.1.7 分段）分流，不靠猜。

> 本技能原名 `dsh-upgrade-fix-012`，随 0.1.5 支持扩写并改名；本仓库随之改名，旧链接自动重定向。

## 这个技能解决什么

| 症状 | 根因 | 工具 |
|---|---|---|
| 旧会话恢复即崩 `Cannot read properties of undefined (reading 'some')` | preset/插件裸引用已移除的 `Session.events` | `scan-upgrade.mjs`（source 类）+ `references/fix-patterns.md` |
| 会话报 `UNKNOWN_MODEL` | 会话"当前生效"的 provider/model 不在合法目录并集内 | `fix-model-refs.mjs`（`--list` / `--dry-run` / 批量切换） |
| 打开即 `resume failed ... refuses this format v0 Session` | v0→v1 迁移器的冻结校验拒绝三类旧形态（插件消息 `summary`、descriptor v2、平铺 `replayState`） | `repair-v0-sessions.mjs`（`--list` / `--apply`，强制备份 + 全链校验） |
| 打开旧会话报 `Unknown agent preset: <id>` | **0.1.7 起 `~/.dsh/.agent-presets/` 不再被读取**，预设必须声明成装配树 `preset-*` 行 | `scan-upgrade.mjs`（**preset** / legacy-presets 类）+ 模式 16 |
| 读不到新会话 / 误判旧文件 | 0.1.5 起 V3 = `session.v3.jsonl.zstd`、**0.1.7 起 V4 = `session.v4.jsonl.zstd`**（header `"version":4`），V3/V4 不可降级读取；权威文件按 V4 > V3 > V2 | `verify-session.mjs` **S12** + 模式 7 |
| 模型成片报失效 / 漏报失效 | 校验器读了已改名的 `settings.yaml`（应为 Profile `cordis.patch.yml`/dump-config）；或沿用旧内置集（0.1.6-alpha.2 已移除 `deepseek-v4-flash` 等） | `scan-upgrade.mjs`（**model** 类，带"声明来源"与 ×N 计数）|
| 插件启用失败 / 运行时抛错 / dsh web 起不来 | 0.1.5 移除 `ctx.agent`、Inbox 变类型接口、`conversation` Slot 迁移、`ctx.connection.rpc.handle` 缺 `webServer` inject | `test-plugin-boot.mjs`（隔离启动测试）+ 模式 8-11 |
| 配置改了不生效 | `cordis.patch.yml` 死干预行（id 已不在装配树）/ key 集抄漏触发 clobber / **0.1.7 起 `settings.yaml` 只导入一次并改名 `settings.yaml.imported`** | `verify-patch.mjs`（T1 树 / T2 MCP schema / T3 握手 / `--diff-default`）+ 模式 17 |
| 校验工具报未知事件类型、成对 `refs` | 旧快照的**误报**，不是日志损坏 | `scripts/verify-*.mjs`（解析到 owner 或内置闸门） |

## 版本与依赖

| 项 | 约束 | 核对方式 |
|---|---|---|
| dsh | **0.1.2-rc.1 → 0.1.7-rc.1**（含端点）；区间外只做人工判定，体检脚本按版本分段选检查集 | `dsh --version` |
| 升级链路 | 0.1.2-rc.1 → … → 0.1.5-rc.1 → 0.1.5-rc.2 → 0.1.5-rc.3 → 0.1.6-alpha.1 → 0.1.6-alpha.2 → 0.1.7-alpha.1 → 0.1.7-alpha.2 → 0.1.7-rc.1（GitHub 上无 0.1.4；0.1.5-rc.3 仅 tag） | `git fetch --tags && git tag -l 'dsh-v0.1.*'` |
| Node | **≥ 22.15**；`selftest.mjs` / `repair-v0-sessions.mjs` 用 `node:zlib` 的 `zstdCompressSync`（22.15 / 23.8 起提供），其余脚本只用 `node:` 内建模块、无第三方 npm 依赖 | `node -v` |
| zstd CLI | **必需**：会话日志是 zstd 容器，`scan-upgrade` / `verify-session` / `fix-model-refs` / `repair-v0-sessions` 都靠它解压（缺失时相关检查降级为 warning / SKIP，不会假绿） | `zstd --version` |
| 本技能 | 自足：体检/修复/boot 测试/自测/闸门都在技能目录内；闸门副本已内置在 `scripts/gates/` | `node scripts/selftest.mjs`、`node scripts/sync-gates.mjs --check` |
| 兄弟技能（推荐同装） | `dsh-foundations`（必读背景）、`dsh-session-logs`（verify-session owner）、`dsh-config-assembly`（verify-patch / verify-patch-surface owner）、`dsh-run`（启动与 dshmarket 重启） | 装在同一技能树目录下；缺失只影响 owner 解析，本技能仍可独立跑通 |
| 会话格式 | v0/v2 = `session.jsonl.zstd`；v3 = `session.v3.jsonl.zstd`（header `"version":3`）；**V4 = `session.v4.jsonl.zstd`（header `"version":4`）**；权威文件按 V4 > V3 > V2；V3/V4 不可降级读取，回退旧版前必须备份 | `node scripts/verify-session.mjs --all`（S12；owner 需 V4-aware） |
| 破坏性写操作前提 | `repair-v0-sessions.mjs --apply` 要求 `sessions.bak-*` 中存在目标会话同相对路径的备份 | `node scripts/repair-v0-sessions.mjs --list` |

## 安装与发现

### 1) skills.sh / skills CLI（覆盖 Claude Code、Codex、Cursor、OpenCode、Gemini CLI 等 80+ 客户端）

```bash
# 全局安装（写入各 agent 的全局技能目录）
npx skills add Fabian-698/dsh-update-guide -g

# 只给某个 agent；或项目内安装（不带 -g，落 <项目>/.<agent>/skills/）
npx skills add Fabian-698/dsh-update-guide -g -a claude-code
npx skills add Fabian-698/dsh-update-guide -a codex -a cursor

# 先预览仓库里有哪些技能（不安装）
npx skills add Fabian-698/dsh-update-guide --list
```

### 2) DeepSeek Harness（dsh）

skills CLI 目前没有 dsh 目标，用仓库自带的一键脚本或手工复制：

```bash
# A) 一键脚本（在仓库 checkout 里执行；默认装到 ${DSH_HOME:-~/.dsh}/skills/dsh-update-guide）
bash install.sh --dry-run      # 先看要做什么
bash install.sh                # 安装 / 更新（已存在时需 --force，会先备份）
bash install.sh --from ~/.dsh/skills/dsh-update-guide   # 从已有目录复制

# B) 手工复制（等价）
tmp=$(mktemp -d)
git clone --depth 1 https://github.com/Fabian-698/dsh-update-guide.git "$tmp/repo"
cp -R "$tmp/repo/skills/dsh-update-guide" ~/.dsh/skills/
rm -rf "$tmp"
```

### 3) 各客户端技能目录（手工放置时）

| 客户端 | 全局目录 | 项目目录 |
|---|---|---|
| DSH | `~/.dsh/skills/`（或 `$DSH_HOME/skills/`） | — |
| 通用（Amp / Replit / Universal） | `~/.config/agents/skills/` | `.agents/skills/` |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex | `~/.codex/skills/` | `.agents/skills/` |
| Cursor | `~/.cursor/skills/` | `.agents/skills/` |
| Gemini CLI | `~/.gemini/skills/` | `.agents/skills/` |
| OpenCode | `~/.config/opencode/skills/` | `.agents/skills/` |

技能本体与客户端无关（标准 `SKILL.md` + 相对路径引用），只要落在上表任一目录即可被发现。

## 快速开始

```bash
SKILL=~/.dsh/skills/dsh-update-guide

# 0) 升级前：备份会话日志（V3/V4 不可降级读取，回退旧版前必须有备份）
bak=~/.dsh/sessions.bak-$(date +%Y%m%d-%H%M%S)
test ! -e "$bak" && cp -R ~/.dsh/sessions "$bak" && du -sh "$bak"

# 1) 体检（版本感知，九类：version/source/config/model/events/v3/migration/preset/legacy-presets）
node $SKILL/scripts/scan-upgrade.mjs --profile web

# 2) 按体检输出修（blocker → warning）
node $SKILL/scripts/scan-upgrade.mjs | grep -A2 preset   # 第 0.5 步：preset 未声明（0.1.7 P0，见模式 16）
node $SKILL/scripts/repair-v0-sessions.mjs --list     # 第 0 步：v0 迁移拒绝
node $SKILL/scripts/repair-v0-sessions.mjs --apply    # 需 sessions.bak-*，离线全链校验后原子替换
node $SKILL/scripts/fix-model-refs.mjs --list         # 再修失效模型引用
node $SKILL/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt --dry-run
node $SKILL/scripts/test-plugin-boot.mjs              # 启用第三方插件前：隔离启动测试

# 3) 双闸门（两个都 ALL PASS 才算修完；有 FAIL 禁止重启）
node $SKILL/scripts/verify-session.mjs --all
node $SKILL/scripts/verify-patch.mjs --profile web --diff-default

# 4) 经 dshmarket 重启 dsh web，打开一个旧会话抽查（V4 会话优先）
```

用 AI agent 时直接把 `skills/dsh-update-guide/SKILL.md` 交给它即可——本技能就是写给模型看的操作手册：版本与依赖、修复顺序、判定方法、已知坑、回滚路径都在里面。

## 内容

| 路径 | 作用 |
|---|---|
| `skills/dsh-update-guide/SKILL.md` | 智能体入口：版本与依赖、升级流程、修复顺序、双闸门、回滚、已知坑 |
| `skills/dsh-update-guide/references/breaking-changes-0.1.2.md` | 0.1.2-rc.1 破坏性变更逐条核对：变更 → 影响面 → 判定方法 |
| `skills/dsh-update-guide/references/breaking-changes-0.1.5.md` | 0.1.2 → 0.1.5 合并破坏性变更（含 V3 会话格式、升级/自检清单） |
| `skills/dsh-update-guide/references/breaking-changes-0.1.7.md` | 0.1.5-rc.1 → 0.1.7-rc.1 破坏性变更（tag 矩阵、Session V4、声明式 preset、settings 单次导入、PTC/workflow 改名、内置模型缩减、API 变更） |
| `skills/dsh-update-guide/references/fix-patterns.md` | 17 个可复制修复模式（声明式 preset、V4/V3 读取器、`ctx.agent`、Inbox、面板 Slot、persona、session 锁、v0 迁移被拒、settings 单次导入……） |
| `skills/dsh-update-guide/references/model-fix.md` | `UNKNOWN_MODEL` 完整复盘：合法目录并集与 0.1.7 声明来源、七个误报案例、写全局默认的副作用 |
| `skills/dsh-update-guide/scripts/scan-upgrade.mjs` | 一键体检（九类，`--json`；退出码 0 = 无 blocker，1 = 有 blocker） |
| `skills/dsh-update-guide/scripts/repair-v0-sessions.mjs` | 修复无法迁移的 v0 会话（三类已知拒绝形态，V4 由 dsh 惰性迁移），`--list` / `--apply` |
| `skills/dsh-update-guide/scripts/fix-model-refs.mjs` | 批量修会话模型引用（RPC `selectModel`，审计为 `model/selection` 事件） |
| `skills/dsh-update-guide/scripts/test-plugin-boot.mjs` | 隔离 DSH_HOME 启动测试：全量启用插件 → 隔离失败项 → 输出不兼容清单 |
| `skills/dsh-update-guide/scripts/verify-session.mjs` | 会话日志完整性闸门（S1/S2/S6/S8-S12，含 S12 V3/V4 一致性；owner 需 V4-aware，否则看不见 V4 会话会假绿） |
| `skills/dsh-update-guide/scripts/verify-patch.mjs` | 配置装配闸门（T1 树 / T2 MCP schema / T3 握手 / `--diff-default`） |
| `skills/dsh-update-guide/scripts/verify-patch-surface.mjs` | 上游契约漂移检查（S1/S2 面） |
| `skills/dsh-update-guide/scripts/sync-gates.mjs` | 闸门副本同步与漂移校验（`--list` / `--embed` / `--check`） |
| `skills/dsh-update-guide/scripts/selftest.mjs` | 确定性自测 A-M（语法 / 事件表 / 模型 id / 闸门解析 / V2+V3 fixtures / V3 优先 / S1 / migration / 严格 inject / **V4+preset 核对 / 模型目录回退**）；`--full` 追加真实体检与"本机 0 blocker"断言 |
| `skills/dsh-update-guide/evals/` | 触发与任务评测集（`evals.json` + `trigger-eval.json`） |
| `install.sh` | DSH 安装/更新脚本（`--dry-run` / `--force` / `--from`） |

## 兼容性与纪律

- 目标区间：**dsh 0.1.2-rc.1 → 0.1.7-rc.1**；`scan-upgrade.mjs` 会先打印检测到的版本并按版本分段选检查集，区间外只做人工判定。
- Linux/macOS，**Node ≥ 22.15**，需要 **zstd CLI**（`zstd --version` 可用；会话日志是 zstd 容器，缺了只能跑模型引用与配置部分）；除 `repair-v0-sessions.mjs --apply`（强制 `sessions.bak-*` 备份 + 离线全链校验 + 逐文件原子替换）外，所有脚本对 `~/.dsh/sessions` **只读**；`fix-model-refs.mjs` 只走 RPC，不直接改日志文件。
- `test-plugin-boot.mjs` 只读真实 `~/.dsh`（复制 profile 到 0700 临时目录、软链 node_modules），退出即删；`--keep` 保留现场用于排查。
- 升级/迁移期间**不要手改会话日志、不要重命名或删除迁移产物**（旧原文件 + v3/v4 后继都保留）；停 GUI 走 dshmarket 的 `/dsh-market/restart`，不要裸 kill、不要删 `session.lock`。0.1.7 起旧 preset 目录 `~/.dsh/.agent-presets/` 不再被读取，请在装配树里声明 `preset-*` 行。
- 仓库不含任何凭据；cookie / token 由运行时通过文件或 `DSH_TOKEN` 提供（cookie 等同完整 API 凭据，用完即删）。

## 自测与 CI

```bash
node skills/dsh-update-guide/scripts/selftest.mjs           # 快速档（不扫描真实会话）
node skills/dsh-update-guide/scripts/selftest.mjs --full    # 追加真实 scan-upgrade --json + 本机 0 blocker 断言
node skills/dsh-update-guide/scripts/sync-gates.mjs --check  # 内置闸门副本 vs owner 漂移
```

`.github/workflows/verify.yml` 在每次 push / PR 上跑同样的确定性自测（A-M）与漂移检查。

## License

[MIT](LICENSE)
