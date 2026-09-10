#!/usr/bin/env node
/**
 * dsh-update-guide scan: 一键体检 dsh 升级断链（0.1.2-rc.1 基础面 + 0.1.5-rc.1 新增面）。
 *
 * 在哪里用: 任何一台刚升级 dsh 的机器, 先跑本脚本输出问题清单, 再按 SKILL.md 逐项修复,
 * 最后用 verify-session.mjs / verify-patch.mjs 双闸门复核。
 *
 * 检测项:
 *   1. 版本核对            语义化版本比较(含预发布); 低于 0.1.2-rc.1 跳过, 高于 0.1.5-rc.1 提示可能漏检
 *   2. 旧 API 残留         preset / 本地插件 / profile node_modules 里的 0.1.2、0.1.5 断链模式
 *   3. 配置死干预          cordis.patch.yml 顶层 disabled 行对应 id 不在装配树(dump-config entry not found)
 *   4. 失效模型引用        会话当前生效的 provider/model 不在 settings.yaml 声明集与 deepseek-official 并集内
 *   5. 未知事件类型        会话日志中出现 v2∪v3 已知全集之外的事件类型(仅统计, 具体校验交给 verify-session.mjs)
 *   6. V3 迁移概览         有 v3 后继的会话数 / 仅 v2 待惰性迁移的会话数(0.1.5+)
 *   7. v0 可迁移性         仅 v2 的会话是否含 0.1.5 迁移器拒绝的历史形态(打开即 resume failed)
 *
 * 版本门控:
 *   < 0.1.2-rc.1   info 提示未达最低检查版本, 跳过后续, exit 0
 *   >= 0.1.2-rc.1  基础检查集(旧断链模式、死干预、模型引用、事件类型)
 *   >= 0.1.5-rc.1  额外 0.1.5 检查集(V3 迁移概览 + 0.1.5 新断链模式)
 *   >  0.1.5-rc.1  全部跑 + warning: 检查集最新只覆盖到 0.1.5-rc.1, 可能漏检
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
  --profile   配置 profile(默认 web), 用于死干预检查
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
const MIN_CHECK_VERSION = { major: 0, minor: 1, patch: 2, pre: ['rc', '1'] } // 0.1.2-rc.1
const V15_VERSION = { major: 0, minor: 1, patch: 5, pre: ['rc', '1'] }       // 0.1.5-rc.1

// ---------- 已知事件类型全集(v2 ∪ v3, 与 verify-session.mjs KNOWN_TYPES 保持一致) ----------
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

// ---------- 2. 源码模式扫描 ----------
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

function scanSources(runV15) {
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
        if (pat.since && !runV15) continue // 版本门控: 0.1.5 模式只在 >= 0.1.5-rc.1 时扫
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
          report('source', 'info', `${pat.name}(兼容层) → ${f.replace(DSH_HOME, '~/.dsh')}`, '已含兼容层(探测新 API 后回退), 非断链')
          continue
        }
        report('source', sev, `${pat.name} → ${f.replace(DSH_HOME, '~/.dsh')}`, pat.fix)
      }
    }
  }
}

// ---------- 3. 配置死干预 ----------
function checkDeadPatch(profile) {
  const patchFile = join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml')
  const homePatch = join(DSH_HOME, 'cordis.patch.yml')
  // dump-config 会把 home 级 cordis.patch.yml 也组合进来, 因此任一存在都要跑(只看 profile 会漏检)
  if (!existsSync(patchFile) && !existsSync(homePatch)) {
    report('config', 'info', `未发现 profiles/${profile}/cordis.patch.yml 或 home cordis.patch.yml, 跳过死干预检查`, '')
    return
  }
  const r = spawnSync('dsh', ['--profile', profile, '--dump-config'], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME }, maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  })
  const combined = `${r.stderr || ''}\n${r.stdout || ''}`
  const notFound = [...combined.matchAll(/patch:\s*entry\s+"([^"]+)"\s+not found/g)].map(m => m[1])
  if (notFound.length) {
    for (const id of new Set(notFound)) {
      report('config', 'warning', `死干预行 - id: ${id}(对应 bundle 已不在装配树)`,
        '从 cordis.patch.yml 删除该行; profile 级 patch 改动需重启 dsh web 生效')
    }
  } else if (r.error || r.status !== 0) {
    report('config', 'warning', `dsh --profile ${profile} --dump-config 执行失败(${r.error?.message ?? `exit=${r.status}`}), 死干预检查跳过`,
      `确认 dsh 已安装且 profile 名正确; 手工执行 dsh --profile ${profile} --dump-config 2>&1 | grep 'not found' 定位`)
  } else {
    report('config', 'ok', '无死干预行(dump-config 无 entry not found)', '')
  }
}

// ---------- 4. 失效模型引用 ----------
// 解析 settings.yaml: llm-pi-ai.providers.<name>.models[*].id 与顶层 llm-deepseek.models[*].id
// (缩进栈解析, 只认这两种路径; llm-deepseek.models 用于扩展 deepseek-official 内置集)
function parseSettingsModelCatalog(settingsText) {
  const providers = new Map() // name -> Set(modelId)
  const deepseek = new Set()
  const stack = [] // {indent, key}
  const unquote = s => s.replace(/^["']|["']$/g, '')
  for (const rawLine of settingsText.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '')
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = line.match(/^\s*/)[0].length
    const body = line.trim()
    const li = body.match(/^-\s*id:\s*(.+?)\s*$/)
    if (li) {
      const path = stack.filter(s => s.indent < indent).map(s => s.key)
      if (path.length === 4 && path[0] === 'llm-pi-ai' && path[1] === 'providers' && path[3] === 'models') {
        if (!providers.has(path[2])) providers.set(path[2], new Set())
        providers.get(path[2]).add(unquote(li[1]))
      } else if (path.length === 2 && path[0] === 'llm-deepseek' && path[1] === 'models') {
        deepseek.add(unquote(li[1]))
      }
      continue
    }
    const kv = body.match(/^([^:]+):\s*(.*)$/)
    if (!kv) continue
    const key = unquote(kv[1].trim())
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key })
  }
  return { providers, deepseek }
}

// deepseek-official 内置集(4 个 id), 与 llm-deepseek.models 声明取并集
const OFFICIAL_MODELS = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'])

function checkModelRefs() {
  const settingsFile = join(DSH_HOME, 'settings.yaml')
  const settingsText = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : ''
  const { providers, deepseek } = parseSettingsModelCatalog(settingsText)
  const official = new Set([...OFFICIAL_MODELS, ...deepseek])
  const sessions = discoverSessions()
  if (!sessions.length) return

  // 每个顶层会话"当前生效"的 provider/model: 取最后一个 model/selection(若存在), 否则最后一个
  // request/header。子代理会话继承父会话模型(spawn 时决定), 跳过不查。
  const bad = new Set()
  const counts = { ok: 0, checked: 0, skipped: 0, unreadable: 0 }
  for (const s of sessions) {
    const sess = readTopLevelSession(s.file)
    if (sess.unreadable) { counts.unreadable++; continue }
    if (sess.subagent) { counts.skipped++; continue }
    let sel = null // 最后 model/selection
    let hdr = null // 最后 request/header
    for (const line of sess.text.split('\n')) {
      if (line.includes('"model/selection"')) {
        const p = line.match(/"provider":\s*"([^"]+)"/)
        const mo = line.match(/"model":\s*"([^"]+)"/)
        if (p && mo) sel = `${p[1]}/${mo[1]}`
      } else if (line.includes('"request/header"')) {
        const p = line.match(/"provider":\s*"([^"]+)"/)
        const mo = line.match(/"model":\s*"([^"]+)"/)
        if (p && mo) hdr = `${p[1]}/${mo[1]}`
      }
    }
    const ref = sel ?? hdr
    if (!ref) continue
    counts.checked++
    const idx = ref.indexOf('/')
    const provider = ref.slice(0, idx)
    const model = ref.slice(idx + 1)
    const valid = provider === 'deepseek-official' ? official.has(model) : (providers.get(provider)?.has(model) ?? false)
    if (valid) counts.ok++
    else bad.add(ref)
  }
  const unreadNote = counts.unreadable > 0 ? `, ${counts.unreadable} 个不可读` : ''
  if (bad.size) {
    report('model', 'blocker',
      `会话当前模型引用失效 provider/model: ${[...bad].slice(0, 10).join(', ')}${bad.size > 10 ? ' …' : ''}（顶层共扫描 ${counts.checked} 会话, ${counts.ok} 正常, 跳过子代理 ${counts.skipped}${unreadNote}）`,
      '运行 node scripts/fix-model-refs.mjs --list 预览, 再 --provider deepseek-official --model deepseek-flash 批量切换（0.1.5 起 selectModel 会同时写全局默认模型, 不留旧引用）; 或从 settings.yaml 恢复对应 provider/model 声明')
  } else if (counts.unreadable > 0) {
    report('model', 'warning',
      `模型引用检查未覆盖全部会话: ${counts.unreadable} 个会话不可读(其余核对 ${counts.checked} 个全部有效, 跳过子代理 ${counts.skipped})`,
      '确认 zstd CLI 可用、会话文件未损坏; node scripts/repair-v0-sessions.mjs --list 会列出不可修复项')
  } else {
    report('model', 'ok', `会话当前模型引用全部有效（顶层共扫描 ${counts.checked} 会话, 跳过子代理 ${counts.skipped}）`, '')
  }
}

// ---------- 5. 会话文件发现(模型检查与事件检查共用) ----------
// 每个 session 目录优先 session.v3.jsonl.zstd(0.1.5 V3), 否则 session.jsonl.zstd(旧格式)
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
      const v3File = join(dir, 'session.v3.jsonl.zstd')
      const v2File = join(dir, 'session.jsonl.zstd')
      const hasV3 = existsSync(v3File)
      const hasV2 = existsSync(v2File)
      if (!hasV3 && !hasV2) continue
      out.push({ dir, file: hasV3 ? v3File : v2File, hasV3, hasV2 })
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

// 读取会话头并跳过子代理会话; 返回 { text, header } | { subagent: true } | { unreadable: true }
function readTopLevelSession(file) {
  const text = readSessionText(file)
  if (text === null) return { unreadable: true }
  const firstLine = text.split('\n', 1)[0] ?? ''
  let header = null
  try {
    header = JSON.parse(firstLine)
  } catch {
    // 头行损坏时用特征正则兜底, 避免把子代理会话当顶层会话
    header = {
      origin: /"origin"\s*:\s*"subagent"/.test(firstLine) ? 'subagent' : undefined,
      kind: /"kind"\s*:\s*"subagent"/.test(firstLine) ? 'subagent' : undefined,
      delegationDepth: Number((/"delegationDepth"\s*:\s*(\d+)/.exec(firstLine) ?? [])[1] ?? 0),
      parentSession: /"parentSession"\s*:\s*"/.test(firstLine) ? 'unknown' : undefined,
    }
  }
  if (isSubagentHeader(header)) return { subagent: true, text }
  return { text, header }
}

// ---------- 6. 未知事件类型统计 + v0 可迁移性(v2/v3 都扫) ----------
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

function checkEventTypes(checkMigration = false) {
  const sessions = discoverSessions()
  if (!sessions.length) return
  const unknownMap = new Map()
  const counts = { total: 0, skipped: 0, unreadable: 0 }
  const migr = {
    sessions: new Set(), summary: 0, descriptor: 0, replay: 0,
    tailSessions: new Set(), tailSummary: 0, tailDescriptor: 0, tailReplay: 0,
  }
  for (const s of sessions) {
    const sess = readTopLevelSession(s.file)
    if (sess.unreadable) { counts.unreadable++; continue }
    if (checkMigration && !s.hasV3) {
      const d = detectV0RefusalPatterns(sess.text)
      const c = d.committed.summary + d.committed.descriptor + d.committed.replay
      const t = d.tail.summary + d.tail.descriptor + d.tail.replay
      if (c > 0) {
        migr.sessions.add(s.file)
        migr.summary += d.committed.summary
        migr.descriptor += d.committed.descriptor
        migr.replay += d.committed.replay
      }
      if (t > 0) {
        migr.tailSessions.add(s.file)
        migr.tailSummary += d.tail.summary
        migr.tailDescriptor += d.tail.descriptor
        migr.tailReplay += d.tail.replay
      }
    }
    if (sess.subagent) { counts.skipped++; continue }
    for (const line of sess.text.split('\n')) {
      if (!line.includes('"type"')) continue
      // 只认行首的顶层 type(事件/记录行的 type 均为第一个键), 避免嵌套 JSON 的 type 误报
      const m = line.match(/^\s*\{\s*"type"\s*:\s*"([^"]+)"/)
      if (!m || KNOWN_EVENT_TYPES.has(m[1])) continue
      unknownMap.set(m[1], (unknownMap.get(m[1]) || 0) + 1)
    }
    counts.total++
  }
  // 不可读会话必须显式告警: 否则 zstd 缺失/文件损坏时会"全绿"(所有检查都 0 会话)
  if (!ZSTD_OK) {
    report('events', 'warning', 'zstd CLI 不可用: 会话事件类型与 v0 可迁移性检查全部跳过',
      '安装 zstd 后重跑(dsh 会话日志依赖 zstd 解压); 模型引用与配置检查不受影响')
  } else if (counts.unreadable > 0) {
    report('events', 'warning',
      `${counts.unreadable} 个会话日志不可读(zstd 解压失败或文件损坏), 事件类型与迁移检查未覆盖它们`,
      '确认会话文件未损坏; node scripts/repair-v0-sessions.mjs --list 会列出不可修复项')
  }
  if (unknownMap.size) {
    const list = [...unknownMap.entries()].map(([t, n]) => `${t}×${n}`).slice(0, 8).join(', ')
    report('events', 'warning',
      `未知事件类型(第三方插件扩展时属正常): ${list}（扫描 ${counts.total} 个顶层会话, 跳过子代理 ${counts.skipped}, 不可读 ${counts.unreadable}）`,
      '第三方扩展用 verify-session.mjs --ignore-type; 若属官方新类型则更新其 KNOWN_TYPES 快照')
  } else if (counts.total === 0 && counts.unreadable > 0) {
    report('events', 'warning', `会话事件检查未执行: ${counts.unreadable} 个会话全部不可读`,
      '确认 zstd CLI 可用且会话文件未损坏; 不要据此认为事件类型无问题')
  } else {
    report('events', 'ok', `全量扫描 ${counts.total} 个顶层会话日志(v2/v3 皆含), 事件类型均在已知全集${counts.unreadable ? `(另有 ${counts.unreadable} 个不可读)` : ''}`, '')
  }
  if (checkMigration) {
    const total = migr.summary + migr.descriptor + migr.replay
    const tailTotal = migr.tailSummary + migr.tailDescriptor + migr.tailReplay
    if (total > 0) {
      report('migration', 'blocker',
        `v0 会话含 0.1.5 迁移器拒绝的历史形态(打开即 resume failed): source.summary×${migr.summary}, descriptor v2×${migr.descriptor}, 平铺 replayState×${migr.replay}（涉及 ${migr.sessions.size} 个会话, 含子代理）`,
        `node ${join(SCRIPT_DIR, 'repair-v0-sessions.mjs')} --list 预览; 确认已有 sessions.bak-* 备份后加 --apply 修复（离线全链路校验 + 原子替换）`)
    } else if (tailTotal > 0) {
      report('migration', 'warning',
        `v0 会话尾部含旧形态记录(未提交, 打开时会静默丢弃该行, 不影响打开): summary×${migr.tailSummary}, descriptor v2×${migr.tailDescriptor}, 平铺 replayState×${migr.tailReplay}（涉及 ${migr.tailSessions.size} 个会话）`,
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

// ---------- 7. V3 迁移概览(0.1.5+) ----------
function checkV3Migration() {
  const sessRoot = join(DSH_HOME, 'sessions')
  if (!existsSync(sessRoot)) return
  const sessions = discoverSessions()
  let v3 = 0
  let v3KeepV2 = 0
  let v2Only = 0
  for (const s of sessions) {
    if (s.hasV3) { v3++; if (s.hasV2) v3KeepV2++ }
    else if (s.hasV2) v2Only++
  }
  report('v3', 'info',
    `V3 会话 ${v3} 个（其中 ${v3KeepV2} 个保留 v2 原文件）; V2 待惰性迁移 ${v2Only} 个`,
    '升级前备份 ~/.dsh/sessions（V3 不支持降级读取）; 新会话为原生 V3-only; 旧会话打开时惰性迁移')
}

// ---------- 主流程 ----------
const ver = checkVersion()
const tooOld = ver.semver !== null && cmpSemver(ver.semver, MIN_CHECK_VERSION) < 0
let runV15 = true
if (tooOld) {
  report('version', 'info',
    `当前版本 ${ver.raw} 未达最低检查版本 0.1.2-rc.1; 本体检针对 0.1.2+ 破坏面, 已跳过后续检查`,
    '如需升级: npm i -g @deepseek-ai/dsh@0.1.5-rc.1 后按 dsh 官方流程重启（本机无需按本技能修复）')
} else {
  if (ver.semver === null) {
    report('version', 'warning',
      `无法解析 dsh 版本(${ver.raw ?? 'dsh --version 无输出'}); 将尽力执行全部检查, 不静默跳过`,
      '确认 dsh 已安装且在 PATH; 手工执行 dsh --version 核对')
    runV15 = true
  } else {
    runV15 = cmpSemver(ver.semver, V15_VERSION) >= 0
    if (cmpSemver(ver.semver, V15_VERSION) > 0) {
      report('version', 'warning',
        `当前版本 ${ver.raw} 高于检查集最新覆盖的 0.1.5-rc.1; 检查可能漏检更高版本的新破坏面`,
        '关注官方 changelog; 发现问题后更新本技能的 pattern/检查集')
    }
  }
  scanSources(runV15)
  checkDeadPatch(PROFILE)
  checkModelRefs()
  checkEventTypes(runV15)
  if (runV15) checkV3Migration()
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
