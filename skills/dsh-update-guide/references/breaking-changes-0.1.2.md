# dsh 0.1.2-rc.1 破坏性变更(0.1.2 代,逐条核对版)

来源:官方发布说明(dsh-v0.1.2-rc.1,自 v0.1.1-rc.2 以来汇总)+ 本机 2026-09-06 全量排查实测。
每条列:变更 → 影响面 → 判定方法 → 修复。★=本机实战确认踩过。

## 开发/插件 API 类

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★1 | `Session.events` 移除,改为 `seq`、`eventAt()`、`snapshotEvents()` | 自定义 preset、第三方插件读会话历史必崩(`undefined.some()`) | grep `session.events`(识别兼容层:同文件含 snapshotEvents/eventAt 探测则为适配) | `snapshotEvents()` 全量 / `eventAt(seq)` 单条 |
| ★2 | `SessionSeq` 与 `SessionLogOffset` 强类型区分(向前兼容) | 第三方插件类型引用,运行时兼容 | 编译/运行报类型错 | 插件升级;旧二进制通常仍可用 |
| ★3 | 旧版 `APIProxy` 服务移除,统一为 Remote 网关(`typertGateway`) | 引用 `apiProxy` 服务的插件(旧版 dsh-im、dsh-browser 等) | grep `apiProxy`;有无 `typertGateway` 探测分支 | 升级插件版本(dsh-im ≥4.9.1);或插件自家加分支 |
| ★4 | `report` 工具被 `send_message` 取代 | 面向子代理的单向回传模式 | 工具清单/代码 grep `'report'` | 双向 `send_message`(父↔子可持续代理) |
| ★5 | `request/header-delta` 与 `reason:"fallback"` 被拒绝 | 旧请求头构造不再被接受 | grep | 正常会话无需构造,删除 |
| ★6 | `subagents.registerContinuableSetup` 等 subagent API 变化 | 未适配的第三方插件启用失败 | 启用尝试即报 `is not a function`;dshmarket 日志有 `on ok=false` | 保持 disabled 等上游;裸 `session.events` 见 #1 |
| 7 | 会话流默认折叠过程内容/System prompt;UI 大规模拆模块 | 自定义 client UI 插件导入路径失效 | 插件 build/运行报 import 错 | 按新模块分层导入 |

## 会话/持久化类

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★8 | `sourceEventSeqs` 新增 range-pairs 编码 `[[19,638]]`(旧数组形态仍合法) | **只影响校验工具**,harness 本身兼容 | verify-session S10 报 `refs=19,638` 成对值 = 工具没更新 | 用本技能 shim verify-session(解析到 owner 最新版,已支持两种形态) |
| ★9 | 会话日志新增事件类型:model/selection、plan/mode、hook/invoked、hook/result、schedule/change、feedback/record、compaction/prune、team/member、team/task、subagent/model-selection-policy、session-log-deepseek/delivery-accepted、tool-workflow/(agent-end|agent-start|run-end|run-start) | **只影响工具快照**;harness 认这些类型 | verify-session S8 报上述 = 快照旧 | owner 版 KNOWN_TYPES 已含全集(本技能 shim 解析到它) |
| ★10 | 故事类:旧 `code mode` 更名 `ptc mode`(会话记录仍可读) | 无(只读兼容) | — | — |
| 11 | SQLite Session 持久化后端移除 | 配了 sqlite 后端的部署 | settings/patch grep sqlite | 用 JSONL(默认);旧内容用旧版本导出 |

## 模型/工具面

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★12 | pi-ai 模型支持更新(新增 vLLM 思考预算等配置) | settings.yaml 里旧 provider/model 变 UNKNOWN_MODEL | 会话 header 引用不匹配 | 会话级 selectModel(默认 deepseek-official/deepseek-v4-flash)或恢复 settings |
| 13 | Web PTC 模式默认不提供通用 `workflow` 工具(改用 `run_code`;`tool-ralph` 仍提供) | PTC 会话里没有 workflow 工具 | 工具清单 | 新会话/标准模式;或自定义 preset |
| 14 | 公网 WebFetch 默认启用(SSRF 防护,不再逐次审批) | 行为更宽,非故障 | — | — |
| 15 | Python SDK/Headless/ACP/自定义 Profile 默认提供 `web_fetch` | 无副作用 | — | — |
| 16 | web_search 失败时报告实际端点 | 诊断改进 | — | — |
| 17 | DeepSeek 官方适配器默认随请求带上已启用插件包名/版本(可关) | 隐私策略面 | 配置 | 如需关闭,查官方适配器配置 |

## 配置/装配面

| # | 变更 | 影响面 | 判定 | 修复 |
|---|---|---|---|---|
| ★18 | 官方 `web` bundle 默认 config 键集加 `fetchProvider`(`{searchProvider, fetchProvider}`) | 覆写 web 行的 patch 若没抄全 → config-clobber 闸门 FAIL | verify-patch --diff-default | 覆写行补全字段 |
| ★19 | 修复 Profile 配置的 Agent Preset 目录启动丢失;无法加载的 preset 提前标记 | 自定义 preset 目录 | 切 preset 报原因 | 检查 preset 目录/语法 |
| 20 | Minimal preset 不再显示不适用 `/goal` | 无 | — | — |
| 21 | 系统提示词 workflow 分区顺序修正 | 无(行为变化) | — | — |

## 运行/平台类(本机无关但其他机器可能有)

- Node.js 24.0–24.11.1 启动失败/HMR 失效修复 → 相关版本可直接升 0.1.2-rc.1(本机 24.19.0 无问题)
- macOS/Linux 持久 Bash/PowerShell 修复(管道读到空、启动过早)→ 升级即受益
- 会话日志截断尾部自动修复时输出警告并注明受影响会话 → verify-session S6 空洞 WARN 正常
- 网关 WebSocket 心跳 → 空闲连接不断,无操作负担
- 界面配置:第三方语言、权限分类本地化、字号/宽度调节 → 纯 UI

## 已知非问题(容易误诊)

- 子代理会话打开报 `agent-busy`/需要 parent 地址 → 设计行为(402 个本机会话),需要 `kind:"subagent"` 地址
- verify-session S9 单帧 zstd → 真问题(会话列表 500);S6 空洞 → 压缩投影正常痕迹
- dshmarket 日志 `update-blocked: refused while agents are running` → 保护机制,非故障
- dsh-im 自更新 TIMEOUT 后自动恢复旧版验证 → 网络问题,非升级破坏
