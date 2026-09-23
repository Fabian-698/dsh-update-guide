#!/usr/bin/env node
/**
 * selftest — dsh-update-guide 自测（改动脚本/闸门后必跑）
 *
 * 默认快速档：
 *   A node --check 全部脚本          B scan 与 verify-session 事件类型并集一致
 *   C 内置模型 id 一致（含 0.1.6-alpha.2 缩减前后的全集）  D 闸门解析（sync-gates --list）
 *   E v2/v3 fixtures 经薄壳验证 ALL PASS   F 目录发现优先 V3 文件
 *   H S1 活跃 turn 判定（in-flight WARN / 已闭合 turn FAIL）
 *   I scan v0 迁移检查（提交区→blocker / 未提交尾部→warning）
 *   J scan 严格 inject 检查（rpc.handle 缺 webServer→blocker / 已声明或裸调用→不误报）
 *   K scan V4 支持与声明式 preset 核对（V4 优先 V3、preset 未声明→blocker、模型目录读 Profile patch）
 *   L scan 模型声明来源回退（无 patch 时读 dump-config；模型失效→blocker 且 preset 不误报）
 * --full 追加 G + M（共用一次扫描）：G 断言 scan 真跑完（JSON/退出码契约一致、未被版本门控跳过、
 *   preset 检查已执行、无未知类别）；M 断言"本机 scan = 0 blocker"（真实断链修完后成立）。
 *   两者分开，便于区分"工具坏了"与"机器还有未修复的真问题"。
 *
 * 用法：node scripts/selftest.mjs [--full]   退出码 0=PASS 1=FAIL
 */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const skillRoot = resolve(here, '..')
const skillsRoot = resolve(skillRoot, '..')
const ownerSession = join(skillsRoot, 'dsh-session-logs', 'scripts', 'verify-session.mjs')
const full = process.argv.includes('--full')
let failed = 0
const pass = (id, msg) => console.log('PASS ' + id + '  ' + msg)
const fail = (id, msg) => { failed++; console.log('FAIL ' + id + '  ' + msg) }
const skip = (id, msg) => console.log('SKIP ' + id + '  ' + msg)

// A. 语法
const scripts = ['scan-upgrade.mjs', 'fix-model-refs.mjs', 'repair-v0-sessions.mjs', 'test-plugin-boot.mjs', 'verify-session.mjs', 'verify-patch.mjs', 'verify-patch-surface.mjs', 'sync-gates.mjs']
for (const s of scripts) {
  const p = join(here, s)
  if (!existsSync(p)) { fail('A', s + ' 不存在'); continue }
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' })
  if (r.status === 0) pass('A', s + ' 语法 OK')
  else fail('A', s + ' node --check 失败: ' + String(r.stderr || '').split('\n')[0])
}

// B. 事件类型并集一致
function extractSet(file) {
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const blocks = [...text.matchAll(/new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/g)]
  let best = new Set()
  for (const b of blocks) {
    const items = new Set([...b[1].matchAll(/'([^']+)'/g)].map(m => m[1]))
    if (items.size > best.size) best = items
  }
  return best
}
const scanSet = extractSet(join(here, 'scan-upgrade.mjs'))
const gateSet = extractSet(ownerSession)
if (!scanSet || !gateSet) skip('B', '缺少 scan-upgrade.mjs 或 owner verify-session.mjs，跳过一致性校验')
else {
  const onlyScan = [...scanSet].filter(x => !gateSet.has(x))
  const onlyGate = [...gateSet].filter(x => !scanSet.has(x))
  if (scanSet.size < 30 || gateSet.size < 30) fail('B', '事件类型集合疑似解析错误（scan=' + scanSet.size + ' gate=' + gateSet.size + '）')
  else if (onlyScan.length || onlyGate.length) fail('B', '事件类型并集不一致: 仅 scan=' + JSON.stringify(onlyScan) + ' 仅 gate=' + JSON.stringify(onlyGate))
  else pass('B', '事件类型并集一致（' + scanSet.size + ' 类）')
}

// C. 内置 deepseek-official 模型 id
const builtinIds = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']
for (const f of ['scan-upgrade.mjs', 'fix-model-refs.mjs']) {
  const p = join(here, f)
  if (!existsSync(p)) { fail('C', f + ' 不存在'); continue }
  const text = readFileSync(p, 'utf8')
  const missing = builtinIds.filter(id => !text.includes("'" + id + "'") && !text.includes('"' + id + '"'))
  if (missing.length) fail('C', f + ' 缺少内置模型 id: ' + missing.join(', '))
  else pass('C', f + ' 含全部 4 个内置模型 id')
}

// D. 闸门解析 + gates/ 副本漂移（--check 比对哈希，防止旧内置副本骗过 E/F）
const rl = spawnSync(process.execPath, [join(here, 'sync-gates.mjs'), '--list'], { encoding: 'utf8' })
const rc = spawnSync(process.execPath, [join(here, 'sync-gates.mjs'), '--check'], { encoding: 'utf8' })
const dOut = String(rl.stdout || '') + String(rc.stdout || '') + String(rc.stderr || '')
if (rl.status === 0 && !/\[miss\]/.test(rl.stdout || '') && rc.status === 0 && !/\[DRIFT\]/.test(rc.stdout || '')) pass('D', '闸门解析正常且无副本漂移')
else fail('D', 'sync-gates 异常或漂移: ' + dOut.replace(/\s+/g, ' ').slice(0, 240))

// E. fixtures 回归（优先直接跑 owner 规范版，owner 不在时退回 shim；避免被旧 gates/ 副本骗过）
const fixtureGate = existsSync(ownerSession) ? ownerSession : join(here, 'verify-session.mjs')
for (const fx of ['fixtures/v2-session.jsonl', 'fixtures/v3-session.jsonl']) {
  const p = join(here, fx)
  if (!existsSync(p)) { fail('E', fx + ' 缺失'); continue }
  const r = spawnSync(process.execPath, [fixtureGate, p], { encoding: 'utf8' })
  const out = (r.stdout || '') + (r.stderr || '')
  if (r.status === 0 && /ALL PASS/.test(out)) pass('E', fx + ' ALL PASS')
  else fail('E', fx + ' 未通过: status=' + r.status + ' ' + out.replace(/\s+/g, ' ').slice(0, 240))
}

// F. 目录发现优先 V3
const zstdOk = spawnSync('zstd', ['--version'], { encoding: 'utf8' }).status === 0
if (!zstdOk) skip('F', 'zstd 不可用，跳过文件发现用例')
else {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
  try {
    const v2 = readFileSync(join(here, 'fixtures/v2-session.jsonl'), 'utf8')
    const v3 = readFileSync(join(here, 'fixtures/v3-session.jsonl'), 'utf8')
    // harness 日志是逐记录多帧 zstd（单帧会触发 S9），这里按行压成多帧再拼接
    const compressMultiframe = (content, outFile) => {
      const frames = []
      content.trim().split('\n').forEach((line, i) => {
        const raw = join(dir, 'frame-' + i + '.jsonl')
        writeFileSync(raw, line + '\n')
        const z = spawnSync('zstd', ['-q', '-f', '-o', raw + '.zst', raw], { encoding: 'utf8' })
        if (z.status !== 0) throw new Error('zstd 压缩失败: ' + String(z.stderr || ''))
        rmSync(raw, { force: true })
        frames.push(raw + '.zst')
      })
      writeFileSync(outFile, Buffer.concat(frames.map(p => readFileSync(p))))
      frames.forEach(p => rmSync(p, { force: true }))
    }
    compressMultiframe(v2, join(dir, 'session.jsonl.zstd'))
    compressMultiframe(v3, join(dir, 'session.v3.jsonl.zstd'))
    mkdirSync(join(dir, 'nested'), { recursive: true })
    const r = spawnSync(process.execPath, [join(here, 'verify-session.mjs'), dir], { encoding: 'utf8' })
    const out = (r.stdout || '') + (r.stderr || '')
    if (r.status === 0 && out.includes('session.v3.jsonl.zstd') && !out.includes('session.jsonl.zstd')) pass('F', '目录发现优先 session.v3.jsonl.zstd')
    else fail('F', '未优先选取 V3 文件: status=' + r.status + ' ' + out.replace(/\s+/g, ' ').slice(0, 240))
  } catch (e) {
    fail('F', String(e && e.message ? e.message : e))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// H. S1 活跃 turn 判定回归（0.1.5 PTC：根调用在飞时被后续嵌套事件挤出"最后 3 条"窗口）
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-s1-'))
  try {
    const base = readFileSync(join(here, 'fixtures/v3-session.jsonl'), 'utf8').trim().split('\n')
    const hdr = JSON.parse(base[0])
    const seqs = base.map(l => { try { return JSON.parse(l).seq } catch { return undefined } }).filter(n => typeof n === 'number')
    const next = Math.max(...seqs) + 1
    const fname = hdr.version === 3 ? 'session.v3.jsonl' : 'session.jsonl'
    const run = (extra) => {
      const p = join(dir, fname)
      writeFileSync(p, base.concat(extra.map(o => JSON.stringify(o))).join('\n') + '\n')
      const r = spawnSync(process.execPath, [join(here, 'verify-session.mjs'), p], { encoding: 'utf8' })
      return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
    }
    const ptc = (seq, sub) => ({
      type: seq % 2 ? 'tool/ptc-dispatch-start' : 'tool/ptc-dispatch', seq, time: 1700000001000 + seq,
      data: { rootCallId: 'orphan', parentCallId: 'orphan', subCallId: 'orphan:ptc:' + sub, name: 'bash', arguments: { command: 'echo x' } },
    })
    // H1：未闭合 turn 内的根调用，后面跟 >=4 条嵌套 PTC 事件（复现本次真实误报形态）→ 必须 WARN 而非 FAIL
    const h1 = run([
      { type: 'turn/start', seq: next, time: 1700000001000, data: { turn: 9 } },
      { type: 'tool/call', seq: next + 1, time: 1700000001001, data: { turn: 9, step: 1, callId: 'orphan-inflight', name: 'run_code', arguments: '{}' } },
      ptc(next + 2, 1), ptc(next + 3, 1), ptc(next + 4, 2), ptc(next + 5, 2), ptc(next + 6, 3),
    ])
    if (h1.status === 0 && /WARN S1/.test(h1.out) && !/FAIL S1/.test(h1.out)) pass('H', '活跃 turn 内 in-flight 根调用 → WARN 不误报')
    else fail('H', '活跃 turn 内 in-flight 未按 WARN: status=' + h1.status + ' ' + h1.out.replace(/\s+/g, ' ').slice(0, 200))
    // H2：同样孤儿的调用但 turn 已闭合 → 必须 FAIL（真实损坏不能被放过）
    const h2 = run([
      { type: 'turn/start', seq: next, time: 1700000002000, data: { turn: 9 } },
      { type: 'tool/call', seq: next + 1, time: 1700000002001, data: { turn: 9, step: 1, callId: 'orphan-closed', name: 'run_code', arguments: '{}' } },
      { type: 'turn/end', seq: next + 2, time: 1700000002002, data: { turn: 9, reason: { kind: 'done' } } },
      { type: 'step/end', seq: next + 3, time: 1700000002003, data: { turn: 9, step: 1 } },
      { type: 'session/end-seed', seq: next + 4, time: 1700000002004, data: {} },
      { type: 'feedback/message-put', seq: next + 5, time: 1700000002005, data: { messageId: 'z', rating: 'up' } },
    ])
    if (h2.status === 1 && /FAIL S1/.test(h2.out)) pass('H', '已闭合 turn 内孤儿调用仍 FAIL（真实损坏不放过）')
    else fail('H', '已闭合 turn 内孤儿调用未 FAIL: status=' + h2.status + ' ' + h2.out.replace(/\s+/g, ' ').slice(0, 200))
  } catch (e) {
    fail('H', 'S1 用例构造失败: ' + String(e && e.message ? e.message : e))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// I. scan 的 v0 迁移检查回归：提交区违规 → blocker；只在 turn/end 之后的违规 → warning
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-migr-'))
  const home = join(dir, 'home')
  const sdir = join(home, 'sessions', '--test--', 'session-migr-fixture')
  mkdirSync(sdir, { recursive: true })
  const header = JSON.stringify({ type: 'session', version: 0, id: 'session-migr-fixture', createdAt: 1700000000000, cwd: '/tmp', delegationDepth: 0, agentPreset: 'ptc' })
  const turnStart = JSON.stringify({ type: 'turn/start', seq: 0, time: 1700000000000, data: { turn: 1 } })
  const turnEnd = JSON.stringify({ type: 'turn/end', seq: 1, time: 1700000000001, data: { turn: 1, reason: { kind: 'done' } } })
  const badSummary = JSON.stringify({ type: 'user/message', seq: 2, time: 1700000000002, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'dsh-mnemon', form: 'instructions', summary: 's' } } })
  const badDescriptor = JSON.stringify({ type: 'subagent/descriptor', seq: 3, time: 1700000000003, data: { version: 2, mode: 'one-shot', provider: 'fork' } })
  const badReplay = JSON.stringify({ type: 'assistant/chunk', seq: 4, time: 1700000000004, data: { chunk: { type: 'finish', reason: { kind: 'stop' }, replayState: { kind: 'pi-ai', version: 1 } } } })
  const write = (lines) => writeFileSync(join(sdir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
  const scan = () => {
    const r = spawnSync(process.execPath, [join(here, 'scan-upgrade.mjs'), '--dsh-home', home, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 })
    let j = null
    try { j = JSON.parse(r.stdout || '{}') } catch { /* 输出异常时留空 */ }
    return { status: r.status, issue: (j?.issues || []).find(i => i.category === 'migration') }
  }
  try {
    write([header, turnStart, badSummary, badDescriptor, badReplay, turnEnd])
    const a = scan()
    if (a.status === 1 && a.issue && a.issue.severity === 'blocker' && /summary×1/.test(a.issue.detail) && /descriptor v2×1/.test(a.issue.detail) && /replayState×1/.test(a.issue.detail)) pass('I', '提交区三类违规 → migration blocker')
    else fail('I', '提交区违规未报 blocker: status=' + a.status + ' issue=' + JSON.stringify(a.issue).slice(0, 200))
    write([header, turnStart, turnEnd, badSummary])
    const b = scan()
    if (b.status === 0 && b.issue && b.issue.severity === 'warning') pass('I', '仅 turn/end 之后的违规 → migration warning（不阻断）')
    else fail('I', '尾部违规未按 warning: status=' + b.status + ' issue=' + JSON.stringify(b.issue).slice(0, 200))
  } catch (e) {
    fail('I', '迁移检查用例失败: ' + String(e && e.message ? e.message : e))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// J. scan 的 0.1.5 严格 inject 检查：ctx.connection.rpc 缺 webServer → blocker；已声明/裸调用 → 不误报
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inject-'))
  const home = join(dir, 'home')
  const pkgDir = join(home, 'plugins', 'audit-fixture')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'audit-fixture', version: '1.0.0' }))
  const file = join(pkgDir, 'lib', 'index.js')
  const injectLine = names => 'var inject = [' + names.map(n => '"' + n + '"').join(', ') + '];'
  const scan = () => {
    const r = spawnSync(process.execPath, [join(here, 'scan-upgrade.mjs'), '--dsh-home', home, '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000 })
    let j = null
    try { j = JSON.parse(r.stdout || '{}') } catch { /* 输出异常时留空 */ }
    return { status: r.status, source: (j?.issues || []).filter(i => i.category === 'source') }
  }
  try {
    // J1：直接调用 ctx.connection.rpc.handle 且 inject 缺 webServer → blocker(整棵插件树起不来)
    writeFileSync(file, injectLine(['connection', 'loader', 'tools']) + '\nfunction apply(ctx) { ctx.connection.rpc.handle("/x", () => {}); }\nexport { apply, inject };\n')
    const j1 = scan()
    if (j1.status === 1 && j1.source.some(i => i.severity === 'blocker' && /webServer/.test(i.detail))) pass('J', 'rpc.handle 缺 webServer inject → blocker')
    else fail('J', '缺 webServer 未报 blocker: status=' + j1.status + ' ' + JSON.stringify(j1.source).slice(0, 200))
    // J2：inject 已含 webServer → 不报 blocker
    writeFileSync(file, injectLine(['connection', 'loader', 'tools', 'webServer']) + '\nfunction apply(ctx) { ctx.connection.rpc.handle("/x", () => {}); }\nexport { apply, inject };\n')
    const j2 = scan()
    if (j2.status === 0 && !j2.source.some(i => i.severity === 'blocker')) pass('J', '已声明 webServer → 不误报 blocker')
    else fail('J', '已声明 webServer 仍报 blocker: status=' + j2.status + ' ' + JSON.stringify(j2.source).slice(0, 200))
    // J3：裸 connection.rpc.handle(helper 形态, mnemon 类调用) → 不误报
    writeFileSync(file, injectLine(['tools']) + '\nfunction wire(connection) { connection.rpc.handle("/x", () => {}); }\nexport { wire, inject };\n')
    const j3 = scan()
    if (j3.status === 0 && !j3.source.some(i => i.severity === 'blocker')) pass('J', '裸 connection.rpc.handle 不误报')
    else fail('J', '裸调用被误报: status=' + j3.status + ' ' + JSON.stringify(j3.source).slice(0, 200))
    // J4：浏览器半边 ctx.connection.rpc.call(如 dsh-pocket/client) → 不误报
    writeFileSync(file, injectLine(['slots']) + '\nfunction read(ctx) { return ctx.connection.rpc.call("/x", "read", {}); }\nexport { read, inject };\n')
    const j4 = scan()
    if (j4.status === 0 && !j4.source.some(i => i.severity === 'blocker')) pass('J', '客户端 rpc.call 不误报')
    else fail('J', '客户端 rpc.call 被误报: status=' + j4.status + ' ' + JSON.stringify(j4.source).slice(0, 200))
  } catch (e) {
    fail('J', '严格 inject 用例失败: ' + String(e && e.message ? e.message : e))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 合成 DSH_HOME + 假 dsh 的脚手架(K/L 共用): 让 preset/模型声明来源可控且确定
function mkScanFixture(dumpText) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scan-'))
  const bin = join(dir, 'bin')
  const home = join(dir, 'home')
  mkdirSync(bin, { recursive: true })
  const fake = join(bin, 'dsh')
  writeFileSync(fake, '#!' + process.execPath + '\n' + [
    'const args = process.argv.slice(2)',
    "if (args.includes('--version')) { console.log('0.1.7-rc.1'); process.exit(0) }",
    'if (args.includes("--dump-config")) { process.stdout.write(' + JSON.stringify(dumpText) + '); process.exit(0) }',
    'process.exit(0)',
    '',
  ].join('\n'))
  chmodSync(fake, 0o755)
  const writeSession = (rel, fileName, lines) => {
    const d = join(home, 'sessions', '--ws--', rel)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, fileName), zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
  }
  const scan = () => {
    const r = spawnSync(process.execPath, [join(here, 'scan-upgrade.mjs'), '--dsh-home', home, '--profile', 'web', '--json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
      env: { ...process.env, PATH: bin + ':' + (process.env.PATH || '') },
    })
    let j = null
    try { j = JSON.parse(r.stdout || '{}') } catch { /* 输出异常时留空 */ }
    return { status: r.status, json: j, issues: (j && j.issues) || [] }
  }
  return { dir, home, scan, writeSession }
}
const dumpHeader = (id, preset, version) => JSON.stringify({ type: 'session', version, id, createdAt: 1, cwd: '/tmp', isSeeded: version >= 3, delegationDepth: 0, agentPreset: preset })

// K. scan 的 V4 支持与声明式 preset 核对（0.1.7）
{
  const dump = [
    "- id: preset-standard",
    "  name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    '    id: standard',
    '    order: 1',
    "- id: llm-pi-ai",
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      opencode-go-oai:',
    '        models:',
    '          - id: deepseek-v4.1-flash',
    '',
  ].join('\n')
  const fx = mkScanFixture(dump)
  try {
    mkdirSync(join(fx.home, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(fx.home, 'profiles', 'web', 'cordis.patch.yml'), [
      "- id: llm-pi-ai",
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      opencode-go-oai:',
      '        models:',
      '          - id: deepseek-v4.1-flash',
      '',
    ].join('\n'))
    // 同一会话目录同时有 v4(权威, ghost) 与 v3(decoy-v3): 必须按 V4 判定
    fx.writeSession('s-v4', 'session.v4.jsonl.zstd', [
      dumpHeader('s-v4', 'ghost', 4),
      JSON.stringify({ type: 'model/selection', seq: 0, time: 1, data: { provider: 'opencode-go-oai', model: 'deepseek-v4.1-flash' } }),
    ])
    fx.writeSession('s-v4', 'session.v3.jsonl.zstd', [dumpHeader('s-v4', 'decoy-v3', 3)])
    fx.writeSession('s-std', 'session.v4.jsonl.zstd', [dumpHeader('s-std', 'standard', 4)])
    mkdirSync(join(fx.home, '.agent-presets', 'ghost'), { recursive: true })
    writeFileSync(join(fx.home, '.agent-presets', 'ghost', 'preset.yml'), 'name: ghost\n')
    const r = fx.scan()
    const presetIssue = r.issues.find(i => i.category === 'preset')
    const modelIssue = r.issues.find(i => i.category === 'model')
    const fmtIssue = r.issues.find(i => i.category === 'v3')
    const legacyIssue = r.issues.find(i => i.category === 'legacy-presets')
    const okPreset = r.status === 1 && presetIssue && presetIssue.severity === 'blocker' && /ghost\(顶层 1\)/.test(presetIssue.detail) && !/decoy-v3|standard/.test(presetIssue.detail)
    const okModel = modelIssue && modelIssue.severity === 'ok' && /cordis\.patch\.yml/.test(modelIssue.detail)
    const okFmt = fmtIssue && /V4 会话 2 个/.test(fmtIssue.detail) && /保留 v2\/v3 旧文件/.test(fmtIssue.detail)
    const okLegacy = legacyIssue && legacyIssue.severity === 'warning' && /ghost/.test(legacyIssue.detail)
    if (okPreset && okModel && okFmt && okLegacy) pass('K', 'V4 优先 V3 + preset 未声明→blocker + 模型目录读 Profile patch + 旧目录残留')
    else fail('K', 'V4/preset 用例失败: ' + JSON.stringify({ status: r.status, preset: presetIssue, model: modelIssue, fmt: fmtIssue, legacy: legacyIssue }).slice(0, 500))
  } catch (e) {
    fail('K', 'V4/preset 用例异常: ' + String(e && e.message ? e.message : e))
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
}

// L. scan 的模型目录回退：无 patch 时读 dump-config；模型失效→blocker，preset 不误报
{
  const dump = [
    "- id: preset-standard",
    "  name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    '    id: standard',
    "- id: llm-pi-ai",
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      opencode-go-oai:',
    '        models:',
    '          - id: deepseek-v4.1-flash',
    '',
  ].join('\n')
  const fx = mkScanFixture(dump)
  try {
    fx.writeSession('s-bad', 'session.v3.jsonl.zstd', [
      dumpHeader('s-bad', 'standard', 3),
      JSON.stringify({ type: 'request/header', seq: 0, time: 1, data: { header: { config: { provider: 'opencode-go-oai', model: 'hy3' } } } }),
    ])
    const r = fx.scan()
    const presetIssue = r.issues.find(i => i.category === 'preset')
    const modelIssue = r.issues.find(i => i.category === 'model')
    const okModel = modelIssue && modelIssue.severity === 'blocker' && /opencode-go-oai\/hy3/.test(modelIssue.detail) && /dump-config/.test(modelIssue.detail)
    const okPreset = presetIssue && presetIssue.severity === 'ok'
    if (r.status === 1 && okModel && okPreset) pass('L', 'dump-config 回退为模型目录 + 模型 blocker 与 preset 不混淆')
    else fail('L', '模型目录回退用例失败: ' + JSON.stringify({ status: r.status, model: modelIssue, preset: presetIssue }).slice(0, 500))
  } catch (e) {
    fail('L', '模型目录回退用例异常: ' + String(e && e.message ? e.message : e))
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
}

// --full: 真实体检(scan 只跑一次, G 与 M 共用结果)
//   G = 工具正确性: JSON/退出码契约一致、未被版本门控跳过、preset 检查已执行、无未知类别
//   M = 机器干净度: 本机 scan 应为 0 blocker(真实断链已修完)
if (full) {
  const r = spawnSync(process.execPath, [join(here, 'scan-upgrade.mjs'), '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 })
  try {
    const j = JSON.parse(r.stdout || '{}')
    const blocker = j.blocker ?? (j.issues || []).filter(i => i.severity === 'blocker').length
    const warning = j.warning ?? (j.issues || []).filter(i => i.severity === 'warning').length
    const skipped = (j.issues || []).some(i => i.category === 'version' && /未达/.test(i.detail || ''))
    const cats = new Set((j.issues || []).map(i => i.category))
    const known = ['version', 'source', 'config', 'model', 'events', 'v3', 'migration', 'preset', 'legacy-presets']
    const uncovered = [...cats].filter(c => !known.includes(c))
    const contract = blocker > 0 ? r.status === 1 : r.status === 0
    const presetChecked = cats.has('preset') || cats.has('legacy-presets')
    if (contract && !skipped && j.version && presetChecked && !uncovered.length) {
      pass('G', 'scan --full: ' + j.version + ' 跑完(JSON/退出码契约一致, preset 检查已执行) — blocker=' + blocker + ' warning=' + warning)
    } else {
      fail('G', 'scan --full 异常: exit=' + r.status + ' blocker=' + blocker + ' skipped=' + skipped + ' presetChecked=' + presetChecked + ' uncovered=' + JSON.stringify(uncovered) + ' version=' + j.version)
    }
    // M: 真实机器应为 0 blocker;有 blocker 就按分类打印, 便于区分 preset / model / migration
    const blockers = (j.issues || []).filter(i => i.severity === 'blocker')
    if (r.status === 0 && blocker === 0) pass('M', '本机 scan = 0 blocker(真实断链已修完) — warning=' + warning)
    else fail('M', '本机 scan 仍有 blocker=' + blocker + ': ' + blockers.map(i => i.category + '::' + String(i.detail).slice(0, 140)).join(' | '))
  } catch (e) {
    fail('G', 'scan --json 解析失败: ' + String(e.message) + ' ' + String(r.stderr || '').slice(0, 200))
    fail('M', 'scan --json 解析失败, 无法断言 0 blocker')
  }
}

console.log('')
console.log('== selftest: ' + (failed ? failed + ' FAILED' : 'ALL PASS'))
process.exit(failed ? 1 : 0)
