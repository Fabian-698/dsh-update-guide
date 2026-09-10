#!/usr/bin/env node
/**
 * dsh-verify-patch-surface: 「对官方行干预」的上游契约 + 快照漂移闸门
 * （社区 dsh-tui 的 verify:patch-surface 范式落地，2026-08-16）。
 *
 * 背景：发行版/预设 patch 大量用顶层 `- id: xx disabled: true` / `- id: xx config: {...}`
 * 干预官方 bundle 行（TUI 23 个 disabled、oh-dsh 换 webserver、mirage 换 fs/shell）。
 * 官方一发版（改名/删键/拆条目），你的干预会**静默失效**——本闸门把干预面快照化，
 * 上游一变化就爆，不再无声腐烂。
 *
 * 两个 seam：
 *  S1 上游契约 —— 干预的 id 必须仍在装配参照树里（--dump-default-config 默认树
 *     ∪ --dump-config 最终树；官方改名/删行/来源 bundle 移除 = 死干预 = FAIL）；
 *     override 的 config 键须能对照该条目已知键集（未知键 WARN：新可选键 vs 拼错）。
 *  S2 快照漂移 —— --snapshot <file> 记录干预面 JSON；--check 对比当前面，
 *     增/删/改任一干预即 FAIL（CI 用：本地误改、上游发版都会爆；--update 刷新快照）。
 *
 * 用法：
 *   node verify-patch-surface.mjs [--profile web] [--patch <file>] \
 *        [--snapshot <json-file>] [--check | --update] [--json]
 *   --check   只对比快照不写（快照缺失 = FAIL）；漂移 = FAIL
 *   --update  用当前面覆盖快照（exit 0）
 *   （不带 --check/--update 且给了 --snapshot：文件存在→报漂移不写；不存在→写入）
 *   默认无 --snapshot：只跑 S1 契约 + 打印干预面
 * 退出码：0=通过；1=FAIL（契约破坏/快照漂移/参数错误）。依赖真实 dsh（dump-default-config）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`dsh-verify-patch-surface: 对官方行干预的上游契约 + 快照漂移闸门
用法: node verify-patch-surface.mjs [--profile web] [--patch <file>] [--snapshot <json-file>] [--check | --update] [--json]
  --check  只对比快照不写（快照缺失/漂移 = FAIL）
  --update 用当前面覆盖快照
  --json   输出 JSON
退出码: 0=通过；1=FAIL（契约破坏/快照漂移/参数错误）`)
  process.exit(0)
}
const arg = (flag, fallback) => {
  const eq = argv.find((a) => a.startsWith(`${flag}=`))
  if (eq) return eq.slice(flag.length + 1)
  const idx = argv.indexOf(flag)
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1]
  return fallback
}
const PROFILE = arg('--profile', 'web')
const PATCH_FILE = arg('--patch', join(homedir(), '.dsh', 'profiles', PROFILE, 'cordis.patch.yml'))
const SNAPSHOT = arg('--snapshot', '')
const CHECK = argv.includes('--check')
const UPDATE = argv.includes('--update')
const JSON_OUT = argv.includes('--json')

let failed = 0
const results = [] // {kind:'FAIL'|'WARN'|'INFO'|'PASS'|'SKIP', label, extra}
const emit = (kind, label, extra = '') => { results.push({ kind, label, extra }); if (kind === 'FAIL') failed++ }

// ---------- dsh 自动探测（与 verify-patch 同一逻辑） ----------
function probeDsh() {
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN
  const fromPath = spawnSync('which', ['dsh'], { encoding: 'utf8' })
  if (fromPath.status === 0 && fromPath.stdout.trim()) return fromPath.stdout.trim()
  for (const base of [`${process.env.HOME}/.nvm/versions/node/v24.19.0`, '/usr/local', '/usr']) {
    const cand = join(base, 'bin', 'dsh')
    if (existsSync(cand)) return cand
  }
  return null
}
const DSH = probeDsh()
if (!DSH) {
  console.error('dsh-verify-patch-surface: 找不到 dsh 可执行文件（设置 DSH_BIN 环境变量）')
  process.exit(1)
}

// ---------- js-yaml + !!js 表达式解析（与 verify-patch 同构） ----------
function resolveDshModule(rel) {
  try {
    const real = realpathSync(DSH)
    const pkgRoot = dirname(dirname(real))
    const cand = join(pkgRoot, 'node_modules', rel)
    return existsSync(cand) ? cand : null
  } catch {
    return null
  }
}
const JS_YAML_ENTRY = resolveDshModule('js-yaml/index.js')
let yaml = null
if (JS_YAML_ENTRY) {
  try { ({ default: yaml } = await import(`file://${JS_YAML_ENTRY}`)) } catch { yaml = null }
}
let entries = []
if (yaml) {
  const JsExprType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', resolve: () => true, construct: (d) => ({ __jsExpr: d }),
  })
  try {
    entries = yaml.load(readFileSync(PATCH_FILE, 'utf8'), { schema: yaml.JSON_SCHEMA.extend(JsExprType) })
  } catch (e) {
    emit('FAIL', `patch YAML 可解析（${PATCH_FILE}）`, e.message.split('\n')[0])
  }
} else {
  emit('FAIL', 'js-yaml 可用（verify-patch-surface 依赖 dsh 安装内的 js-yaml）')
}
if (!Array.isArray(entries)) entries = []

// ---------- 插值（baseUrl 注入，复刻 verify-patch） ----------
const evaluate = (expr) => new Function('baseUrl', `return (${expr})`)(existsSync(PATCH_FILE) ? `file://${realpathSync(PATCH_FILE)}` : undefined) // eslint-disable-line no-new-func
const interpolate = (value) => {
  if (value && typeof value === 'object' && '__jsExpr' in value) return evaluate(value.__jsExpr)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(interpolate)
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = interpolate(v)
  return out
}

// ---------- 提取干预面 ----------
// 干预 = ①顶层非 insert 行（disabled / config 覆写）②insert 官方 bundle 行（@deepseek-ai/*）
const surface = []
for (const p of entries) {
  if (!p || typeof p !== 'object') continue
  const topId = p.id
  const keys = p.config && typeof p.config === 'object' ? Object.keys(p.config).filter((k) => k !== 'disabled') : []
  if (topId && !Array.isArray(p.insert)) {
    const kind = p.disabled !== undefined && p.disabled !== false ? 'disabled' : keys.length ? 'override' : 'row'
    if (kind !== 'row') surface.push({ id: topId, kind, keys: keys.sort() })
  }
  if (Array.isArray(p.insert)) {
    for (const it of p.insert) {
      if (!it || !it.id) continue
      const iKeys = it.config && typeof it.config === 'object' ? Object.keys(it.config) : []
      surface.push({
        id: it.id,
        kind: typeof it.name === 'string' && it.name.startsWith('@deepseek-ai/') ? 'insert-official' : 'insert-third',
        name: it.name ?? '',
        keys: iKeys.sort(),
      })
    }
  }
}
// 确定性排序（快照可比对）
surface.sort((a, b) => `${a.id}:${a.kind}`.localeCompare(`${b.id}:${b.kind}`))

// ---------- S1 上游契约（对默认树 ∪ 最终装配树） ----------
// 参照系说明：干预目标可能来自官方默认行（dump-default-config）或其它 bundle 的
// insert（只在 dump-config 最终树可见）。两条树都查，两边都不在 = 死干预
// （官方删行 / 来源 bundle 已移除 → 你的 disabled/override 静默失效）。
let defaultTree = null
let finalTree = null
function parseTree(text) {
  const tree = new Map()
  let cur = null
  for (const line of String(text).split('\n')) {
    const m = line.match(/^- id: (\S+)/)
    if (m) { cur = { id: m[1], keys: new Set() }; tree.set(cur.id, cur); continue }
    if (!cur) continue
    const ind = (line.match(/^(\s*)/) ?? ['', ''])[1].length
    if (ind === 2) {
      const key = line.trim().split(':')[0]
      if (key !== 'config' && key !== 'disabled') cur.keys.add(key)
    } else if (ind === 4) {
      const key = line.trim().split(':')[0]
      cur.keys.add(key)
    }
  }
  return tree
}
const defRes = spawnSync(DSH, ['--profile', PROFILE, '--dump-default-config'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const finRes = spawnSync(DSH, ['--profile', PROFILE, '--dump-config'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
if (defRes.status !== 0 || /plugin tree failed|ValidationError/.test(defRes.stderr ?? '') || (finRes.status ?? 1) !== 0 || /plugin tree failed|ValidationError/.test(finRes.stderr ?? '')) {
  emit('SKIP', 'S1 上游契约（dump-default-config / dump-config 失败）', '环境受限或装配异常，快照机制不受影响')
} else {
  defaultTree = parseTree(defRes.stdout)
  finalTree = parseTree(finRes.stdout)
  const intervened = surface.filter((s) => s.kind === 'disabled' || s.kind === 'override')
  for (const s of intervened) {
    const def = defaultTree.get(s.id)
    const fin = finalTree.get(s.id)
    if (!def && !fin) {
      emit('FAIL', `S1 上游契约: ${s.id}（${s.kind}）既不在默认树也不在最终装配树`, '死干预：官方删行或来源 bundle 已移除 → 你的 disabled/override 静默失效；删掉这行或确认对应 bundle 是否还在')
      continue
    }
    if (s.kind === 'override') {
      const base = def ?? fin ?? { keys: new Set() }
      const unknown = s.keys.filter((k) => !base.keys.has(k))
      if (unknown.length) emit('WARN', `S1 上游契约: ${s.id} 覆写键不在该条目已知键集`, `${unknown.join(', ')}（新可选键合法；疑拼错则静默回退默认——modsearch 教训）`)
    }
  }
  if (intervened.length === 0) emit('INFO', 'S1 上游契约: 无 disabled/override 干预', '该 patch 只做 insert（新增实例），无上游契约面')
  else emit('PASS', `S1 上游契约: ${intervened.length} 条干预 id 命中默认树或最终树`, '')
}

// ---------- S2 快照漂移 ----------
function snapshotBody() {
  return { tool: 'dsh-verify-patch-surface', profile: PROFILE, patch: PATCH_FILE, surface }
}
if (SNAPSHOT) {
  if (existsSync(SNAPSHOT) && !CHECK && !UPDATE) {
    const prev = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    const cur = JSON.stringify(snapshotBody().surface)
    if (prev.surface && JSON.stringify(prev.surface) !== cur) {
      emit('FAIL', `S2 快照漂移（--snapshot 已存在且无 --check/--update）`, '干预面变了：用 --update 刷新，或 --check 看明细')
    } else {
      emit('PASS', 'S2 快照与当前干预面一致', '')
    }
  } else if (CHECK) {
    if (!existsSync(SNAPSHOT)) {
      emit('FAIL', 'S2 快照缺失（--check 需要既有快照）', '先跑一次不带 --check 的 --snapshot 生成基线')
    } else {
      const prev = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
      const a = prev.surface ?? []
      const b = snapshotBody().surface
      const sig = (s) => `${s.id}|${s.kind}|${s.name ?? ''}|${(s.keys ?? []).join(',')}`
      const ma = new Map(a.map((s) => [sig(s), s]))
      const mb = new Map(b.map((s) => [sig(s), s]))
      const added = b.filter((s) => !ma.has(sig(s))).map((s) => `${s.id}[${s.kind}]`)
      const removed = a.filter((s) => !mb.has(sig(s))).map((s) => `${s.id}[${s.kind}]`)
      const drift = [...added, ...removed]
      if (drift.length) emit('FAIL', 'S2 快照漂移', `新增: ${added.join(', ') || '无'}；移除: ${removed.join(', ') || '无'}（上游发版或本地改动——人工确认后用 --update 刷新）`)
      else emit('PASS', 'S2 快照无漂移（干预面与基线一致）', `${a.length} 条干预`)
    }
  } else if (UPDATE) {
    writeFileSync(SNAPSHOT, JSON.stringify(snapshotBody(), null, 2) + '\n')
    emit('PASS', `S2 快照已刷新（${surface.length} 条干预）→ ${SNAPSHOT}`, '')
  } else {
    // 文件不存在且无 --check/--update：写基线（首次使用）
    writeFileSync(SNAPSHOT, JSON.stringify(snapshotBody(), null, 2) + '\n')
    emit('PASS', `S2 基线快照已创建（${surface.length} 条干预）→ ${SNAPSHOT}`, '首次使用；下次 --check 对比')
  }
}

// ---------- 输出 ----------
if (JSON_OUT) {
  console.log(JSON.stringify({ profile: PROFILE, failed, results, surface }, null, 2))
} else {
  console.log(`== dsh-verify-patch-surface: profile=${PROFILE} patch=${PATCH_FILE} dsh=${DSH}`)
  for (const s of surface) console.log(`   ${s.kind.padEnd(15)} ${s.id}${s.name ? `  name=${s.name}` : ''}${s.keys.length ? `  keys=[${s.keys.join(',')}]` : ''}`)
  console.log('')
  for (const r of results) console.log(`${r.kind.padEnd(5)} ${r.label}${r.extra ? `  [${r.extra}]` : ''}`)
  console.log(`\n== 结果：${failed === 0 ? 'ALL PASS' : failed + ' FAILED — 先核对干预面/快照'}`)
}
process.exit(failed === 0 ? 0 : 1)