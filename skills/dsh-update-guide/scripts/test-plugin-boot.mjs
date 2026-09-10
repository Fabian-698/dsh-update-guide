#!/usr/bin/env node
/**
 * test-plugin-boot — 启用第三方插件前的隔离启动测试(dsh 0.1.5+)
 *
 * 为什么需要: 静态扫描覆盖不到全部断链——例如 0.1.5 的 "cannot get property X without inject"
 * 只在插件 apply 时触发, 而且会让 **整棵插件树** 加载失败(dsh web 直接起不来)。
 * 本脚本把 profile 复制到临时 DSH_HOME, 先全量启用第三方插件启动一次; 失败项自动 quarantine
 * 后重试, 直到启动成功, 最后输出"不能启用"的插件清单与首个错误行。全程不触碰真实 ~/.dsh。
 *
 * 用法:
 *   node test-plugin-boot.mjs [--dsh-home ~/.dsh] [--profile web]
 *                             [--rounds 6] [--timeout 120000] [--keep] [--json]
 *   --dsh-home  真实 DSH_HOME(作为复制来源, 默认 process.env.DSH_HOME 或 ~/.dsh)
 *   --profile   配置 profile(默认 web)
 *   --rounds    最多启动轮数(每轮隔离一个失败插件, 默认 6)
 *   --timeout   单轮等待 dsh web 就绪的上限毫秒(默认 120000)
 *   --keep      保留临时 home 与日志供排查(默认清理, 含凭据副本)
 *   --json      输出 JSON 契约 { ok, booted, profile, rounds, incompatible: [{entry,package,error}] }
 * 退出码: 0 = 全部插件可启用(无 quarantine); 1 = 有不兼容插件(清单已输出); 2 = 环境不满足/非插件单点失败
 *
 * 依赖: dsh CLI(必须)。脚本只允许 node: 内建模块与 dsh CLI。
 * 安全: 临时 home 在 os.tmpdir() 下, 复制 settings/credentials 后 chmod 600, 结束即删。
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

// ---------- CLI 参数 ----------
const ARGV = process.argv.slice(2)
if (ARGV.includes('--help') || ARGV.includes('-h')) {
  console.log([
    'test-plugin-boot — 隔离 DSH_HOME 的插件启动测试',
    '用法: node test-plugin-boot.mjs [--dsh-home ~/.dsh] [--profile web] [--rounds 6] [--timeout 120000] [--keep] [--json]',
    '退出码: 0 = 全部插件可启用; 1 = 有不兼容插件; 2 = 环境不满足',
  ].join('\n'))
  process.exit(0)
}
const argOf = (flag, fallback) => {
  const eq = ARGV.find(a => a.startsWith(flag + '='))
  if (eq) return eq.slice(flag.length + 1)
  const i = ARGV.indexOf(flag)
  if (i >= 0 && i + 1 < ARGV.length) return ARGV[i + 1]
  return fallback
}
const jsonOut = ARGV.includes('--json')
const KEEP = ARGV.includes('--keep')
const PROFILE = argOf('--profile', 'web')
const DSH_HOME = resolve(argOf('--dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh')))
const ROUNDS = Math.max(1, Number(argOf('--rounds', '6')) || 6)
const BOOT_TIMEOUT = Math.max(10000, Number(argOf('--timeout', '120000')) || 120000)
const SETTLE_MS = 15000 // 看到 URL 后再等一会儿, 让晚失败的 entry 也暴露

const sleep = ms => new Promise(r => setTimeout(r, ms))
const tail = (text, n = 12) => text.trim().split('\n').slice(-n).join('\n')
const safeRead = p => { try { return readFileSync(p, 'utf8') } catch { return '' } }

let tmpRoot = null
function cleanup() {
  if (tmpRoot && !KEEP) { try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 忽略 */ } }
}
function die(code, msg) {
  cleanup()
  if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
  else console.error('test-plugin-boot: ' + msg)
  process.exit(code)
}

// ---------- 0. 环境检查 ----------
const version = spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 30000 })
if (version.error || version.status !== 0) {
  die(2, '找不到可用的 dsh CLI(' + String((version.error && version.error.message) || '') + ')')
}
const profileDir = join(DSH_HOME, 'profiles', PROFILE)
if (!existsSync(profileDir)) die(2, 'profile 不存在: ' + profileDir)
const realModules = join(profileDir, 'node_modules')
if (!existsSync(realModules)) die(2, 'profile 缺 node_modules(先 dsh plugin add/安装依赖): ' + realModules)

// ---------- 1. 生成隔离 home(真实 home 只读复制, 绝不写回) ----------
tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-boot-test-'))
const home = join(tmpRoot, 'home')
const testProfile = join(home, 'profiles', PROFILE)
mkdirSync(join(home, 'profiles'), { recursive: true })
try {
  cpSync(profileDir, testProfile, {
    recursive: true,
    filter: src => !src.endsWith(sep + 'node_modules'),
  })
} catch (e) {
  die(2, '复制 profile 失败: ' + String(e && e.message ? e.message : e))
}
symlinkSync(realModules, join(testProfile, 'node_modules'), 'dir')
const settings = join(DSH_HOME, 'settings.yaml')
if (existsSync(settings)) copyFileSync(settings, join(home, 'settings.yaml'))
const creds = join(DSH_HOME, '.credentials.yaml')
if (existsSync(creds)) {
  copyFileSync(creds, join(home, '.credentials.yaml'))
  chmodSync(join(home, '.credentials.yaml'), 0o600)
}
const presets = join(DSH_HOME, '.agent-presets')
if (existsSync(presets)) symlinkSync(presets, join(home, '.agent-presets'), 'dir')
// 数据目录给空目录, 既让插件能启动, 又不写真实数据
for (const d of ['storages', 'llm-deepseek', 'memory', 'pomodoro', 'task-board', 'integrations', 'sessions', 'browser-sessions']) {
  try { mkdirSync(join(home, d), { recursive: true }) } catch { /* 忽略 */ }
}
// market 的禁用清单清空, 避免它把插件的 disabled 行又写回来
try {
  const statePath = join(testProfile, '.dsh-market', 'state.json')
  if (existsSync(statePath)) {
    const st = JSON.parse(readFileSync(statePath, 'utf8'))
    st.disabled = []
    writeFileSync(statePath, JSON.stringify(st))
  }
} catch { /* 无 market state 不影响 */ }

// ---------- 2. 生成"全部启用"的 patch 基线 ----------
// 删掉顶层 "- id: X / disabled: true|false" 对(恢复默认启用);
// 剩余的 disabled: false 是 insert 里的 MCP client 等子条目 → 置 true, 避免拉起重复 MCP 子进程。
function stripDisabledRows(text) {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (/^- id:\s*\S+\s*$/.test(lines[i])) {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      if (j < lines.length && /^\s*disabled:\s*(?:true|false)\s*$/.test(lines[j])) { i = j; continue }
    }
    out.push(lines[i])
  }
  return out.join('\n')
}
const patchPath = join(testProfile, 'cordis.patch.yml')
let basePatch = '# test-plugin-boot: 隔离副本, 全部插件默认启用\n[]\n'
if (existsSync(patchPath)) {
  basePatch = stripDisabledRows(readFileSync(patchPath, 'utf8')).replace(/disabled:\s*false/g, 'disabled: true')
  if (!basePatch.trim()) basePatch = '# test-plugin-boot: 全部插件默认启用\n[]\n'
}

// ---------- 3. 启动一轮 ----------
async function killTree(child) {
  if (child.pid === undefined) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* 已退出 */ } }
  await sleep(3000)
  try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
}
async function bootOnce(logPath) {
  const fd = openSync(logPath, 'w')
  const child = spawn('dsh', ['web', '--port', '0', '--no-open'], {
    cwd: tmpRoot,
    env: { ...process.env, DSH_HOME: home },
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  let exited = false
  let code = null
  child.on('exit', c => { exited = true; code = c })
  const start = Date.now()
  let sawUrl = false
  while (Date.now() - start < BOOT_TIMEOUT) {
    await sleep(1000)
    if (exited) break
    if (safeRead(logPath).includes('dsh web: http://127.0.0.1')) { sawUrl = true; break }
  }
  if (sawUrl && !exited) await sleep(SETTLE_MS)
  const ok = sawUrl && !exited
  await killTree(child)
  try { closeSync(fd) } catch { /* 忽略 */ }
  return { ok, log: safeRead(logPath), code }
}
// 从启动日志里解析失败 entry(形如 failed to apply loader entry mcp-manager (@js2hou/dsh-mcp-manager): <原因>)
function parseFailure(log) {
  const m = log.match(/failed to apply loader entry ([^\s]+) \(([^)]+)\)/)
  if (!m) return null
  const line = log.split('\n').find(l => l.includes('failed to apply loader entry')) || ''
  const cut = line.indexOf('): ')
  return { entry: m[1], pkg: m[2], error: cut >= 0 ? line.slice(cut + 3).trim() : line.trim() }
}

// ---------- 4. 逐轮启动, 失败项 quarantine 后重试 ----------
const incompatible = []
const seen = new Set()
let ok = false
let rounds = 0
for (let round = 1; round <= ROUNDS; round++) {
  rounds = round
  const rows = incompatible.map(q => '- id: ' + q.entry + '\n  disabled: true').join('\n')
  writeFileSync(patchPath, basePatch.trimEnd() + '\n' + (rows ? rows + '\n' : ''))
  if (!jsonOut) console.log('[round ' + round + '] 隔离启动 dsh web(已隔离 ' + incompatible.length + ' 项)…')
  const logPath = join(tmpRoot, 'boot-' + round + '.log')
  const r = await bootOnce(logPath)
  if (r.ok) { ok = true; break }
  const f = parseFailure(r.log)
  if (!f) {
    die(2, '第 ' + round + ' 轮启动失败且无法定位到插件(非插件树单点失败), 日志: ' + logPath + '\n' + tail(r.log))
  }
  if (seen.has(f.entry)) die(2, '插件 ' + f.entry + ' 反复失败(quarantine 未生效), 日志: ' + logPath)
  seen.add(f.entry)
  incompatible.push(f)
}

// ---------- 5. 输出 ----------
const allUsable = ok && incompatible.length === 0
if (jsonOut) {
  console.log(JSON.stringify({
    ok: allUsable,
    booted: ok,
    profile: PROFILE,
    rounds,
    incompatible: incompatible.map(q => ({ entry: q.entry, package: q.pkg, error: q.error })),
    keptHome: KEEP ? home : undefined,
  }, null, 2))
} else {
  console.log('')
  if (allUsable) console.log('启动测试通过: 全部插件可正常加载(dsh ' + String(version.stdout || '').trim() + ')')
  else if (ok) console.log('隔离后能启动, 但存在不兼容插件(见下)')
  else console.log('启动测试未收敛: ' + ROUNDS + ' 轮后仍失败')
  if (incompatible.length) {
    console.log('不兼容(保持 disabled, 等上游适配):')
    for (const q of incompatible) console.log('  - ' + q.pkg + ' (' + q.entry + '): ' + q.error)
  } else {
    console.log('未发现不兼容插件')
  }
  if (KEEP) console.log('临时 home 保留: ' + home + ' (含凭据副本, 排查完请手动删除)')
}
cleanup()
process.exit(allUsable ? 0 : 1)
