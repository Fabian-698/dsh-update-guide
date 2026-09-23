#!/usr/bin/env node
/**
 * dsh-update-guide scan: 一键体检 dsh 升级断链（0.1.2-rc.1 基础面 + 0.1.5/0.1.6/0.1.7 新增面）。
 *
 * 在哪里用: 任何一台刚升级 dsh 的机器, 先跑本脚本输出问题清单, 再按 SKILL.md 逐项修复,
 * 最后用 verify-session.mjs / verify-patch.mjs 双闸门复核。
 *
 * 检测项:
 *   1. 版本核对            语义化版本比较(含预发布); 覆盖 0.1.2-rc.1 .. 0.1.7-rc.1, 区间外提示可能漏检
 *   2. 旧 API 残留         preset / 本地插件 / profile node_modules 里的 0.1.2 及以后断链模式(按版本门控)
 *   3. 配置死干预          cordis.patch.yml 顶层 disabled 行对应 id 不在装配树(dump-config entry not found)
 *   4. 失效模型引用        会话当前生效的 provider/model 不在装配树声明集(Profile patch ∪ dump-config ∪ 内置)内
 *   5. 未知事件类型        会话日志中出现已知全集之外的事件类型(仅统计, 具体校验交给 verify-session.mjs)
 *   6. 会话格式迁移概览    V4/V3/V2 三代会话文件计数与后继关系(0.1.7 起 V4)
 *   7. v0 可迁移性         仅 v2 的会话是否含 0.1.5 迁移器拒绝的历史形态(打开即 resume failed)
 *   8. agent preset 声明   会话 header.agentPreset 是否在装配树 preset-* 声明集中(0.1.7 起旧目录不再被读取)
 *   9. 旧预设目录残留      ~/.dsh/.agent-presets/ 下每个 preset id 还有多少会话引用(提示迁移)
 *
 * 注: 静态模式覆盖不到全部断链(典型: 0.1.5 服务访问缺 inject 只在插件 apply 时崩)。启用第三方插件前
 * 先跑 scripts/test-plugin-boot.mjs 做隔离启动测试(见 SKILL.md 第 4 节); 本文件只负责标记已知模式。
 *
 * 版本门控:
 *   < 0.1.2-rc.1   info 提示未达最低检查版本, 跳过后续, exit 0
 *   >= 0.1.2-rc.1  基础检查集(旧断链模式、死干预、模型引用、事件类型)
 *   >= 0.1.5-rc.1  额外 0.1.5 检查集(V3 迁移概览 + 0.1.5 新断链模式 + v0 迁移判定)
 *   >= 0.1.6-alpha.1  额外 0.1.6 检查集(PTC/workflow 改名、agent/created、Team spawn_teammate 等)
 *   >= 0.1.6-alpha.2  内置 deepseek-official 模型集缩减(移除 deepseek-v4-flash / -vision-exp)
 *   >= 0.1.7-alpha.1  额外 0.1.7 检查集(V4 会话、声明式 preset 核对、旧预设目录残留)
 *   >  0.1.7-rc.1  全部跑 + warning: 检查集最新只覆盖到 0.1.7-rc.1, 可能漏检
 *   解析失败       warning + 尽力跑全部检查, 绝不静默跳过
 *
 * 用法:
 *   node scan-upgrade.mjs [--dsh-home ~/.dsh] [--profile web] [--json]
 * 退出码: 0 = 无 blocker; 1 = 发现 blocker。
 *
 * 依赖: zstd CLI(解压会话)、dsh CLI(版本/dump-config; 不可用时降级 warning, 不中断)。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- CLI 参数 ----------
const ARGV = process.argv.slice(2)
if (ARGV.includes('--help') || ARGV.includes('-h')) {
  console.log(`dsh-update-guide 一键体检
用法: node scan-upgrade.mjs [--dsh-home ~/.dsh] [--profile web] [--json]
  --dsh-home  指定 DSH_HOME(默认 process.env.DSH_HOME 或 ~/.dsh)
  --profile   配置 profile(默认 web), 用于死干预与 preset/模型声明检查
  --json      输出 JSON 契约 { version, issues, blocker, warning, info }
退出码: 0 = 无 blocker; 1 = 有 blocker`)
  process.exit(0)
}
const argOf = (flag, fallback) => {
  const eq = ARGV.find(a => a.startsWith(`${flag}=`))
  if (eq) return eq.slice(flag.length + 1)
  const i = ARGV.indexOf(flag)
  if (i >= 0 && i + 1 < ARGV.length) return ARGV[i + 1]
  return fallback
}
const jsonOut = ARGV.includes('--json')
const PROFILE = argOf('--profile', 'web')
const DSH_HOME = resolve(argOf('--dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh')))
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ZSTD_OK = spawnSync('zstd', ['--version'], { encoding: 'utf8' }).status === 0

// ---------- 语义化版本比较(含预发布) ----------
// 规则: 0.1.5-rc.1 > 0.1.2-rc.1 > 0.1.2-alpha.9; release > 同号 rc; 数字段按数值比。
function parseSemver(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    pre: m[4] ? m[4].split('.').filter(Boolean) : [],
  }
}
function cmpSemver(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1  // release > 预发布
  if (b.pre.length === 0) return -1
  const n = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < n; i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === undefined) return -1  // 前缀相同则字段少者更小
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1 }
    else if (xn) return -1          // 数字标识 < 字母标识
    else if (yn) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
const MIN_CHECK_VERSION = { major: 0, minor: 1, patch: 2, pre: ['rc', '1'] }     // 0.1.2-rc.1
const V15_VERSION = { major: 0, minor: 1, patch: 5, pre: ['rc', '1'] }           // 0.1.5-rc.1
const V16_VERSION = { major: 0, minor: 1, patch: 6, pre: ['alpha', '1'] }        // 0.1.6-alpha.1
const V17_VERSION = { major: 0, minor: 1, patch: 7, pre: ['alpha', '1'] }        // 0.1.7-alpha.1
const LATEST_CHECK_VERSION = { major: 0, minor: 1, patch: 7, pre: ['rc', '1'] }  // 0.1.7-rc.1

// ---------- 已知事件类型全集(v2 ∪ v3 ∪ v4, 与 verify-session.mjs KNOWN_TYPES 保持一致) ----------
const KNOWN_EVENT_TYPES = new Set([
  'session', 'permission/preset', 'sandbox/mode', 'approval/policy', 'approval/asked', 'approval/decided',
  'agent-preset/selected', 'agent/inbox/spliced', 'step/start', 'step/end', 'turn/start', 'turn/end',
  'user/message', 'assistant/message', 'assistant/attempt', 'assistant/chunk',
  'reasoning-chunks', 'text-chunks', 'tool-call-chunks', 'system/message',
  'tool/call', 'tool/result', 'tool/code-dispatch', 'tool/code-dispatch-start',
  'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
  'request/context', 'request/header', 'compaction/start', 'compaction/end', 'compaction/prune', 'compaction/summary',
  'llm/retry', 'llm/retry-started', 'session/end-seed', 'session/title', 'session/title-llm-request',
  'command/run', 'command/done', 'todo/write', 'web/deepseek-search-llm-request',
  'feedback/record', 'feedback/message-put', 'feedback/message-delete', 'deliverables/presented',
  'goal/change', 'hook/invoked', 'hook/result', 'model/selection', 'plan/mode', 'schedule/change',
  'session-log-deepseek/delivery-accepted', 'subagent/descriptor', 'subagent/catalog', 'subagent/model-selection-policy',
  'team/member', 'team/task', 'team/message/queued', 'team/message/delivered',
  'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end', 'tool-workflow/run-start',
  // 0.1.6-alpha.1 / 0.1.7 新增(与 dsh 的 KNOWN_SESSION_EVENT_TYPES 对齐)
  'developer/message', 'image/offload', 'workspace/changes',
])

// ---------- 输出 ----------
const issues = [] // {category, severity: 'blocker'|'warning'|'info'|'ok', detail, fix}
function report(category, severity, detail, fix) {
  issues.push({ category, severity, detail, fix })
}
const countSeverity = sev => issues.filter(i => i.severity === sev).length

// ---------- 1. 版本核对 ----------
function checkVersion() {
  const r = spawnSync('dsh', ['--version'], { encoding: 'utf8', env: { ...process.env, DSH_HOME }, timeout: 30_000 })
  const raw = `${r.stdout || ''}\n${r.stderr || ''}`.trim()
  if (!raw) return { raw: null, semver: null }
  const firstLine = raw.split('\n')[0].trim() || null
  return { raw: firstLine, semver: parseSemver(firstLine) }
}

// ---------- 2. dump-config(死干预 / 声明式 preset / 模型声明共用一次调用) ----------
function fetchDumpConfig(profile) {
  const r = spawnSync('dsh', ['--profile', profile, '--dump-config'], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME }, maxBuffer: 64 * 1024 * 1024, timeout: 180_000,
  })
  const stdout = r.stdout || ''
  const combined = `${r.stderr || ''}\n${stdout}`
  // stdout 非空即视为可解析(死干预行会让 dump-config 以非 0 退出但树仍打印)
  const ok = !r.error && stdout.trim().length > 0
  return { stdout, combined, ok, error: r.error?.message ?? (r.status !== 0 ? `exit=${r.status}` : null) }
}

// 从 dump-config 装配树里取「已声明 agent preset 的 config.id」集合。
// 行形态: "- id: preset-<row>" 之后 config: 下缩进 4 的 "id: <presetId>"; 无 config.id 时按行 id 去 preset- 前缀。
function parseDeclaredPresets(dumpText) {
  const ids = new Set()
  let current = null
  for (const line of String(dumpText || '').split('\n')) {
    const head = line.match(/^- id:\s*([^\s#]+)\s*$/)
    if (head) {
      if (current) ids.add(current)
      current = head[1].startsWith('preset-') ? head[1].slice('preset-'.length) : null
      continue
    }
    if (!current) continue
    const cfg = line.match(/^ {4}id:\s*["']?([^"'\s]+)["']?\s*$/)
    if (cfg) current = cfg[1]
  }
  if (current) ids.add(current)
  return ids
}

// ---------- 3. 源码模式扫描 ----------
// 每条: name(正则), adapter(新 API 兼容层探测词, 同文件命中则降 info), severity, since(版本门控), fix
const PATTERNS = [
  // ---- 0.1.2-rc.1 基础面 ----
  {
    name: 'session.events', re: /session\s*\.\s*events\b/g, adapter: ['snapshotEvents'],
    severity: 'blocker',
    fix: '替换为 session.snapshotEvents()（全量快照）或 session.eventAt(seq)（单条）；见 references/fix-patterns.md',
  },
  {
    name: 'header.seedLength', re: /(?:session\.)?header\.seedLength\b/g, adapter: ['isSeeded'],
    severity: 'warning',
    fix: '旧会话 header 由 fromHeaderLine() 归一化(isSeeded)；读取端改 isSeeded 字段, 勿依赖 seedLength',
  },
  {
    name: 'request/header-delta', re: /header-delta\b/g, adapter: [],
    severity: 'blocker',
    fix: '0.1.2 已拒绝该请求头(assertSupportedRequestHeader)；正常会话无需构造, 旧构造删除',
  },
  {
    name: 'reason:"fallback"', re: /reason\s*[:=]\s*["']?fallback/g, adapter: [],
    severity: 'blocker',
    fix: '0.1.2 已拒绝 fallback 原因(assertSupportedRequestHeader)；删除该构造',
  },
  {
    name: 'registerContinuableSetup', re: /registerContinuableSetup\b/g, adapter: [],
    severity: 'warning',
    fix: '第三方插件(如 @nanmicoder/dsh-agent-teams 0.1.15)未适配 0.1.2 的 subagent API；保持该插件 disabled 等上游适配',
  },
  {
    name: 'apiProxy', re: /\bapiProxy\b/g, adapter: ['typertGateway'],
    severity: 'warning',
    fix: '官方已移除 apiProxy 服务(迁移为 typertGateway)；文件若已有 typertGateway 探测分支则已适配, 否则插件需升级适配',
  },
  // ---- 0.1.5-rc.1 新增面 ----
  {
    name: 'ctx.agent', re: /ctx\.agent\b/g, adapter: [],
    severity: 'warning', since: '0.1.5-rc.1',
    fix: '0.1.5 移除 ctx.agent；插件需显式传入 Agent(在创建处持有并以参数/闭包传递)',
  },
  {
    name: 'Inbox 构造/公共方法', re: /new\s+Inbox\s*\(|(?:inbox|Inbox)\.(?:claim|hasPending)\s*\(/g, adapter: [],
    severity: 'warning', since: '0.1.5-rc.1',
    fix: '0.1.5 Inbox 改为类型接口, hasPending/claim 不再是公共方法；改用新的 inbox 接口/事件(agent/inbox/spliced)',
  },
  {
    name: 'conversation Slot', re: /slot\(\s*['"]conversation['"]/g, adapter: [],
    severity: 'warning', since: '0.1.5-rc.1',
    fix: "0.1.5 原 conversation Slot 迁至 main 的 conversation key；slot('conversation') 改注册到 main 的 conversation key",
  },
  {
    name: 'dsh-client-ui-detail', re: /dsh-client-ui-detail/g, adapter: [],
    severity: 'warning', since: '0.1.5-rc.1',
    fix: '0.1.5 Detail 面板已移除, 能力迁至右侧 Sidebar；改用 sidebar/详情视图扩展点',
  },
  {
    name: 'connection.rpc.handle 缺 webServer inject', re: /ctx\s*\.\s*connection\s*\.\s*rpc\s*\.\s*handle\s*\(/g, adapter: ['webServer'],
    severity: 'blocker', since: '0.1.5-rc.1',
    adapterNote: '已声明 webServer',
    adapterFix: '文件已出现 webServer(inject 通常已含), 静态判定非断链; 仍建议跑 test-plugin-boot.mjs 确认',
    fix: '0.1.5 起 connection.rpc.handle 在调用方 fiber 上注册路由并取 webServer 服务; 插件 inject 缺 "webServer" 则启动即崩(cannot get property "webServer" without inject), 且整棵插件树加载失败。实例如 @js2hou/dsh-mcp-manager 0.1.5(上游 issue #6); 优先等上游适配(本机实测仅补 inject 仍失败), 用 test-plugin-boot.mjs 复核',
  },
  // ---- 0.1.6-alpha.1 新增面 ----
  {
    name: 'workflow-worker-thread(已改名)', re: /workflow-worker-thread\b/g, adapter: ['workflow-ptc'],
    severity: 'warning', since: '0.1.6-alpha.1',
    adapterNote: '已含 workflow-ptc',
    adapterFix: '已出现新名 workflow-ptc, 视为已迁移; 残留旧名仅注释/兼容分支可忽略',
    fix: '0.1.6-alpha.1 起工作流执行器 @deepseek-ai/dsh-workflow-worker-thread 改名为 @deepseek-ai/dsh-workflow-ptc; 更新包名与条目名(config 字段不变)',
  },
  {
    name: 'agent/session-start(已改为 agent/created)', re: /['"]agent\/session-start['"]/g, adapter: ['agent/created'],
    severity: 'warning', since: '0.1.6-alpha.1',
    adapterNote: '已含 agent/created',
    adapterFix: '已出现新事件 agent/created, 视为已迁移',
    fix: '0.1.6-alpha.1 起 agent/session-start 改为异步串行的 agent/created; 订阅/触发点都要换(见 references/breaking-changes-0.1.7.md)',
  },
  {
    name: 'subagent_fork(Team 已统一 spawn_teammate)', re: /\bsubagent_fork\b/g, adapter: ['spawn_teammate'],
    severity: 'warning', since: '0.1.6-alpha.1',
    adapterNote: '已含 spawn_teammate',
    adapterFix: '已出现 spawn_teammate, 视为已迁移',
    fix: '0.1.6-alpha.1 起 Team 模式统一用 spawn_teammate, 不再提供 subagent / subagent_fork; 改用 spawn_teammate',
  },
  {
    name: 'snapshotEvents/eventAt/ownEvents(已弃用)', re: /\b(?:snapshotEvents|eventAt|ownEvents)\b/g, adapter: [],
    severity: 'info', since: '0.1.6-alpha.1',
    adapterNote: '同步历史读取(已弃用)',
    adapterFix: '0.1.6 起弃用同步历史读取 snapshotEvents/eventAt/ownEvents; 0.1.7-rc.1 仍可运行, 建议迁移到异步事件 API',
    fix: '0.1.6-alpha.1 起弃用 snapshotEvents / eventAt / ownEvents; 迁移到异步事件 API(见 references/fix-patterns.md)',
  },
  // ---- 0.1.7-alpha.2 新增面 ----
  {
    name: 'maxInlineBytes(spill-policy 已改名)', re: /\bmaxInlineBytes\b/g, adapter: ['maxInlineTokens'],
    severity: 'warning', since: '0.1.7-alpha.2',
    adapterNote: '已含 maxInlineTokens',
    adapterFix: '已出现新键 maxInlineTokens, 视为已迁移',
    fix: '0.1.7-alpha.2 起自定义 spill-policy 的 maxInlineBytes 改名为 maxInlineTokens(语义从字节数改为 token 数); 更新配置键',
  },
]

// 只扫"实际装配的入口", 不扫源码头(plugin-src/src 是未打包源码, 入口在 lib/)
// 已禁用插件(dsh-market state.json / cordis.patch.yml disabled 行)源码残留 = 启用时才会崩,
// 降级为 warning(保持 disabled 即可), 不阻断。
function loadDisabledPackages(profile) {
  const disabled = new Set()
  try {
    const state = JSON.parse(readFileSync(join(DSH_HOME, 'profiles', profile, '.dsh-market', 'state.json'), 'utf8'))
    for (const d of state.disabled ?? []) disabled.add(d)
  } catch { /* 无 market state 不降级 */ }
  try {
    const patch = readFileSync(join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
    for (const m of patch.matchAll(/^- id:\s*(\S+)\s*\n\s*disabled:\s*true/gm)) disabled.add(m[1])
  } catch { /* 无 patch */ }
  // 归一: id 不带 @scope(如 agent-teams)与包名(如 @nanmicoder/dsh-agent-teams)相互覆盖
  const norm = new Set()
  for (const d of disabled) {
    norm.add(d)
    norm.add(d.split('/').pop() ?? d)
    norm.add(d.replace(/^dsh-/, ''))
  }
  return norm
}
function packageBelongsToFile(f) {
  // node_modules 下沿目录向上找最近 package.json 的 name
  let dir = f
  for (let i = 0; i < 8; i++) {
    dir = dir.slice(0, dir.lastIndexOf('/'))
    if (!dir || !dir.includes('node_modules')) return null
    const pkg = join(dir, 'package.json')
    if (!existsSync(pkg)) continue
    try { return JSON.parse(readFileSync(pkg, 'utf8')).name ?? null } catch { return null }
  }
  return null
}

function scanSources(atLeast) {
  const roots = [
    join(DSH_HOME, '.agent-presets'),
    join(DSH_HOME, 'plugins'),
    join(DSH_HOME, 'profiles', 'web', 'node_modules'),
  ]
  const seen = new Set()
  const disabledPkgs = loadDisabledPackages(PROFILE)
  for (const root of roots) {
    if (!existsSync(root)) continue
    const files = []
    const walk = (d, depth) => {
      if (depth > 6) return
      let ents = []
      try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        const p = join(d, e.name)
        // 跳过 node_modules/.pnpm/plugin-src/src/点目录/.min./.map
        if (e.name === 'node_modules' || e.name === '.pnpm' || e.name === 'plugin-src' || e.name === 'src' ||
            e.name.startsWith('.') || e.name.includes('.min.') || e.name.endsWith('.map')) continue
        if (e.isDirectory()) walk(p, depth + 1)
        else if (/\.(mjs|js|cjs)$/.test(e.name)) files.push(p)
      }
    }
    walk(root, 0)
    for (const f of files) {
      if (seen.has(f)) continue
      seen.add(f)
      let text
      try {
        const st = statSync(f)
        if (st.size > 6 * 1024 * 1024) continue // 文件上限 6MB
        text = readFileSync(f, 'utf8')
      } catch { continue }
      for (const pat of PATTERNS) {
        if (pat.since && !atLeast(pat.since)) continue // 版本门控: 对应版本起才扫
        const hits = [...text.matchAll(pat.re)]
        if (!hits.length) continue
        // 只统计非注释行(行首 // /* * # 的跳过); 一个文件报一次
        const nonComment = hits.some(mm => {
          const line = text.slice(0, mm.index).split('\n').pop()
          return !/^\s*(\/\/|\*|#|\/\*)/.test(line.trim())
        })
        if (!nonComment) continue
        // 兼容层判定: 文件里出现新 API 探测词 → "先探测新 API 再回退"的适配写法, 降级 info
        const hasAdapter = pat.adapter.some(a => text.includes(a))
        let sev = hasAdapter ? 'info' : pat.severity
        // 已禁用插件的源码残留: 启用前不会触发, 降级 warning
        const pkgName = packageBelongsToFile(f)
        if (sev === 'blocker' && pkgName) {
          const p = pkgName.split('/').pop() ?? pkgName
          if (disabledPkgs.has(pkgName) || disabledPkgs.has(p) || disabledPkgs.has(pkgName.replace(/^dsh-/, '')) || disabledPkgs.has(p.replace(/^dsh-/, ''))) {
            report('source', 'warning', `${pat.name}(已禁用插件源码, 启用时才会触发) → ${f.replace(DSH_HOME, '~/.dsh')}`,
              `该插件(包 ${pkgName})当前被禁用: 保持 disabled 即可; 若要启用, 先找作者适配版或自行改 API(见 fix-patterns.md)`)
            continue
          }
        }
        if (sev === 'info') {
          report('source', 'info', `${pat.name}(${pat.adapterNote ?? '兼容层'}) → ${f.replace(DSH_HOME, '~/.dsh')}`,
            pat.adapterFix ?? '已含兼容层(探测新 API 后回退), 非断链')
          continue
        }
        report('source', sev, `${pat.name} → ${f.replace(DSH_HOME, '~/.dsh')}`, pat.fix)
      }
    }
  }
}

// ---------- 4. 配置死干预 ----------
function checkDeadPatch(dump, profile) {
  const patchFile = join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml')
  const homePatch = join(DSH_HOME, 'cordis.patch.yml')
  // dump-config 会把 home 级 cordis.patch.yml 也组合进来, 因此任一存在都要跑(只看 profile 会漏检)
  if (!existsSync(patchFile) && !existsSync(homePatch) && !dump.ok) {
    report('config', 'info', `未发现 profiles/${profile}/cordis.patch.yml 或 home cordis.patch.yml, 跳过死干预检查`, '')
    return
  }
  const notFound = [...dump.combined.matchAll(/patch:\s*entry\s+"([^"]+)"\s+not found/g)].map(m => m[1])
  if (notFound.length) {
    for (const id of new Set(notFound)) {
      report('config', 'warning', `死干预行 - id: ${id}(对应 bundle 已不在装配树)`,
        '从 cordis.patch.yml 删除该行; profile 级 patch 改动需重启 dsh web 生效')
    }
  } else if (!dump.ok) {
    report('config', 'warning', `dsh --profile ${profile} --dump-config 执行失败(${dump.error ?? '未知原因'}), 死干预检查跳过`,
      `确认 dsh 已安装且 profile 名正确; 手工执行 dsh --profile ${profile} --dump-config 2>&1 | grep 'not found' 定位`)
  } else {
    report('config', 'ok', '无死干预行(dump-config 无 entry not found)', '')
  }
}

// ---------- 5. 会话文件发现与单遍采集 ----------
// 每个 session 目录的权威文件优先级 V4 > V3 > V2(0.1.7 V4; 旧会话迁移后原文件与后继并存)。
// 只做一次解压, 模型引用 / 事件类型 / v0 可迁移性 / preset 引用共用同一遍数据, 避免多遍 zstd。
function discoverSessions() {
  const sessRoot = join(DSH_HOME, 'sessions')
  const out = []
  if (!existsSync(sessRoot)) return out
  let wsList = []
  try { wsList = readdirSync(sessRoot) } catch { return out }
  for (const ws of wsList) {
    const wd = join(sessRoot, ws)
    let wst
    try { wst = statSync(wd) } catch { continue }
    if (!wst.isDirectory()) continue
    let sdList = []
    try { sdList = readdirSync(wd) } catch { continue }
    for (const sd of sdList) {
      const dir = join(wd, sd)
      let sst
      try { sst = statSync(dir) } catch { continue }
      if (!sst.isDirectory()) continue
      const files = {
        v4: join(dir, 'session.v4.jsonl.zstd'),
        v3: join(dir, 'session.v3.jsonl.zstd'),
        v2: join(dir, 'session.jsonl.zstd'),
      }
      const has = { v4: existsSync(files.v4), v3: existsSync(files.v3), v2: existsSync(files.v2) }
      let format = null
      for (const f of ['v4', 'v3', 'v2']) if (has[f]) { format = f; break }
      if (!format) continue
      out.push({ dir, file: files[format], format, has })
    }
  }
  return out
}

// zstd -dc 读取; 失败返回 null
function readSessionText(file) {
  const r = spawnSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120_000 })
  if (r.error || r.status !== 0) return null
  return r.stdout
}

// 子代理会话特征: origin/kind=subagent、delegationDepth>0、parentSession 存在(任一)
function isSubagentHeader(header) {
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent' || header.kind === 'subagent') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return Boolean(header.parentSession)
}

function parseHeaderLine(firstLine) {
  try {
    const h = JSON.parse(firstLine)
    if (h && typeof h === 'object') return h
  } catch { /* 头行损坏时走正则兜底 */ }
  return {
    origin: /"origin"\s*:\s*"subagent"/.test(firstLine) ? 'subagent' : undefined,
    kind: /"kind"\s*:\s*"subagent"/.test(firstLine) ? 'subagent' : undefined,
    delegationDepth: Number((/"delegationDepth"\s*:\s*(\d+)/.exec(firstLine) ?? [])[1] ?? 0),
    parentSession: /"parentSession"\s*:\s*"/.test(firstLine) ? 'unknown' : undefined,
    agentPreset: (/"agentPreset"\s*:\s*"([^"]+)"/.exec(firstLine) ?? [])[1],
  }
}

// 从 model/selection 或 request/header 行取 provider/model(V4 起 request/header 是 data.header.config.*)
function refFromLine(line, kind) {
  let e
  try { e = JSON.parse(line) } catch { return null }
  const d = e && e.data
  if (!d || typeof d !== 'object') return null
  if (kind === 'selection') {
    return typeof d.provider === 'string' && typeof d.model === 'string' ? `${d.provider}/${d.model}` : null
  }
  const conf = (d.header && d.header.config) || d.config || d
  return conf && typeof conf.provider === 'string' && typeof conf.model === 'string' ? `${conf.provider}/${conf.model}` : null
}

// ---------- 6. 单遍采集 ----------
// 0.1.5 的 v0→v1 迁移器是冻结校验;以下历史形态会被拒绝(会话打开即报
// "resume failed ... refuses this format v0 Session"),修复工具见 repair-v0-sessions.mjs:
//   summary    插件 source 带 summary 且 form 已定义且非 notice(旧版 dsh-mnemon);
//              form 未定义时 dsh 校验器直接放行, 不算违规, 不要误报/误删。
//              source 可出现在 data.source、data.message.source、data.inserted[*].source
//              等任意嵌套位置, 必须递归查(agent/inbox/spliced.inserted[] 实测会漏)。
//   descriptor subagent/descriptor 的 version !== 3(v0 源只认 3, 不限于 2)
//   replay     旧版 assistant/chunk finish 的平铺 replayState(当前为 { response, blocks })
// 返回 { committed, tail } 两组计数:
//   committed = 违规行出现在最后一个 turn/end 之前 → 该区域已提交, 迁移器拒绝(blocker)
//   tail      = 违规行只在最后一个 turn/end 之后 → recoverable 解码静默丢弃该行, 会话仍可打开(warning)
function countBadPluginSummaries(value) {
  if (Array.isArray(value)) { let n = 0; for (const v of value) n += countBadPluginSummaries(v); return n }
  if (!value || typeof value !== 'object') return 0
  let n = 0
  if (value.kind === 'plugin' && typeof value.form === 'string' && value.form !== 'notice' && value.summary !== undefined) n++
  for (const k of Object.keys(value)) n += countBadPluginSummaries(value[k])
  return n
}

function detectV0RefusalPatterns(text) {
  const lines = text.split('\n')
  let lastTurnEnd = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\{\s*"type"\s*:\s*"turn\/end"/.test(lines[i])) lastTurnEnd = i
  }
  const committed = { summary: 0, descriptor: 0, replay: 0 }
  const tail = { summary: 0, descriptor: 0, replay: 0 }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || (!line.includes('"summary"') && !line.includes('subagent/descriptor') && !line.includes('"replayState"'))) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object') continue
    const isSummary = line.includes('"summary"') && countBadPluginSummaries(e.data) > 0
    const isDescriptor = e.type === 'subagent/descriptor' && e.data && e.data.version !== 3
    const rs = e.data && e.data.chunk && e.data.chunk.replayState
    const isReplay = rs && typeof rs === 'object' && Object.prototype.hasOwnProperty.call(rs, 'kind')
    if (!isSummary && !isDescriptor && !isReplay) continue
    const bucket = lastTurnEnd >= 0 && i < lastTurnEnd ? committed : tail
    if (isSummary) bucket.summary++
    if (isDescriptor) bucket.descriptor++
    if (isReplay) bucket.replay++
  }
  return { committed, tail }
}

function collectSessions() {
  const agg = {
    sessions: 0, topLevel: 0, subagent: 0, unreadable: 0,
    formats: { v4: 0, v3: 0, v2: 0, v4WithOlder: 0, v3WithV2: 0 },
    model: { checked: 0, ok: 0, bad: new Set(), refs: new Map() },
    unknownTypes: new Map(),
    presetRefs: new Map(), // presetId -> { top, sub }
    migration: {
      sessions: new Set(), summary: 0, descriptor: 0, replay: 0,
      tailSessions: new Set(), tailSummary: 0, tailDescriptor: 0, tailReplay: 0,
    },
  }
  for (const s of discoverSessions()) {
    agg.sessions++
    agg.formats[s.format]++
    if (s.format === 'v4' && (s.has.v3 || s.has.v2)) agg.formats.v4WithOlder++
    if (s.format === 'v3' && s.has.v2) agg.formats.v3WithV2++
    const text = readSessionText(s.file)
    if (text === null) { agg.unreadable++; continue }
    const header = parseHeaderLine(text.split('\n', 1)[0] ?? '')
    const subagent = isSubagentHeader(header)
    // v0 可迁移性: 只看仍以旧 v2 文件为权威的会话(有 v3/v4 后继时不再迁移旧文件)
    if (s.format === 'v2') {
      const d = detectV0RefusalPatterns(text)
      const c = d.committed.summary + d.committed.descriptor + d.committed.replay
      const t = d.tail.summary + d.tail.descriptor + d.tail.replay
      if (c > 0) {
        agg.migration.sessions.add(s.file)
        agg.migration.summary += d.committed.summary
        agg.migration.descriptor += d.committed.descriptor
        agg.migration.replay += d.committed.replay
      }
      if (t > 0) {
        agg.migration.tailSessions.add(s.file)
        agg.migration.tailSummary += d.tail.summary
        agg.migration.tailDescriptor += d.tail.descriptor
        agg.migration.tailReplay += d.tail.replay
      }
    }
    const ap = header && typeof header.agentPreset === 'string' && header.agentPreset ? header.agentPreset : null
    if (ap) {
      const e = agg.presetRefs.get(ap) ?? { top: 0, sub: 0 }
      if (subagent) e.sub++
      else e.top++
      agg.presetRefs.set(ap, e)
    }
    if (subagent) { agg.subagent++; continue }
    agg.topLevel++
    // 当前生效模型: 最后一个 model/selection(若有), 否则最后一个 request/header
    let sel = null
    let hdr = null
    for (const line of text.split('\n')) {
      if (line.includes('"model/selection"')) {
        const r = refFromLine(line, 'selection')
        if (r) sel = r
      } else if (line.includes('"request/header"')) {
        const r = refFromLine(line, 'header')
        if (r) hdr = r
      }
    }
    const ref = sel ?? hdr
    if (ref) {
      agg.model.checked++
      agg.model.refs.set(ref, (agg.model.refs.get(ref) || 0) + 1)
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"type"')) continue
      // 只认行首的顶层 type(事件/记录行的 type 均为第一个键), 避免嵌套 JSON 的 type 误报
      const m = line.match(/^\s*\{\s*"type"\s*:\s*"([^"]+)"/)
      if (!m || KNOWN_EVENT_TYPES.has(m[1])) continue
      agg.unknownTypes.set(m[1], (agg.unknownTypes.get(m[1]) || 0) + 1)
    }
  }
  return agg
}

// ---------- 7. 模型声明目录 ----------
// 解析两条路径: llm-pi-ai.providers.<name>.models[*].id 与 llm-deepseek.models[*].id。
// 同时兼容 settings.yaml 的顶层键形状与 dump-config / cordis.patch.yml 的 "- id: llm-pi-ai" 条目形状
// (条目形状会多一层 config)。
function parseModelCatalog(text) {
  const providers = new Map() // name -> Set(modelId)
  const deepseek = new Set()
  const stack = [] // {indent, key}
  const unquote = s => String(s).replace(/^["']|["']$/g, '').trim()
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '')
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = line.match(/^\s*/)[0].length
    const body = line.trim()
    const li = body.match(/^-\s*id:\s*(.+?)\s*$/)
    if (li) {
      const rawPath = stack.filter(s => s.indent < indent).map(s => s.key)
      const path = rawPath.length > 1 && rawPath[1] === 'config' ? [rawPath[0], ...rawPath.slice(2)] : rawPath
      const id = unquote(li[1])
      if (path.length === 4 && path[0] === 'llm-pi-ai' && path[1] === 'providers' && path[3] === 'models') {
        if (!providers.has(path[2])) providers.set(path[2], new Set())
        providers.get(path[2]).add(id)
      } else if (path.length === 2 && path[0] === 'llm-deepseek' && path[1] === 'models') {
        deepseek.add(id)
      }
      // 装配条目自身也要入栈(dump-config/cordis.patch.yml 的 llm-pi-ai 就是 "- id: ..." 行)
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      stack.push({ indent, key: id })
      continue
    }
    const kv = body.match(/^([^:]+):\s*(.*)$/)
    if (!kv) continue
    const key = unquote(kv[1])
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key })
  }
  return { providers, deepseek }
}

// 0.1.5 内置 deepseek-official 4 个 id; 0.1.6-alpha.2 移除 deepseek-v4-flash / -vision-exp。
// 两个集合都保留字面量: fix-model-refs.mjs 与本文件的 selftest 一致性用例依赖这些 id 出现。
const OFFICIAL_MODELS_015 = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'])
const OFFICIAL_MODELS_016 = new Set(['deepseek-flash', 'deepseek-v4-pro'])
function officialModelsFor(versionUnknown, atLeast016) {
  if (versionUnknown) return new Set([...OFFICIAL_MODELS_015, ...OFFICIAL_MODELS_016])
  return atLeast016 ? new Set(OFFICIAL_MODELS_016) : new Set(OFFICIAL_MODELS_015)
}

// 声明来源优先级: Profile cordis.patch.yml → dsh dump-config(补齐 bundle 声明的 provider)
// → settings.yaml → settings.yaml.imported(0.1.7 起 settings.yaml 只导入一次并改名)。
function loadModelCatalog(dump) {
  const tried = []
  const merged = { providers: new Map(), deepseek: new Set() }
  const used = []
  const absorb = (cat, name) => {
    let n = 0
    for (const [p, set] of cat.providers) {
      if (!merged.providers.has(p)) merged.providers.set(p, new Set())
      for (const m of set) { merged.providers.get(p).add(m); n++ }
    }
    for (const m of cat.deepseek) { merged.deepseek.add(m); n++ }
    if (n) used.push(name)
  }
  const patchRel = `profiles/${PROFILE}/cordis.patch.yml`
  const patchFile = join(DSH_HOME, patchRel)
  if (existsSync(patchFile)) {
    try { absorb(parseModelCatalog(readFileSync(patchFile, 'utf8')), patchRel) } catch { tried.push(`${patchRel}:读取失败`) }
  } else tried.push(`${patchRel}:缺失`)
  if (dump && dump.ok) absorb(parseModelCatalog(dump.stdout), `dsh --profile ${PROFILE} --dump-config`)
  else tried.push(`dsh --profile ${PROFILE} --dump-config:不可用`)
  if (!used.length) {
    for (const f of ['settings.yaml', 'settings.yaml.imported']) {
      const p = join(DSH_HOME, f)
      if (!existsSync(p)) { tried.push(`${f}:缺失`); continue }
      try { absorb(parseModelCatalog(readFileSync(p, 'utf8')), f) } catch { tried.push(`${f}:读取失败`) }
      if (used.length) break
    }
  }
  return { providers: merged.providers, deepseek: merged.deepseek, source: used.length ? used.join(' ∪ ') : null, tried }
}

function checkModelRefs(agg, catalog) {
  if (!agg.sessions) return
  if (!catalog.source) {
    report('model', 'warning',
      `未找到可用的模型声明来源(${catalog.tried.join('; ')}), 会话模型引用未核对`,
      `确认 dsh CLI 可用(自动读 dump-config)或存在 ${join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')} / settings.yaml`)
    return
  }
  const counts = agg.model
  const bad = counts.bad
  const unreadNote = agg.unreadable > 0 ? `, ${agg.unreadable} 个不可读` : ''
  const srcNote = `; 声明来源 ${catalog.source}`
  if (bad.size) {
    const badList = [...bad].map(r => ({ ref: r, n: counts.refs.get(r) || 0 })).sort((a, b) => b.n - a.n)
    const badSessions = badList.reduce((n, b) => n + b.n, 0)
    report('model', 'blocker',
      `会话当前模型引用失效 provider/model: ${badList.slice(0, 10).map(b => `${b.ref}×${b.n}`).join(', ')}${badList.length > 10 ? ' …' : ''}（失效会话 ${badSessions} 个; 顶层共扫描 ${counts.checked} 会话, ${counts.ok} 正常, 跳过子代理 ${agg.subagent}${unreadNote}${srcNote}）`,
      `运行 node ${join(SCRIPT_DIR, 'fix-model-refs.mjs')} --list 预览, 再 --provider <有效 provider> --model <有效 model> 批量切换; 合法集 = 内置 deepseek-official ∪ llm-deepseek.models ∪ llm-pi-ai.providers.*.models${srcNote}`)
  } else if (agg.unreadable > 0) {
    report('model', 'warning',
      `模型引用检查未覆盖全部会话: ${agg.unreadable} 个会话不可读(其余核对 ${counts.checked} 个全部有效, 跳过子代理 ${agg.subagent})`,
      '确认 zstd CLI 可用、会话文件未损坏; node scripts/repair-v0-sessions.mjs --list 会列出不可修复项')
  } else {
    report('model', 'ok', `会话当前模型引用全部有效（顶层共扫描 ${counts.checked} 会话, 跳过子代理 ${agg.subagent}${srcNote}）`, '')
  }
}

// ---------- 8. 未知事件类型 + v0 可迁移性 ----------
function checkEventTypes(agg, checkMigration) {
  if (!agg.sessions) return
  const counts = { total: agg.topLevel, skipped: agg.subagent, unreadable: agg.unreadable }
  // 不可读会话必须显式告警: 否则 zstd 缺失/文件损坏时会"全绿"(所有检查都 0 会话)
  if (!ZSTD_OK) {
    report('events', 'warning', 'zstd CLI 不可用: 会话事件类型与 v0 可迁移性检查全部跳过',
      '安装 zstd 后重跑(dsh 会话日志依赖 zstd 解压); 模型引用与配置检查不受影响')
  } else if (counts.unreadable > 0) {
    report('events', 'warning',
      `${counts.unreadable} 个会话日志不可读(zstd 解压失败或文件损坏), 事件类型与迁移检查未覆盖它们`,
      '确认会话文件未损坏; node scripts/repair-v0-sessions.mjs --list 会列出不可修复项')
  }
  if (agg.unknownTypes.size) {
    const list = [...agg.unknownTypes.entries()].map(([t, n]) => `${t}×${n}`).slice(0, 8).join(', ')
    report('events', 'warning',
      `未知事件类型(第三方插件扩展时属正常): ${list}（扫描 ${counts.total} 个顶层会话, 跳过子代理 ${counts.skipped}, 不可读 ${counts.unreadable}）`,
      '第三方扩展用 verify-session.mjs --ignore-type; 若属官方新类型则更新其 KNOWN_TYPES 快照')
  } else if (counts.total === 0 && counts.unreadable > 0) {
    report('events', 'warning', `会话事件检查未执行: ${counts.unreadable} 个会话全部不可读`,
      '确认 zstd CLI 可用且会话文件未损坏; 不要据此认为事件类型无问题')
  } else {
    report('events', 'ok', `全量扫描 ${counts.total} 个顶层会话日志(v2/v3/v4 皆含), 事件类型均在已知全集${counts.unreadable ? `(另有 ${counts.unreadable} 个不可读)` : ''}`, '')
  }
  if (checkMigration) {
    const m = agg.migration
    const total = m.summary + m.descriptor + m.replay
    const tailTotal = m.tailSummary + m.tailDescriptor + m.tailReplay
    if (total > 0) {
      report('migration', 'blocker',
        `v0 会话含 0.1.5 迁移器拒绝的历史形态(打开即 resume failed): source.summary×${m.summary}, descriptor v2×${m.descriptor}, 平铺 replayState×${m.replay}（涉及 ${m.sessions.size} 个会话, 含子代理）`,
        `node ${join(SCRIPT_DIR, 'repair-v0-sessions.mjs')} --list 预览; 确认已有 sessions.bak-* 备份后加 --apply 修复（离线全链路校验 + 原子替换）`)
    } else if (tailTotal > 0) {
      report('migration', 'warning',
        `v0 会话尾部含旧形态记录(未提交, 打开时会静默丢弃该行, 不影响打开): summary×${m.tailSummary}, descriptor v2×${m.tailDescriptor}, 平铺 replayState×${m.tailReplay}（涉及 ${m.tailSessions.size} 个会话）`,
        `如需保留这些尾部记录: node ${join(SCRIPT_DIR, 'repair-v0-sessions.mjs')} --list/--apply`)
    } else if (counts.unreadable > 0) {
      report('migration', 'warning',
        `v0 可迁移性检查未覆盖 ${counts.unreadable} 个不可读会话(已读部分未发现拒绝形态)`,
        '确认这些会话文件可正常解压; 对不可修复项用 repair-v0-sessions.mjs --list 查看原因')
    } else {
      report('migration', 'ok', 'v0 会话未发现已知迁移拒绝形态(可正常打开并惰性迁移)', '')
    }
  }
}

// ---------- 9. agent preset 声明核对(0.1.7-alpha.1+) ----------
// 0.1.7 起 ~/.dsh/.agent-presets/ 不再被读取; 预设必须在装配树里声明为 preset-* 行,
// 否则会话打开报 RemoteError('agent-preset/not-found', 'Unknown agent preset: <id>')。
const BUILTIN_AGENT_PRESETS = ['standard', 'ptc', 'minimal', 'cordis']
function checkAgentPresets(agg, declared, dump) {
  if (!agg.sessions) return
  if (!dump.ok) {
    report('preset', 'warning',
      `无法枚举已声明的 agent preset(dsh --profile ${PROFILE} --dump-config 失败: ${dump.error ?? '未知原因'}), 会话 preset 引用未核对`,
      `手工执行 dsh --profile ${PROFILE} --dump-config | grep '^- id: preset-' 核对; 不要据此认为 preset 无问题`)
    return
  }
  const known = new Set([...BUILTIN_AGENT_PRESETS, ...declared])
  const missing = []
  for (const [id, c] of agg.presetRefs) if (!known.has(id)) missing.push({ id, ...c })
  if (missing.length) {
    missing.sort((a, b) => b.top - a.top || b.sub - a.sub)
    const topTotal = missing.reduce((n, m) => n + m.top, 0)
    const subTotal = missing.reduce((n, m) => n + m.sub, 0)
    report('preset', 'blocker',
      `会话引用的 agent preset 未在装配树声明(打开即 Unknown agent preset): ${missing.map(m => `${m.id}(顶层 ${m.top}${m.sub ? ` / 子代理 ${m.sub}` : ''})`).join(', ')}——共 ${topTotal} 个顶层会话${subTotal ? ` + ${subTotal} 个子代理会话` : ''}`,
      `0.1.7-alpha.1 起 ~/.dsh/.agent-presets/<id>/ 不再被读取; 在 profiles/${PROFILE}/cordis.patch.yml 里声明 ` +
      `- id: preset-<id> / name: '@deepseek-ai/dsh-agent-preset' / config: {id: <id>, order: <n>, plugins: [...]}(或做成 plugin bundle 安装)后重启 dsh web; ` +
      '示例见 references/breaking-changes-0.1.7.md 与 references/fix-patterns.md')
  } else {
    report('preset', 'ok', `会话引用的 ${agg.presetRefs.size} 个 agent preset 全部已声明(装配树 preset-* 共 ${declared.size} 个)`, '')
  }
}

// ---------- 10. 旧预设目录残留(0.1.7-alpha.1+) ----------
function checkLegacyPresetDirs(agg, known, v17Plus) {
  const dir = join(DSH_HOME, '.agent-presets')
  if (!existsSync(dir)) {
    report('legacy-presets', 'info', '未发现旧预设目录 ~/.dsh/.agent-presets/', '')
    return
  }
  let ids = []
  try { ids = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { /* 读不到按空处理 */ }
  if (!ids.length) {
    report('legacy-presets', 'info', '~/.dsh/.agent-presets/ 存在但没有子目录', '')
    return
  }
  if (!v17Plus) {
    report('legacy-presets', 'info', `~/.dsh/.agent-presets/ 有 ${ids.length} 个预设(${ids.join(', ')}); 当前版本仍会读取该目录`,
      '升级到 0.1.7 前先把仍在用的预设迁移成声明式 preset-* 行')
    return
  }
  const refs = ids.map(id => ({ id, ...(agg.presetRefs.get(id) ?? { top: 0, sub: 0 }) }))
  const unmigrated = refs.filter(r => !known.has(r.id))
  if (unmigrated.length) {
    const topTotal = unmigrated.reduce((n, r) => n + r.top, 0)
    report('legacy-presets', 'warning',
      `旧预设目录 ~/.dsh/.agent-presets/ 残留 ${ids.length} 个预设, 其中 ${unmigrated.map(r => `${r.id}(顶层 ${r.top}${r.sub ? ` / 子代理 ${r.sub}` : ''})`).join(', ')} 未迁移(影响 ${topTotal} 个顶层会话)`,
      '0.1.7 起该目录不再被读取; 把仍需使用的预设声明成 preset-* 行(或做成 plugin bundle), 确认无会话引用后再删除旧目录')
  } else {
    report('legacy-presets', 'info',
      `旧预设目录 ~/.dsh/.agent-presets/ 残留 ${ids.length} 个预设(${ids.join(', ')}), 均已声明或已无会话引用`,
      '确认无会话引用后可删除该目录(0.1.7 起不再被读取)')
  }
}

// ---------- 11. 会话格式迁移概览 ----------
function checkFormatMigration(agg) {
  if (!agg.sessions) return
  const f = agg.formats
  report('v3', 'info',
    `V4 会话 ${f.v4} 个(其中 ${f.v4WithOlder} 个保留 v2/v3 旧文件); V3 会话 ${f.v3} 个(其中 ${f.v3WithV2} 个保留 v2 原文件); 仅 v2 待惰性迁移 ${f.v2} 个`,
    'V4 不支持降级读取(0.1.7)；升级前备份 ~/.dsh/sessions; 新会话为原生 V4-only; 旧会话打开时惰性迁移')
}

// ---------- 主流程 ----------
const ver = checkVersion()
const tooOld = ver.semver !== null && cmpSemver(ver.semver, MIN_CHECK_VERSION) < 0
// 版本门控: 版本无法解析时按"全部执行"(绝不静默跳过)
const atLeast = v => ver.semver === null || cmpSemver(ver.semver, parseSemver(v)) >= 0
if (tooOld) {
  report('version', 'info',
    `当前版本 ${ver.raw} 未达最低检查版本 0.1.2-rc.1; 本体检针对 0.1.2+ 破坏面, 已跳过后续检查`,
    '如需升级: 先按官方流程升级到 0.1.7-rc.1 再跑本技能')
} else {
  if (ver.semver === null) {
    report('version', 'warning',
      `无法解析 dsh 版本(${ver.raw ?? 'dsh --version 无输出'}); 将尽力执行全部检查, 不静默跳过`,
      '确认 dsh 已安装且在 PATH; 手工执行 dsh --version 核对')
  } else if (cmpSemver(ver.semver, LATEST_CHECK_VERSION) > 0) {
    report('version', 'warning',
      `当前版本 ${ver.raw} 高于检查集最新覆盖的 0.1.7-rc.1; 检查可能漏检更高版本的新破坏面`,
      '关注官方 changelog; 发现问题后更新本技能的 pattern/检查集')
  } else {
    report('version', 'ok',
      `检查集覆盖 0.1.2-rc.1 .. 0.1.7-rc.1(含 0.1.5-rc.2/rc.3、0.1.6-alpha.1/2、0.1.7-alpha.1/2), 当前 ${ver.raw}`, '')
  }
  const dump = fetchDumpConfig(PROFILE)
  checkDeadPatch(dump, PROFILE)
  scanSources(atLeast)
  const catalog = loadModelCatalog(dump)
  const agg = collectSessions()
  const official = officialModelsFor(ver.semver === null, atLeast('0.1.6-alpha.2'))
  for (const s of agg.model.refs.keys()) {
    const idx = s.indexOf('/')
    const provider = s.slice(0, idx)
    const model = s.slice(idx + 1)
    const valid = provider === 'deepseek-official'
      ? official.has(model) || catalog.deepseek.has(model)
      : (catalog.providers.get(provider)?.has(model) ?? false)
    if (valid) agg.model.ok += agg.model.refs.get(s)
    else agg.model.bad.add(s)
  }
  checkModelRefs(agg, catalog)
  checkEventTypes(agg, atLeast('0.1.5-rc.1'))
  const declared = dump.ok ? parseDeclaredPresets(dump.stdout) : new Set()
  const knownPresets = new Set([...BUILTIN_AGENT_PRESETS, ...declared])
  if (atLeast('0.1.7-alpha.1')) checkAgentPresets(agg, declared, dump)
  checkLegacyPresetDirs(agg, knownPresets, atLeast('0.1.7-alpha.1'))
  if (atLeast('0.1.5-rc.1')) checkFormatMigration(agg)
}

const blockers = countSeverity('blocker')
const warnings = countSeverity('warning')
const infos = countSeverity('info')

function printDoubleGate() {
  console.log('双闸门复核:')
  console.log(`  node ${join(SCRIPT_DIR, 'verify-session.mjs')} --all`)
  console.log(`  node ${join(SCRIPT_DIR, 'verify-patch.mjs')} --profile ${PROFILE}`)
}

if (jsonOut) {
  console.log(JSON.stringify({ version: ver.raw, issues, blocker: blockers, warning: warnings, info: infos }, null, 2))
} else if (tooOld) {
  console.log(`dsh 版本: ${ver.raw}`)
  console.log('当前版本未达最低检查版本 0.1.2-rc.1, 已跳过后续检查（exit 0, 无需按本技能修复）')
  console.log(`\n体检完成: 0 blocker / 0 warning / ${infos} info（详见 --json）`)
  printDoubleGate()
} else {
  console.log(`dsh 版本: ${ver.raw ?? '（无法解析）'}`)
  for (const i of issues) {
    if (i.severity === 'ok' || i.severity === 'info') continue
    console.log(`[${i.severity.toUpperCase()}] ${i.category}: ${i.detail}`)
    if (i.fix) console.log(`   修复: ${i.fix}`)
  }
  console.log(`\n体检完成: ${blockers} blocker / ${warnings} warning / ${infos} info（info 详见 --json）`)
  if (blockers) console.log('发现阻断问题, 按上表逐项修复(见 SKILL.md), 修复后重跑本脚本确认归零')
  else if (warnings) console.log('无阻断问题, 剩余 warning 按需处理')
  else console.log('无阻断问题, 全部通过')
  printDoubleGate()
}
process.exitCode = blockers ? 1 : 0
