#!/usr/bin/env node
/**
 * dsh-upgrade-fix-012 scan: 一键体检 dsh 0.1.2-rc.1 升级断链。
 *
 * 在哪里用:任何一台刚升级到 dsh 0.1.2-rc.1(或 0.1.2 系)的机器,先跑本脚本,
 * 输出问题清单,再按 SKILL.md 逐项修复。
 *
 * 检测项:
 *   1. 版本核对            dsh --version 是否 >= 0.1.2-rc.1(低于说明还没升级,无需修)
 *   2. 旧 API 残留         自定义 preset / 本地插件里的 `session.events`、`header.seedLength`、
 *                         `header-delta`、`reason:"fallback"`(0.1.2 已移除/拒绝)等模式。
 *                         已带新 API 兼容层(先探 snapshotEvents/eventAt/typertGateway 再回退)
 *                         的文件自动降级为 info,不算断链。
 *   3. 第三方插件断链      profile node_modules 里非官方包引用
 *                         `session.events`(无兼容层)、`ctx.subagents.registerContinuableSetup` 等
 *   4. 配置死干预          cordis.patch.yml 顶层 disabled 行对应的 id 不在默认树里
 *                         (dump-config 出现 `entry "xxx" not found` 即死干预)
 *   5. 失效模型引用        会话当前生效的 provider/model 不在 settings.yaml 已配置的
 *                         providers(含 deepseek-official 官方模型集)内 —— 旧引擎报 UNKNOWN_MODEL
 *   6. 未知事件类型        会话日志中出现非已知全集的事件类型
 *                         (仅统计,具体校验交给 verify-session.mjs)
 *
 * 用法:
 *   node scan-upgrade.mjs [--dsh-home ~/.dsh] [--json]
 * 退出码: 0 = 无阻断问题; 1 = 发现需修复的问题。
 *
 * 依赖: zstd CLI(解压会话)、dsh CLI(版本/dump,可选降级)。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ARGV = process.argv.slice(2)
const jsonOut = ARGV.includes('--json')
let DSH_HOME = homedir() + '/.dsh'
const homeIdx = ARGV.indexOf('--dsh-home')
if (homeIdx >= 0 && ARGV[homeIdx + 1]) DSH_HOME = resolve(ARGV[homeIdx + 1])

// ---------- 已知事件类型全集(0.1.2-rc.1 官方 known-event-types.js + 存储记录层类型) ----------
const KNOWN_EVENT_TYPES = new Set([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided',
  'approval/policy', 'assistant/chunk', 'assistant/message', 'command/done', 'command/run',
  'compaction/end', 'compaction/prune', 'compaction/start', 'compaction/summary',
  'feedback/record', 'goal/change', 'hook/invoked', 'hook/result', 'llm/retry',
  'llm/retry-started', 'model/selection', 'permission/preset', 'plan/mode',
  'request/context', 'request/header', 'sandbox/mode', 'schedule/change',
  'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title',
  'session/title-llm-request', 'step/end', 'step/start', 'subagent/descriptor',
  'subagent/model-selection-policy', 'team/member', 'team/task', 'todo/write',
  'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end',
  'tool-workflow/run-start', 'tool/call', 'tool/code-dispatch', 'tool/code-dispatch-start',
  'tool/result', 'turn/end', 'turn/start', 'user/message',
  'web/deepseek-search-llm-request',
  // 存储记录层(非事件,verify-session.mjs 同样纳入):
  'session', 'reasoning-chunks', 'text-chunks', 'tool-call-chunks',
])

// ---------- 输出 ----------
const issues = [] // {category, severity: 'blocker'|'warning'|'info', detail, fix}
function report(category, severity, detail, fix) {
  issues.push({ category, severity, detail, fix })
}

// ---------- 1. 版本核对 ----------
function checkVersion() {
  const r = spawnSync('dsh', ['--version'], { encoding: 'utf8', env: { ...process.env, DSH_HOME } })
  const v = (r.stdout || '').trim() || (r.stderr || '').trim()
  if (!v) {
    report('version', 'warning', '无法取得 dsh --version(dsh 不在 PATH 或未安装?)', '确认本机已安装 dsh 后再体检')
    return null
  }
  if (!/0\.1\.2/.test(v)) {
    report('version', 'info', `当前版本 ${v} 未达 0.1.2-rc.1;本体检针对 0.1.2 破坏面,未升级则跳过剩余项`, '如需升级:npm i -g @deepseek-ai/dsh@0.1.2-rc.1 后按 dsh 官方流程重启')
    return { v, skip: true }
  }
  return { v, skip: false }
}

// ---------- 2/3. 源码模式扫描 ----------
// 每条: 旧模式(正则), 新 API 兼容层探测词(文件同含则降 info), 严重级别, 修复指引
const PATTERNS = [
  {
    name: 'session.events', re: /session\s*\.\s*events\b/g, adapter: ['snapshotEvents'],
    severity: 'blocker',
    fix: '替换为 session.snapshotEvents()(全量快照)或 session.eventAt(seq)(单条);见 references/fix-patterns.md',
  },
  {
    name: 'header.seedLength', re: /(?:session\.)?header\.seedLength\b/g, adapter: ['isSeeded'],
    severity: 'warning',
    fix: '旧会话 header 由 fromHeaderLine() 归一化(isSeeded);读取端改 isSeeded 字段,勿依赖 seedLength',
  },
  {
    name: 'request/header-delta', re: /header-delta\b/g, adapter: [],
    severity: 'blocker',
    fix: '0.1.2 已拒绝该请求头(assertSupportedRequestHeader);正常会话无需构造,旧构造删除',
  },
  {
    name: 'reason:"fallback"', re: /reason\s*[:=]\s*["']?fallback/g, adapter: [],
    severity: 'blocker',
    fix: '0.1.2 已拒绝 fallback 原因(assertSupportedRequestHeader);删除该构造',
  },
  {
    name: 'registerContinuableSetup', re: /registerContinuableSetup\b/g, adapter: [],
    severity: 'warning',
    fix: '第三方插件(如 @nanmicoder/dsh-agent-teams 0.1.15)未适配 0.1.2 的 subagent API;保持该插件 disabled 等上游适配',
  },
  {
    name: 'apiProxy', re: /\bapiProxy\b/g, adapter: ['typertGateway'],
    severity: 'warning',
    fix: '官方已移除 apiProxy 服务(迁移为 typertGateway);文件若已有 typertGateway 探测分支则已适配,否则插件需升级适配',
  },
]

// 只扫"实际装配的入口",不扫源码头(plugin-src/src 是未打包源码,入口在 lib/)
// 已禁用插件(dsh-market state.json / cordis.patch.yml disabled 行)源码残留 = 启用时才会崩,
// 降级为 warning(保持 disabled 即可),不阻断。
function loadDisabledPackages() {
  const disabled = new Set()
  try {
    const state = JSON.parse(readFileSync(join(DSH_HOME, 'profiles', 'web', '.dsh-market', 'state.json'), 'utf8'))
    for (const d of state.disabled ?? []) disabled.add(d)
  } catch { /* 无 market state 不降级 */ }
  try {
    const patch = readFileSync(join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
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

function scanSources() {
  const roots = [
    { root: join(DSH_HOME, '.agent-presets'), skipSub: ['node_modules'] },
    { root: join(DSH_HOME, 'plugins'), skipSub: ['node_modules'] },
    { root: join(DSH_HOME, 'profiles', 'web', 'node_modules'), skipSub: ['.pnpm'] },
  ]
  const seen = new Set()
  const disabledPkgs = loadDisabledPackages()
  for (const { root, skipSub } of roots) {
    if (!existsSync(root)) continue
    const files = []
    const walk = (d, depth) => {
      if (depth > 6) return
      let ents = []
      try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        const p = join(d, e.name)
        if (e.name === 'node_modules' || e.name === '.pnpm' || e.name === 'plugin-src' || e.name === 'src' || e.name.startsWith('.') || e.name.includes('.min.') || e.name.endsWith('.map')) continue
        if (e.isDirectory()) walk(p, depth + 1)
        else if (/\.(mjs|js|cjs)$/.test(e.name)) files.push(p)
      }
    }
    walk(root, 0)
    for (const f of files) {
      const key = f
      if (seen.has(key)) continue
      seen.add(key)
      let text
      try {
        const st = statSync(f)
        if (st.size > 6 * 1024 * 1024) continue
        text = readFileSync(f, 'utf8')
      } catch { continue }
      for (const pat of PATTERNS) {
        const hits = [...text.matchAll(pat.re)]
        if (!hits.length) continue
        // 只统计非注释行(行首 // /* * # 的跳过);一个文件报一次
        const nonComment = hits.some(mm => {
          const line = text.slice(0, mm.index).split('\n').pop()
          return !/^\s*(\/\/|\*|#|\/\*)/.test(line.trim())
        })
        if (!nonComment) continue
        // 兼容层判定:文件里出现新 API 探测词 → 这是"先探测新 API 再回退"的适配写法,降级
        const hasAdapter = pat.adapter.some(a => text.includes(a))
        let sev = hasAdapter ? 'info' : pat.severity
        // 已禁用插件的源码残留:启用前不会触发,降级 warning
        const pkgName = packageBelongsToFile(f)
        if (sev === 'blocker' && pkgName) {
          const p = pkgName.split('/').pop() ?? pkgName
          if (disabledPkgs.has(pkgName) || disabledPkgs.has(p) || disabledPkgs.has(pkgName.replace(/^dsh-/, '')) || disabledPkgs.has(p.replace(/^dsh-/, ''))) {
            sev = 'warning'
            report('source', 'warning', `${pat.name}(已禁用插件源码,启用时才会触发) → ${f.replace(DSH_HOME, '~/.dsh')}`,
              `该插件(包 ${pkgName})当前被禁用:保持 disabled 即可;若要启用,先找作者适配版或自行改 API(见 fix-patterns.md)`)
            continue
          }
        }
        if (sev === 'info') {
          report('source', 'info', `${pat.name}(兼容层) → ${f.replace(DSH_HOME, '~/.dsh')}`, '已含兼容层(探测新 API 后回退),非断链')
          continue
        }
        report('source', sev, `${pat.name} → ${f.replace(DSH_HOME, '~/.dsh')}`, pat.fix)
      }
    }
  }
}

// ---------- 4. 配置死干预 ----------
function checkDeadPatch() {
  const patchFile = join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
  if (!existsSync(patchFile)) return
  const r = spawnSync('dsh', ['--profile', 'web', '--dump-config'], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME }, maxBuffer: 32 * 1024 * 1024,
  })
  const notFound = [...(r.stderr || '').matchAll(/patch:\s*entry\s+"([^"]+)"\s+not found/g)].map(m => m[1])
  if (notFound.length) {
    for (const id of new Set(notFound)) {
      report('config', 'warning', `死干预行 - id: ${id}(对应 bundle 已不在装配树)` , `从 cordis.patch.yml 删除该行;profile 级 patch 改动需重启 dsh web 生效`)
    }
  } else {
    report('config', 'ok', '无死干预行(dump-config 无 entry not found)', '')
  }
}

// ---------- 5. 失效模型引用 ----------
// 解析 settings.yaml 的 llm-pi-ai.providers.<name>.models[*].id;deepseek-official 为官方内置
// settings.yaml 缩进: llm-pi-ai(0) → providers(2) → <name>(4) → models(6) → - id(8)
function parseProviders(settingsText) {
  const providers = new Map() // name -> Set(modelId)
  let curName = null
  for (const line of settingsText.split('\n')) {
    const pm = line.match(/^    (\S+):\s*$/) // provider 名(4 空格)
    if (pm) { curName = pm[1]; providers.set(curName, new Set()); continue }
    if (curName !== null) {
      const mm = line.match(/^        - id:\s*(\S+)/) // 8 空格: - id: xxx
      if (mm) providers.get(curName).add(mm[1])
      else if (/^  \S+:/.test(line)) curName = null // 回到 2 空格层级(如 providers:),退出
    }
  }
  return providers
}

const OFFICIAL_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'])

function checkModelRefs() {
  const settingsFile = join(DSH_HOME, 'settings.yaml')
  const settingsText = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : ''
  const providers = parseProviders(settingsText)
  const sessRoot = join(DSH_HOME, 'sessions')
  if (!existsSync(sessRoot)) return

  // 每个顶层会话 "当前生效" 的 provider/model: 取最后一个 model/selection(若存在),否则最后一个
  // request/header。子代理会话继承父会话模型(spawn 时决定),跳过不查。
  const bad = new Set()
  const counts = { ok: 0, checked: 0, skipped: 0 }
  for (const ws of readdirSync(sessRoot)) {
    const wd = join(sessRoot, ws)
    if (!statSync(wd).isDirectory()) continue
    for (const sd of readdirSync(wd)) {
      const f = join(wd, sd, 'session.jsonl.zstd')
      if (!existsSync(f)) continue
      const r = spawnSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 90_000 })
      if (r.status !== 0) continue
      const firstLine = r.stdout.split('\n', 1)[0] ?? ''
      if (/"origin"\s*:\s*"subagent"/.test(firstLine) || /"kind"\s*:\s*"subagent"/.test(firstLine)) { counts.skipped++; continue }
      let sel = null // 最后 model/selection
      let hdr = null // 最后 request/header
      for (const line of r.stdout.split('\n')) {
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
      const [provider, model] = ref.split('/')
      let valid
      if (provider === 'deepseek-official') valid = OFFICIAL_MODELS.has(model)
      else valid = providers.get(provider)?.has(model) ?? false
      if (valid) counts.ok++
      else bad.add(ref)
    }
  }
  if (bad.size) {
    report('model', 'blocker', `会话当前模型引用失效 provider/model: ${[...bad].slice(0, 10).join(', ')}${bad.size > 10 ? ' …' : ''}（顶层共扫描 ${counts.checked} 会话,${counts.ok} 正常,跳过子代理 ${counts.skipped}）`,
      '用 session/selectModel 会话级切换(参考 fix-patterns.md;统一切 deepseek-official/deepseek-v4-flash);或从 settings.yaml 恢复对应 provider 配置')
  } else {
    report('model', 'ok', `会话当前模型引用全部有效(顶层共扫描 ${counts.checked} 会话,跳过子代理 ${counts.skipped})`, '')
  }
}

// ---------- 6. 未知事件类型统计 ----------
function checkEventTypes() {
  const sessRoot = join(DSH_HOME, 'sessions')
  if (!existsSync(sessRoot)) return
  const unknownMap = new Map()
  let total = 0
  for (const ws of readdirSync(sessRoot)) {
    const wd = join(sessRoot, ws)
    if (!statSync(wd).isDirectory()) continue
    for (const sd of readdirSync(wd)) {
      const f = join(wd, sd, 'session.jsonl.zstd')
      if (!existsSync(f)) continue
      const r = spawnSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 90_000 })
      if (r.status !== 0) continue
      for (const line of r.stdout.split('\n')) {
        if (!line.includes('"type"')) continue
        const m = line.match(/"type":\s*"([^"]+)"/)
        if (!m || KNOWN_EVENT_TYPES.has(m[1])) continue
        unknownMap.set(m[1], (unknownMap.get(m[1]) || 0) + 1)
      }
      total++
    }
  }
  if (unknownMap.size) {
    const list = [...unknownMap.entries()].map(([t, n]) => `${t}×${n}`).slice(0, 8).join(', ')
    report('events', 'warning', `未知事件类型(第三方插件扩展时属正常): ${list}`, '第三方扩展用 verify-session.mjs --ignore-type;若属官方新类型则更新其 KNOWN_TYPES 快照')
  } else {
    report('events', 'ok', `全量扫描 ${total} 个会话日志,事件类型均在已知全集`, '')
  }
}

// ---------- 主流程 ----------
const ver = checkVersion()
if (!ver || ver.skip) {
  const out = jsonOut
    ? JSON.stringify({ version: ver?.v ?? null, issues, count: issues.length }, null, 2)
    : issues.map(i => `[${i.severity.toUpperCase()}] ${i.category}: ${i.detail}\n   修复: ${i.fix}`).join('\n') || '当前版本未达 0.1.2,无需处理'
  console.log(out)
  process.exit(0)
}
scanSources()
checkDeadPatch()
checkModelRefs()
checkEventTypes()

const blockers = issues.filter(i => i.severity === 'blocker').length
const warnings = issues.filter(i => i.severity === 'warning').length
const infos = issues.filter(i => i.severity === 'info').length
if (jsonOut) {
  console.log(JSON.stringify({ version: ver.v, issues, blocker: blockers, warning: warnings, info: infos }, null, 2))
} else {
  console.log(`dsh 版本: ${ver.v}`)
  for (const i of issues) {
    if (i.severity === 'ok' || i.severity === 'info') continue
    console.log(`[${i.severity.toUpperCase()}] ${i.category}: ${i.detail}`)
    console.log(`   修复: ${i.fix}`)
  }
  console.log(`\n体检完成: ${blockers} blocker / ${warnings} warning / ${infos} info`)
  if (blockers) console.log('发现阻断问题,按上表逐项修复(见 SKILL.md 修复章节),修复后重跑本脚本确认归零')
  else if (warnings) console.log('无阻断问题,剩余 warning 按需处理;建议再跑 verify-session.mjs --all 与 verify-patch.mjs --profile web 双闸门')
  else console.log('全部通过。建议: ① verify-session.mjs --all ② verify-patch.mjs --profile web 双闸门复核; ③ 打开任一旧会话抽查')
}
process.exit(blockers ? 1 : 0)
