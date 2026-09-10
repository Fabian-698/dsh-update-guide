#!/usr/bin/env node
/**
 * dsh-verify: DSH profile patch 通用装配验证（防崩闸门）。
 * 任何 patch/插件改动、任何重启之前先跑本脚本；有 FAIL 就不要重启。
 *
 * 覆盖三个 seam：
 *  T1 配置树装配 —— `dsh --profile <P> --dump-config` 必须 exit 0、
 *     且期望条目无 "entry not found" 跳过警告、条目必须在树里。
 *     （能抓住"非 insert 条目被 loader 静默跳过"这类配置）
 *  T2 config schema 校验 —— 把 patch 里 mcp 条目的 config 按 loader 语义
 *     求值（__jsExpr）后用 dsh-mcp-client 的 Config schema 做校验，
 *     在「带 token / 不带 token」两种环境下各跑一次。
 *     （能抓住真实事故：!!js process.env.X 求值 undefined →
 *      schemastery z.dict(String) 拒绝 → fail-loud 整树崩溃）
 *  T3 二进制握手 —— 配置引用的 stdio 命令必须存在、可执行、
 *     且 MCP initialize 握手能拿到 serverInfo。
 *
 * 用法：
 *   node verify-patch.mjs [--profile web] [--expect id1,id2] [--token-env NAME] [--patch path]
 *   --profile   目标 profile（默认 web）；--patch 指定 patch 文件（默认 <profile>/cordis.patch.yml）
 *   --expect    额外要求装配的条目 id（逗号分隔，可省略：自动发现 patch 里全部 insert 条目）
 *   --token-env 敏感环境变量名（逗号分隔，默认 GITHUB_PERSONAL_ACCESS_TOKEN；T2 对首个做带/不带双环境）
 *   DSH_BIN     环境变量可覆盖 dsh 可执行文件路径（否则自动探测）
 * 退出码：0 = 全部 PASS；1 = 有 FAIL（禁止重启）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------- 参数解析（支持 --flag value 与 --flag=value 两种形式） ----------
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`dsh-verify: DSH profile patch 装配验证（防崩闸门）
用法: node verify-patch.mjs [--profile web] [--expect id1,id2] [--token-env NAME] [--patch path] [--diff-default] [--tool-collision] [--no-net-probe]
  --profile  目标 profile（默认 web）
  --patch    指定 patch 文件（默认 <profile>/cordis.patch.yml）
  --expect   额外期望装配的条目 id（逗号分隔）
  --token-env 敏感环境变量名（逗号分隔，T2 对首个做带/不带双环境）
  --diff-default T1b 差异归因；--tool-collision T1c 工具名碰撞；--no-net-probe 关远程探针
  DSH_BIN 环境变量可覆盖 dsh 可执行文件路径
退出码: 0=全部 PASS（可重启）；1=有 FAIL（禁止重启）`)
  process.exit(0)
}
const arg = (flag, fallback) => {
  const eq = argv.find(a => a.startsWith(`${flag}=`))
  if (eq) return eq.slice(flag.length + 1)
  const idx = argv.indexOf(flag)
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1]
  return fallback
}
const PROFILE = arg('--profile', 'web')
const PATCH_FILE = arg('--patch', join(homedir(), '.dsh', 'profiles', PROFILE, 'cordis.patch.yml'))
const expectExtra = arg('--expect', '').split(',').filter(Boolean)
const tokenEnvs = arg('--token-env', 'GITHUB_PERSONAL_ACCESS_TOKEN').split(',').filter(Boolean)
const primaryTokenEnv = tokenEnvs[0]
const DIFF_DEFAULT = argv.includes('--diff-default')
const TOOL_COLLISION = argv.includes('--tool-collision')

// ---------- dsh 自动探测 ----------
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
  console.error('dsh-verify: 找不到 dsh 可执行文件（设置 DSH_BIN 环境变量）')
  process.exit(1)
}

// 从 dsh 安装解析 mcp-client 与 js-yaml（@deepseek-ai/dsh 包的 node_modules）
function resolveDshModule(rel) {
  try {
    const real = realpathSync(DSH) // .../lib/node_modules/@deepseek-ai/dsh/lib/bin.js
    const pkgRoot = dirname(dirname(real)) // .../lib/node_modules/@deepseek-ai/dsh
    const cand = join(pkgRoot, 'node_modules', rel)
    return existsSync(cand) ? cand : null
  } catch {
    return null
  }
}
const MCP_CLIENT_ENTRY = resolveDshModule('@deepseek-ai/dsh-mcp-client/lib/index.js')
const JS_YAML_ENTRY = resolveDshModule('js-yaml/index.js')

let failed = 0
const check = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  [${extra}]` : ''}`)
  if (!cond) failed++
}
/** SKIP/INFO 级输出：不进 failed 计数。 */
const report3 = (kind, label, extra = '') => {
  console.log(`${kind}  ${label}${extra ? `  [${extra}]` : ''}`)
}

console.log(`== dsh-verify: profile=${PROFILE} dsh=${DSH}`)
console.log(`== patch=${PATCH_FILE}`)

// ---------- 解析 patch（include 的 entry-list 方言：JSON_SCHEMA + !!js 表达式） ----------
let yaml, mcpClientMod
if (JS_YAML_ENTRY) {
  try { ({ default: yaml } = await import(`file://${JS_YAML_ENTRY}`)) } catch { yaml = null }
}
if (MCP_CLIENT_ENTRY) {
  try { ({ Config: mcpClientMod } = await import(`file://${MCP_CLIENT_ENTRY}`)) } catch { mcpClientMod = null }
}

const JsExprType = yaml ? new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', resolve: () => true, construct: (d) => ({ __jsExpr: d }),
}) : null
const entryListSchema = yaml ? yaml.JSON_SCHEMA.extend(JsExprType) : null

// ---------- T2-pre：!!js 表达式首字符不得为 !（YAML tag 属性重复崩溃，treg 实战红线） ----------
// `disabled: !!js !process.env.X` 里第二个 ! 会被 YAML 读成另一个 tag 属性 →
// "duplication of a tag property" → 整个 profile 解析失败（照抄即崩）。
// 修复写法：把表达式包进括号 —— !!js (!process.env.X)。
const patchRaw = existsSync(PATCH_FILE) ? readFileSync(PATCH_FILE, 'utf8') : ''
const bangJsLines = patchRaw.split('\n').map((l, i) => [i + 1, l]).filter(([_, l]) => !l.trim().startsWith('#') && /!!js\s*!/.test(l))
if (bangJsLines.length) {
  for (const [ln, l] of bangJsLines) {
    check(false, `!!js 表达式首字符不得为 !（第 ${ln} 行）`, `${l.trim().slice(0, 70)} — 第二个 ! 被 YAML 当成 tag 属性 → 整树解析崩溃（treg 实战）；改写成括号包裹：!!js (!process.env.X)`)
  }
  console.log(`\n== 结果：${failed} FAILED — 禁止重启，先修配置`)
  process.exit(1)
}

// 复刻 loader 的 __jsExpr 求值环境：注入 baseUrl（patch 文件 URL），
// 供 process.getBuiltinModule('node:module').createRequire(baseUrl) 这类
// 「运行时定位本包安装路径」的挂载型表达式（humanizer-ru 形态）安全求值。
const BASE_URL = existsSync(PATCH_FILE) ? pathToFileURL(PATCH_FILE).href : undefined
const evaluate = (expr) => new Function('baseUrl', `return (${expr})`)(BASE_URL) // eslint-disable-line no-new-func
const interpolate = (value) => {
  if (value && typeof value === 'object' && '__jsExpr' in value) return evaluate(value.__jsExpr)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(interpolate)
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = interpolate(v)
  return out
}

let entries = []
if (existsSync(PATCH_FILE)) {
  try {
    entries = entryListSchema ? yaml.load(readFileSync(PATCH_FILE, 'utf8'), { schema: entryListSchema }) : []
  } catch (e) {
    check(false, 'patch YAML 可解析', e.message)
    process.exit(1)
  }
} else {
  entries = []
}
check(Array.isArray(entries), 'patch 是顶层数组（缺失文件视为空 []）')

// insert 条目自动发现：insert 里的条目必须装配；顶层非 insert 条目（无 disabled 意图）必须命中既有 bundle。
const insertEntries = []
for (const p of entries ?? []) {
  if (p && Array.isArray(p.insert)) for (const it of p.insert) if (it && it.id) insertEntries.push(it)
}
const topLevelUnmatched = (entries ?? []).filter(e => e && typeof e === 'object' && e.id && !(Array.isArray(e.insert)) && e.disabled !== true)
const expectInserted = [...new Set([...insertEntries.map(e => e.id), ...expectExtra])]
const expectTopLevel = [...new Set(topLevelUnmatched.map(e => e.id))]
const mcpEntries = insertEntries.filter(e => e.name === '@deepseek-ai/dsh-mcp-client')
const otherInserts = insertEntries.filter(e => e.name !== '@deepseek-ai/dsh-mcp-client')
console.log(`== 自动发现 insert 条目: ${insertEntries.map(e => e.id).join(', ') || '（无）'}${expectExtra.length ? ` + 额外期望: ${expectExtra.join(', ')}` : ''}`)
console.log(`== 顶层非 insert 条目（须命中既有 bundle，disabled 意图除外）: ${expectTopLevel.join(', ') || '（无）'}\n`)

// ---------- T1: 配置树装配 ----------
console.log('--- T1 配置树装配（dump-config） ---')
// 指定了 --patch 覆盖文件时，把它作为 overlay 叠进 dump，验证"候选 patch 应用后的树"
const defaultPatch = join(homedir(), '.dsh', 'profiles', PROFILE, 'cordis.patch.yml')
let patchIsOverlay = PATCH_FILE !== defaultPatch
try { patchIsOverlay = realpathSync(PATCH_FILE) !== realpathSync(defaultPatch) } catch { /* 候选文件不存在等场景按字面比较 */ }
const dumpArgs = ['--profile', PROFILE]
if (patchIsOverlay) dumpArgs.push('--patch', PATCH_FILE)
dumpArgs.push('--dump-config')
const dumpRes = spawnSync(DSH, dumpArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const dumpOut = String(dumpRes.stdout ?? '')
const dumpErr = String(dumpRes.stderr ?? '')
// dump 失败时完整 stderr 落盘（stderr 首行往往是 node:fs:<行号>，真正的错误在后续行，截断首行毫无诊断价值）
const dumpFailed = dumpRes.status !== 0 || /plugin tree failed|ValidationError/.test(dumpErr)
if (dumpFailed) {
  const logPath = `/tmp/dsh-verify-dump-${PROFILE}.log`
  try { writeFileSync(logPath, `stderr:\n${dumpErr}\n\nstdout:\n${dumpOut}`) } catch {}
  const headLines = dumpErr.split('\n').filter(Boolean).slice(0, 4).map(l => l.slice(0, 160)).join(' | ')
  if (/EROFS|EACCES|read-only|EPERM|ENOSPC/.test(dumpErr)) {
    check(false, 'dump-config 环境受限（沙箱 HOME 只读等，非配置错误）', `${headLines} 完整输出: ${logPath}`)
    console.log('      出路：1) 请用户在终端跑本脚本；2) 或将 DSH 权限切到 danger-full-access 后重试。当前配置未验证 → 禁止重启。')
  } else {
    check(false, 'dump-config 装配崩溃', `exit=${dumpRes.status} ${headLines} 完整输出: ${logPath}`)
  }
} else {
  check(true, 'dump-config 无装配崩溃', '')
}
for (const entry of expectInserted) {
  const skipWarns = (dumpErr.match(new RegExp(`\\] patch: entry "${entry}" not found`)) ?? [])
  check(skipWarns.length === 0, `条目 ${entry} 未被 loader 跳过（无 "entry not found" 警告）`, skipWarns[0] ?? '')
}
for (const entry of expectTopLevel) {
  const skipWarns = (dumpErr.match(new RegExp(`\\] patch: entry "${entry}" not found`)) ?? [])
  check(skipWarns.length === 0, `顶层条目 ${entry} 命中既有 bundle（非 insert 无 disabled 必须命中）`, skipWarns[0] ?? '')
}
const otherSkips = (dumpErr.match(/\] patch: entry "[^"]+" not found/g) ?? []).filter(w => ![...expectInserted, ...expectTopLevel].some(e => w.includes(`"${e}"`)))
if (otherSkips.length > 0) console.log(`INFO  其他条目跳过警告（disabled 覆盖的重放伪警告或无关条目）: ${otherSkips.map(w => w.match(/entry "([^"]+)"/)?.[1]).join(', ')}`)
if (dumpFailed) {
  // dump 失败 → 树无从检查，SKIP 而非连环 FAIL（因果已断，避免 3 个 FAIL 无法区分根因）
  console.log('SKIP  条目在配置树中检查（dump 失败，无法核验；先解决上面的环境/装配问题）')
} else {
  for (const entry of expectInserted) {
    check(new RegExp(`^- id: ${entry}$`, 'm').test(dumpOut), `条目 ${entry} 在配置树中`)
  }
  if (otherInserts.length > 0) {
    for (const e of otherInserts) {
      check(new RegExp(`^- id: ${e.id}$`, 'm').test(dumpOut), `非 mcp insert 条目 ${e.id} 在配置树中`)
    }
  }
}

// ---------- T1b: --diff-default 配置树差异归因（config-clobber / dead-patch） ----------
/** 轻量解析 dump 输出：Map<id, {name, configKeys:Set, line}>（只读 - id: 块与两空格缩进 key）。 */
function parseTree(text) {
  const tree = new Map()
  let cur = null
  let curIndent = 0
  for (const line of text.split('\n')) {
    const m = line.match(/^- id: (\S+)/)
    if (m) {
      cur = { id: m[1], name: '', configKeys: new Set() }
      curIndent = 0
      tree.set(cur.id, cur)
      continue
    }
    if (!cur) continue
    const ind = line.match(/^(\s*)/)[1].length
    const nm = line.match(/^\s+name:\s*['"]?([^'"\s]+)/)
    if (nm && ind <= 2) { cur.name = nm[1]; continue }
    // `!!js` 多行块标量（!!js |- / !!js >）的续行不是 config 键；
    // 块内续行缩进必大于起始键行，遇到 ind<=2 的下一键即结束块。
    if (cur.jsBlock) {
      if (ind > 2) continue
      cur.jsBlock = false
    }
    if (ind === 2) {
      const raw = line.trim()
      if (raw.includes('!!js') && /!!js\s*[|>]-?\s*$/.test(raw)) {
        cur.jsBlock = true
        continue
      }
      const key = raw.split(':')[0]
      if (key === 'config' || key === 'disabled') continue
      cur.configKeys.add(key) // 顶层直配键
      continue
    }
    if (ind === 4) {
      const key = line.trim().split(':')[0]
      cur.configKeys.add(key) // config: 下两空格缩进键
    }
  }
  return tree
}
if (DIFF_DEFAULT && !dumpFailed) {
  console.log('\n--- T1b 配置树差异归因（--diff-default） ---')
  const defRes = spawnSync(DSH, ['--profile', PROFILE, '--dump-default-config'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (defRes.status !== 0 || /plugin tree failed|ValidationError/.test(defRes.stderr ?? '')) {
    report3('SKIP', 'diff-default', 'dump-default-config 失败（环境受限或装配异常），跳过差异归因', defRes.stderr?.split('\n')[0]?.slice(0, 120) ?? '')
  } else {
    const defaultTree = parseTree(String(defRes.stdout ?? ''))
    const finalTree = parseTree(dumpOut)
    // config-clobber：patch 整段替换语义下，用户 patch 覆盖的条目丢掉的默认 config 键
    const patchedIds = new Set(topLevelUnmatched.map(e => e.id))
    let clobbered = []
    for (const [id, def] of defaultTree) {
      const fin = finalTree.get(id)
      if (!fin || !patchedIds.has(id) || def.configKeys.size === 0) continue
      const lost = [...def.configKeys].filter(k => !fin.configKeys.has(k))
      if (lost.length > 0) clobbered.push(`${id} 丢失默认字段: ${lost.join(', ')}（patch 整段替换 config，需在 patch 里重写全量字段）`)
    }
    if (clobbered.length === 0) check(true, 'diff-default', '无 config-clobber（patch 未抹掉默认 config 字段）')
    else check(false, 'diff-default', 'config-clobber：patch 静默丢掉了默认配置字段', clobbered.slice(0, 3).join('；'))
    // dead-patch：顶层条目 id 不在最终树也不在默认树 → 拼错/已移除的静默失效 patch，给相似 id 建议
    const dead = []
    const allIds = [...finalTree.keys(), ...defaultTree.keys()]
    for (const id of patchedIds) {
      if (finalTree.has(id) || defaultTree.has(id)) continue
      const similar = allIds.filter(x => x !== id && (x.includes(id) || id.includes(x) || editDist(x, id) <= 2)).slice(0, 3)
      dead.push(`"${id}"（疑似拼写或已移除${similar.length ? `，did you mean: ${similar.join(' / ')}` : ''}）`)
    }
    if (dead.length === 0) check(true, 'diff-default', '无 dead-patch（顶层条目全部命中树）')
    else check(false, 'diff-default', 'dead-patch：顶层条目 id 在树中不存在', dead.slice(0, 3).join('；'))
    // T1d：覆写行 config 键归因（modsearch 教训：- id: web config: {searchProvider} 拼错键名
    // 会静默回退官方默认 provider 而不报错 —— 覆写键必须命中该 bundle 默认 config 键集）
    const extraKeys = []
    for (const e of topLevelUnmatched) {
      const def = defaultTree.get(e.id)
      if (!def || !e.config || typeof e.config !== 'object') continue
      for (const k of Object.keys(e.config)) {
        if (k === 'disabled') continue
        if (!def.configKeys.has(k)) extraKeys.push(`${e.id}.${k}`)
      }
    }
    if (extraKeys.length === 0) check(true, 'T1d 覆写行 config 键归因', '覆写键全部命中 bundle 默认 config 键集')
    else report3('WARN', 'T1d 覆写行 config 键归因', `新增键不在该 bundle 默认键集: ${extraKeys.slice(0, 5).join(', ')}（疑似拼错 → 可能静默回退默认；或为新增可选键，人工确认）`)
  }
}
function editDist(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

// ---------- T1c: --tool-collision 跨包工具名碰撞扫描 ----------
// 多布局多入口（2026-08-16 生态轮补齐）：不再只扫 lib/index.js——按每个已装包的
// exports["."]/main/bin 解析真实入口，再兜底扫 lib/src/dsh/dist 全部 .js/.mjs 与根入口；
// 工具名提取同时认 defineTool 与裸 ctx.tools.register({name})（modlens/hindsight 鸭子类型形态）。
if (TOOL_COLLISION) {
  console.log('\n--- T1c 跨包工具名碰撞（--tool-collision） ---')
  const profileModules = join(homedir(), '.dsh', 'profiles', PROFILE, 'node_modules')
  const pkgDirs = [] // {name, dir}
  const scanPkgs = (dir, scopePrefix) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.bin' || name.startsWith('.')) continue
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (!st.isDirectory()) continue
      if (name.startsWith('@')) scanPkgs(p, name) // scope 目录
      else if (existsSync(join(p, 'package.json'))) pkgDirs.push({ name: scopePrefix ? `${scopePrefix}/${name}` : name, dir: p })
    }
  }
  scanPkgs(profileModules, null)

  const MAX_FILE = 4 * 1024 * 1024 // 单文件扫描上限，防误读巨型产物
  const candidateEntries = (pkg) => {
    const out = []
    const seen = new Set()
    const add = (p) => { if (p && existsSync(p) && statSync(p).isFile() && !seen.has(p)) { seen.add(p); out.push(p) } }
    // ① 按元数据解析真实入口（exports["./dsh"] / exports["."] / main / bin —— mirage/hindsight/modlens 布局）
    try {
      const j = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8'))
      const exp = j.exports ?? {}
      for (const key of ['.', './dsh', './service', './fs', './shell']) {
        const v = exp[key]
        const rel = typeof v === 'string' ? v : v?.default
        if (rel) add(join(pkg.dir, rel))
      }
      if (j.main) add(join(pkg.dir, j.main))
      const bin = j.bin
      if (typeof bin === 'string') add(join(pkg.dir, bin))
      else if (bin && typeof bin === 'object') for (const b of Object.values(bin)) add(join(pkg.dir, b))
    } catch { /* 缺 package.json 的目录跳过 */ }
    // ② 常见入口目录兜底（lib/src/dsh/dist + 根），跳过嵌套 node_modules
    for (const rel of ['lib', 'src', 'dsh', 'dist']) {
      const base = join(pkg.dir, rel)
      if (!existsSync(base)) continue
      const walk = (d) => {
        for (const e of readdirSync(d)) {
          const fp = join(d, e)
          let st
          try { st = statSync(fp) } catch { continue }
          if (st.isDirectory()) { if (e !== 'node_modules') walk(fp) } else if (/\.(mjs|js|ts)$/.test(e)) add(fp)
        }
      }
      walk(base)
    }
    for (const e of readdirSync(pkg.dir)) if (/\.(mjs|js)$/.test(e)) add(join(pkg.dir, e))
    return out
  }

  const toolOwners = new Map() // tool → [{pkg, path}]
  let scannedFiles = 0
  const addTool = (t, pkg, path) => {
    if (!toolOwners.has(t)) toolOwners.set(t, [])
    if (!toolOwners.get(t).some((o) => o.pkg === pkg)) toolOwners.get(t).push({ pkg, path })
  }
  for (const pkg of pkgDirs) {
    for (const file of candidateEntries(pkg)) {
      let st
      try { st = statSync(file) } catch { continue }
      if (st.size > MAX_FILE) continue
      let src = ''
      try { src = readFileSync(file, 'utf8') } catch { continue }
      scannedFiles++
      // defineTool 形态（官方全家桶）+ 裸 ctx.tools.register({name}) 形态（鸭子类型插件）
      for (const m of src.matchAll(/defineTool\(\s*\{[^}]*?name:\s*['"]([^'"\s]+)['"]/gs)) addTool(m[1], pkg.name, file)
      for (const m of src.matchAll(/tools\.register\(\s*\{[^}]*?name:\s*['"]([^'"\s]+)['"]/gs)) addTool(m[1], pkg.name, file)
    }
  }
  const collisions = [...toolOwners.entries()].filter(([, owners]) => owners.length > 1)
  if (collisions.length === 0) check(true, 'tool-collision', `扫描 ${pkgDirs.length} 个包 / ${scannedFiles} 个入口文件，无跨包工具名碰撞（共 ${toolOwners.size} 个工具名）`)
  else check(false, 'tool-collision', '跨包工具名碰撞（dsh 会拒绝启动）', collisions.slice(0, 3).map(([t, owners]) => `${t}: ${owners.map((o) => `${o.pkg}@${o.path.split('/').slice(-2).join('/')}`).join(' vs ')}`).join('；'))
}

// ---------- T2: mcp config schema 校验 ----------
console.log('\n--- T2 mcp config schema 校验（带/不带 token 双环境） ---')
if (!yaml || !mcpClientMod) {
  check(false, 'T2 依赖可用（js-yaml 与 dsh-mcp-client）', `${!yaml ? 'js-yaml 不可用; ' : ''}${!mcpClientMod ? 'dsh-mcp-client 不可用' : ''}`)
} else {
  if (mcpEntries.length === 0) {
    console.log('INFO  无 insert 的 mcp 条目（patch 里没有 mcp 配置；若期望有，检查是否用了非 insert 写法——loader 会静默跳过）')
  }
  // T2b：非 mcp 条目的 config（顶层覆写行 + 普通插件 insert 行）无 schema 可验，
  // 但 __jsExpr 求值崩溃 = 装配崩溃，必须抓（mirage 的 SLACK_BOT_TOKEN 在 insert config 里、
  // modsearch/oh-dsh 在顶层覆写行——都是形态盲区）。
  // 可选服务/环境变量缺省求值 undefined 是否致命取决于消费方 schema：
  // mcp 的 z.dict(String) 拒绝 vs 插件自带 z.string().optional() 容忍（dsh-browser 桥接 token 案例），
  // 这里只拦「求值本身抛异常」的硬崩溃；mcp 条目由上方双环境循环覆盖，不重复报。
  const evalTargets = [...topLevelUnmatched, ...insertEntries.filter((e) => e.name !== '@deepseek-ai/dsh-mcp-client')]
  for (const entry of evalTargets) {
    if (!entry.config) continue
    try {
      interpolate(entry.config)
    } catch (e) {
      check(false, `T2b ${entry.id}: config __jsExpr 求值异常`, `${e.message}（baseUrl=${BASE_URL ?? '无'}；若是引用 baseUrl 的挂载型表达式，确认已显式注入）`)
    }
  }
  for (const env of [{ name: `带 ${primaryTokenEnv}`, vars: { [primaryTokenEnv]: 'gho_probe_dummy_token' } }, { name: `无 ${primaryTokenEnv}`, vars: {} }]) {
    const saved = process.env[primaryTokenEnv]
    if (env.vars[primaryTokenEnv]) process.env[primaryTokenEnv] = env.vars[primaryTokenEnv]
    else delete process.env[primaryTokenEnv]
    for (const entry of mcpEntries) {
      let cfg
      try {
        cfg = interpolate(entry.config ?? {})
      } catch (e) {
        check(false, `[${env.name}] ${entry.id}: __jsExpr 求值异常`, e.message)
        continue
      }
      let okStd = false
      let stdMsg = ''
      try {
        const parsed = mcpClientMod['~standard'].validate(cfg)
        okStd = !('issues' in parsed)
        stdMsg = okStd ? '' : (parsed.issues?.[0]?.message ?? 'invalid config')
      } catch (e) {
        stdMsg = e.message
      }
      const envKeys = Object.keys(cfg.env ?? {})
      const allStrings = envKeys.every(k => typeof cfg.env[k] === 'string')
      check(okStd, `[${env.name}] ${entry.id}: Config schema 校验通过`, stdMsg)
      check(allStrings, `[${env.name}] ${entry.id}: env 值全部为 string（防 undefined 崩溃）`, envKeys.map(k => `${k}=${typeof cfg.env[k]}`).join(', ') || '（无 env）')
    }
    if (saved !== undefined) process.env[primaryTokenEnv] = saved
    else delete process.env[primaryTokenEnv]
  }
}

// ---------- T3: stdio 二进制握手 / 远程 MCP 可达性探针 ----------
console.log('\n--- T3 二进制握手（stdio 握手 / 远程 MCP 可达性探针） ---')
const NO_NET_PROBE = argv.includes('--no-net-probe')
/** 异步握手：保持 stdin 打开（部分 server 对立即 EOF 的管道不响应）。 */
function handshake(cmd, args, env, input, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let settled = false
    const finish = (val) => { if (!settled) { settled = true; clearTimeout(timer); try { child.kill() } catch {} resolve(val) } }
    const timer = setTimeout(() => finish(null), timeoutMs)
    child.stdout.on('data', (d) => {
      out += String(d)
      const m = out.match(/"serverInfo":\{"name":"([^"]+)"/)
      if (m) finish(m[1])
    })
    child.on('close', () => finish(null))
    child.stdin.write(input)
  })
}
/**
 * 远程 MCP（streamable-http / http）可达性探针：POST initialize 到配置端点，
 * 期望 200 + serverInfo（streamable-http 的响应是 JSON 或 SSE `event: message`）。
 * - 401/403 = 端点可达且需鉴权（dummy token 被拒属预期）→ INFO
 * - 连不上/超时/非法响应 → WARN（不阻断重启：端点可能临时离线或沙箱禁网）
 * - `--no-net-probe` 可关（完全无外网的环境）
 */
async function probeRemoteMcp(entry, cfg) {
  const url = cfg.url ?? cfg.serverUrl
  if (!url) { report3('WARN', `${entry.id}: 远程 MCP 缺 url/serverUrl（transport=${cfg.transport}）`, '无法探针'); return }
  let u
  try { u = new URL(url) } catch { report3('WARN', `${entry.id}: url 非法`, url.slice(0, 120)); return }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { report3('WARN', `${entry.id}: url scheme 非 http(s)`, u.protocol); return }
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-verify', version: '1.0' } } })
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    const res = await fetch(url, { method: 'POST', headers, body: init, signal: ctrl.signal, redirect: 'follow' })
    clearTimeout(timer)
    const text = await res.text()
    const m = text.match(/"serverInfo":\{"name":"([^"]+)"/)
    if (res.ok && m) report3('PASS', `${entry.id}: 远程 MCP 端点可达 + initialize 返回 serverInfo`, `server=${m[1]} http=${res.status}`)
    else if (res.status === 401 || res.status === 403) report3('INFO', `${entry.id}: 远程 MCP 端点可达但需鉴权（${res.status}，dummy token 被拒属预期；实际运行时注入真凭据）`, url.slice(0, 100))
    else if (res.ok) report3('WARN', `${entry.id}: 远程 MCP 返回 200 但无 serverInfo（可能需 T2 配置的鉴权头）`, text.slice(0, 100))
    else report3('WARN', `${entry.id}: 远程 MCP 端点响应异常`, `http=${res.status} ${text.slice(0, 100)}`)
  } catch (e) {
    report3('WARN', `${entry.id}: 远程 MCP 端点不可达/网络受限`, `${e.name ?? 'error'}: ${(e.message ?? '').slice(0, 120)}（--no-net-probe 可关闭探针）`)
  }
}
/** 复刻 loader 的 __jsExpr 求值（同 T2 顶层的 baseUrl 注入版本；此处仅保留引用）。 */
for (const entry of mcpEntries) {
  let cfg
  try {
    cfg = interpolate(entry.config ?? {})
  } catch {
    cfg = entry.config ?? {}
  }
  if (cfg.transport !== 'stdio') {
    if (cfg.transport === 'streamable-http' || cfg.transport === 'http' || cfg.url || cfg.serverUrl) {
      if (NO_NET_PROBE) report3('INFO', `${entry.id}: transport=${cfg.transport}，--no-net-probe 关闭可达性探针`, '人工验证端点与鉴权')
      else await probeRemoteMcp(entry, cfg)
    } else {
      report3('INFO', `${entry.id}: transport=${cfg.transport}（无 url、非 stdio，跳过握手）`)
    }
    continue
  }
  if (!cfg.command) { check(false, `${entry.id}: 命令存在（command 为空）`); continue }
  // 命令解析：绝对路径直用；裸命令名走 PATH 查找（npx/python 等不以文件形式存在于 cwd）
  let cmdPath = cfg.command
  if (!existsSync(cmdPath) && !cmdPath.includes('/') && !cmdPath.includes('\\')) {
    const which = spawnSync('which', [cmdPath], { encoding: 'utf8' })
    if (which.status === 0 && which.stdout.trim()) cmdPath = which.stdout.trim()
  }
  if (!existsSync(cmdPath)) { check(false, `${entry.id}: 命令存在 ${cfg.command}（绝对路径与 PATH 均找不到）`); continue }
  // 依赖链快检：npx/npm/python/uvx 类「拉取型」command，_--version 探活反映最外层工具链存在性
  // （argo 教训：npx -y github:... 首跑联网拉包 + 链 Python 3.10+，T3 旧版对裸命令名误判 FAIL）
  const base = cmdPath.split('/').pop()
  if (['npx', 'npm', 'yarn', 'pnpm', 'python', 'python3', 'uvx', 'uv'].includes(base)) {
    const probe = spawnSync(cmdPath, ['--version'], { encoding: 'utf8', timeout: 15000 })
    report3(probe.status === 0 ? 'INFO' : 'WARN', `${entry.id}: 依赖链快检 ${base} --version`,
      probe.status === 0 ? `ok: ${(probe.stdout || probe.stderr || '').trim().split('\n')[0].slice(0, 60)}` : (probe.stderr || probe.stdout || '').trim().split('\n')[0].slice(0, 80))
  }
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-verify', version: '1.0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  ].join('\n') + '\n'
  const childEnv = { ...process.env }
  for (const [k, v] of Object.entries(cfg.env ?? {})) childEnv[k] = (v || 'gho_dummy_verify_token') // 空值换非空 dummy 验证协议链路
  const serverName = await handshake(cmdPath, cfg.args ?? [], childEnv, input)
  check(serverName !== null, `${entry.id}: MCP initialize 握手成功`, serverName ? `server=${serverName}` : '无 serverInfo 响应（stdin EOF 时序或进程异常退出）')
}

console.log(`\n== 结果：${failed === 0 ? 'ALL PASS — 可以重启' : failed + ' FAILED — 禁止重启，先修配置'}`)
process.exit(failed === 0 ? 0 : 1)
