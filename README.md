# dsh-update-guide

DeepSeek Harness（dsh）**升级与升级后断链修复**的执行型技能（Agent Skill，标准 `SKILL.md` 格式）。

覆盖 **0.1.2-rc.1 → 0.1.5-rc.1** 两代破坏性变更：升级流程（备份 → 切 tag/快进 → `pnpm install && pnpm build && pnpm build:web` → 经 dshmarket 重启）与升级后故障（旧会话打不开、`UNKNOWN_MODEL`、V3 会话格式、v0 会话迁移被拒、`ctx.agent`/Inbox/Slot 插件不兼容、配置死干预）。

核心原则：**先体检定位 → 逐项修复 → 双闸门验证**。同一症状（打不开会话）可能来自 preset 断链、模型失效、v0 迁移拒绝、V3 迁移、session 锁、子代理会话六种完全不同的原因，体检脚本按版本分流，不靠猜。

> 本技能原名 `dsh-upgrade-fix-012`，随 0.1.5 支持扩写并改名；仓库地址沿用，旧链接自动重定向。

## 这个技能解决什么

| 症状 | 根因 | 工具 |
|---|---|---|
| 旧会话恢复即崩 `Cannot read properties of undefined (reading 'some')` | preset/插件裸引用已移除的 `Session.events` | `scan-upgrade.mjs`（source 类）+ `references/fix-patterns.md` |
| 会话报 `UNKNOWN_MODEL` | 会话"当前生效"的 provider/model 不在合法目录并集内 | `fix-model-refs.mjs`（`--list` / `--dry-run` / 批量切换） |
| 打开即 `resume failed ... refuses this format v0 Session` | v0→v1 迁移器的冻结校验拒绝三类旧形态（插件消息 `summary`、descriptor v2、平铺 `replayState`） | `repair-v0-sessions.mjs`（`--list` / `--apply`，强制备份 + 全链校验） |
| 读不到新会话 / 误判旧文件 | 0.1.5 起为 `session.v3.jsonl.zstd`（header `"version":3`），V3 不可降级读取 | `verify-session.mjs` **S12** + `references/fix-patterns.md` 模式 7 |
| 插件启用失败 / 运行时抛错 | 0.1.5 移除 `ctx.agent`、Inbox 变类型接口、`conversation` Slot 迁移 | `scan-upgrade.mjs`（source 类）+ 模式 8-11 |
| 配置改了不生效 | `cordis.patch.yml` 死干预行（id 已不在装配树）/ key 集抄漏触发 clobber | `verify-patch.mjs`（T1 树 / T2 MCP schema / T3 握手 / `--diff-default`） |
| 校验工具报未知事件类型、成对 `refs` | 旧快照的**误报**，不是日志损坏 | 本技能` scripts/verify-*.mjs`（解析到 owner 最新版） |

## 安装

```bash
# A) 直接克隆到受管技能目录（与 dsh-foundations 等兄弟技能同目录）
git clone --depth 1 https://github.com/Fabian-698/dsh-update-guide.git ~/.dsh/skills/dsh-update-guide

# B) skills CLI
npx skills add Fabian-698/dsh-update-guide -g

# C) 手工复制：把 SKILL.md + references/ + scripts/ + evals/ 放到
#    ~/.dsh/skills/dsh-update-guide/   （或 ~/.agents/skills/dsh-update-guide/）
```

**推荐连同技能族一起装**：`dsh-foundations`（必读背景）、`dsh-session-logs`（verify-session owner）、`dsh-config-assembly`（verify-patch owner）、`dsh-run`。闸门 shim 会优先解析 `scripts/gates/`，再回退到兄弟技能。

本仓库**已嵌入闸门副本**（`scripts/gates/`，由 `sync-gates.mjs --embed` 生成），因此单独克隆即可跑完整流程；用 `node scripts/sync-gates.mjs --check` 可校验内置副本与 owner 是否漂移。

## 快速开始

```bash
SKILL=~/.dsh/skills/dsh-update-guide

# 0) 升级前：备份会话日志（V3 不可降级读取，回退旧版前必须有备份）
bak=~/.dsh/sessions.bak-$(date +%Y%m%d-%H%M%S)
test ! -e "$bak" && cp -R ~/.dsh/sessions "$bak" && du -sh "$bak"

# 1) 体检（版本感知，七类：version/source/config/model/events/v3/migration）
node $SKILL/scripts/scan-upgrade.mjs --profile web

# 2) 按体检输出修（blocker → warning）
node $SKILL/scripts/repair-v0-sessions.mjs --list     # 先看第 0 步：v0 迁移拒绝
node $SKILL/scripts/repair-v0-sessions.mjs --apply    # 需 sessions.bak-*，离线全链校验后原子替换
node $SKILL/scripts/fix-model-refs.mjs --list         # 再修失效模型引用
node $SKILL/scripts/fix-model-refs.mjs --provider deepseek-official --model deepseek-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt --dry-run

# 3) 双闸门（两个都 ALL PASS 才算修完；有 FAIL 禁止重启）
node $SKILL/scripts/verify-session.mjs --all
node $SKILL/scripts/verify-patch.mjs --profile web --diff-default

# 4) 经 dshmarket 重启 dsh web，打开一个旧会话抽查（V3 会话优先）
```

用 AI agent 时直接把 `SKILL.md` 交给它即可——本技能就是写给模型看的操作手册：修复顺序、判定方法、已知坑、回滚路径都在里面。

## 内容

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 智能体入口：升级流程、修复顺序、双闸门、回滚、已知坑 |
| `references/breaking-changes-0.1.2.md` | 0.1.2-rc.1 破坏性变更逐条核对：变更 → 影响面 → 判定方法 |
| `references/breaking-changes-0.1.5.md` | 0.1.2 → 0.1.5 合并破坏性变更（含 V3 会话格式、升级/自检清单） |
| `references/fix-patterns.md` | 15 个可复制修复模式（preset 桩、V3 读取器、`ctx.agent`、Inbox、面板 Slot、persona、session 锁、v0 迁移被拒……） |
| `references/model-fix.md` | `UNKNOWN_MODEL` 完整复盘：合法目录并集、六个误报案例、写全局默认的副作用 |
| `scripts/scan-upgrade.mjs` | 一键体检（七类，`--json`；退出码 0 = 无 blocker，1 = 有 blocker） |
| `scripts/repair-v0-sessions.mjs` | 修复无法迁移到 V3 的 v0 会话（三类已知拒绝形态），`--list` / `--apply` |
| `scripts/fix-model-refs.mjs` | 批量修会话模型引用（RPC `selectModel`，审计为 `model/selection` 事件） |
| `scripts/verify-session.mjs` | 会话日志完整性闸门（S1/S2/S6/S8-S12，含 S12 V3 一致性） |
| `scripts/verify-patch.mjs` | 配置装配闸门（T1 树 / T2 MCP schema / T3 握手 / `--diff-default` clobber 与死干预） |
| `scripts/verify-patch-surface.mjs` | 上游契约漂移检查（S1/S2 面） |
| `scripts/sync-gates.mjs` | 闸门副本同步与漂移校验（`--list` / `--embed` / `--check`） |
| `scripts/selftest.mjs` | 确定性自测（A 语法 / B 事件表 / C 模型 id / D 闸门解析 / E fixtures 回归 / F V3 优先 / H S1 判定 / I migration 判定），`--full` 追加真实体检 |
| `evals/` | 触发与任务评测集（`evals.json` + `trigger-eval.json`） |

## 兼容性与纪律

- 目标区间：**dsh 0.1.2-rc.1 → 0.1.5-rc.1**（GitHub 上无 0.1.4、无 0.1.5-rc.2）；`scan-upgrade.mjs` 会先打印检测到的版本，区间外只做人工判定。
- Linux/macOS，Node ≥ 18；脚本为 Node ESM，**只用 `node:` 内建模块，无第三方依赖**。
- 除 `repair-v0-sessions.mjs --apply`（强制 `sessions.bak-*` 备份 + 离线全链校验 + 逐文件原子替换）外，所有脚本对 `~/.dsh/sessions` **只读**；`fix-model-refs.mjs` 只走 RPC，不直接改日志文件。
- 升级/迁移期间**不要手改会话日志、不要重命名或删除迁移产物**（v2 原文件 + v3 后继都保留）；停 GUI 走 dshmarket 的 `/dsh-market/restart`，不要裸 kill、不要删 `session.lock`。
- 仓库不含任何凭据；cookie / token 由运行时通过文件或 `DSH_TOKEN` 提供（cookie 等同完整 API 凭据，用完即删）。

## License

[MIT](LICENSE)
