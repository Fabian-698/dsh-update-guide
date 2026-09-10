#!/usr/bin/env node
/**
 * selftest — dsh-update-guide 自测（改动脚本/闸门后必跑）
 *
 * 默认快速档：
 *   A node --check 全部脚本          B scan 与 verify-session 事件类型并集一致
 *   C 内置模型 id 一致               D 闸门解析（sync-gates --list）
 *   E v2/v3 fixtures 经薄壳验证 ALL PASS   F 目录发现优先 V3 文件
 *   H S1 活跃 turn 判定（in-flight WARN / 已闭合 turn FAIL）
 *   I scan v0 迁移检查（提交区→blocker / 未提交尾部→warning）
 * --full 追加：scan-upgrade --json 必须无 blocker 且未被版本门控跳过。
 *
 * 用法：node scripts/selftest.mjs [--full]   退出码 0=PASS 1=FAIL
 */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
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
const scripts = ['scan-upgrade.mjs', 'fix-model-refs.mjs', 'repair-v0-sessions.mjs', 'verify-session.mjs', 'verify-patch.mjs', 'verify-patch-surface.mjs', 'sync-gates.mjs']
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

// --full: 真实体检
if (full) {
  const r = spawnSync(process.execPath, [join(here, 'scan-upgrade.mjs'), '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 })
  try {
    const j = JSON.parse(r.stdout || '{}')
    const blockers = j.blocker ?? (j.issues || []).filter(i => i.severity === 'blocker').length
    const skipped = (j.issues || []).some(i => i.category === 'version' && /未达/.test(i.detail || ''))
    if (r.status === 0 && blockers === 0 && !skipped && j.version) pass('G', 'scan --full: ' + j.version + ' 无 blocker 且未跳过')
    else fail('G', 'scan --full 异常: exit=' + r.status + ' blocker=' + blockers + ' skipped=' + skipped + ' version=' + j.version)
  } catch (e) {
    fail('G', 'scan --json 解析失败: ' + String(e.message) + ' ' + String(r.stderr || '').slice(0, 200))
  }
}

console.log('')
console.log('== selftest: ' + (failed ? failed + ' FAILED' : 'ALL PASS'))
process.exit(failed ? 1 : 0)
