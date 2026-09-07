#!/usr/bin/env node
/**
 * dsh-verify-session: 会话日志完整性闸门（离线，复刻 harness 恢复时的校验语义）。
 * 检查会话日志本身是否损坏——损坏的日志会导致 session 恢复被整包拒绝或
 * session.list 整体 500。素材：官方 SessionLogScanner 语义 + 社区报告
 * （dsh discussion #1043/#1333/#1363/#1452/#1469/#1497/#1538/#1550 等）。
 *
 * 用法：
 *   node verify-session.mjs [<path>|--all|--latest] [--json] [--heap-mb N]
 *                           [--ignore-type t1,t2] [--lenient-unknown]
 *   <path>      单个会话文件（.jsonl.zstd 或 .jsonl；也接受会话目录 session-*）
 *   --latest    最新修改的会话（默认）
 *   --all       扫描 ~/.dsh/sessions 下全部会话
 *   --heap-mb   物化堆估算阈值（默认 1024，超了 warn 冷启动卡顿风险）
 *   --ignore-type 追加合法事件类型（第三方插件扩展时用）
 *   --lenient-unknown 未知事件类型降级为 warn（默认 FAIL：harness 恢复会整包拒绝）
 * 退出码：0 = 通过（含 warn/skip）；1 = 有 FAIL。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'

// ---------- 参数 ----------
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`dsh-verify-session: 会话日志完整性闸门（离线）
用法: node verify-session.mjs [<path>|--all|--latest] [--json] [--heap-mb N] [--ignore-type t1,t2] [--lenient-unknown]
  <path>  单个会话文件（.jsonl.zstd 或 .jsonl；也接受会话目录）
  --latest 最新修改的会话（默认）；--all 全部会话
  --ignore-type 追加合法事件类型；--lenient-unknown 未知类型降级 warn
退出码: 0=通过（含 warn/skip）；1=有 FAIL`)
  process.exit(0)
}
const arg = (flag, fallback) => {
  const eq = argv.find(a => a.startsWith(`${flag}=`))
  if (eq) return eq.slice(flag.length + 1)
  const idx = argv.indexOf(flag)
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1]
  return fallback
}
const jsonOut = argv.includes('--json')
const lenientUnknown = argv.includes('--lenient-unknown')
const heapMb = parseInt(arg('--heap-mb', '1024'), 10) || 1024
const ignoreTypes = new Set(arg('--ignore-type', '').split(',').map(s => s.trim()).filter(Boolean))
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

// ---------- 已知事件类型（2026-09-06 同步官方 dsh-session 0.1.2-rc.1 known-event-types.js 全集） ----------
// 注意：官方全集见 @deepseek-ai/dsh-session/lib/types/known-event-types.js
// （由 scripts/gen-persistence-catalog.ts 生成）；这里保留向后兼容的额外
// 记录层类型（session/reasoning-chunks/text-chunks/tool-call-chunks 为存储记录层，
// 非事件）。官方新增的 0.1.2 事件类型（model/selection、plan/mode、hook/*、
// team/*、tool-workflow/*、compaction/prune、schedule/change、feedback/record、
// subagent/model-selection-policy、session-log-deepseek/delivery-accepted 等）已补齐。
const KNOWN_TYPES = new Set([
  'session', 'permission/preset', 'sandbox/mode', 'approval/policy', 'approval/asked', 'approval/decided',
  'agent-preset/selected',
  'step/start', 'step/end', 'turn/start', 'turn/end',
  'user/message', 'assistant/message', 'assistant/chunk',
  'reasoning-chunks', 'text-chunks', 'tool-call-chunks',
  'tool/call', 'tool/result', 'tool/code-dispatch', 'tool/code-dispatch-start',
  'request/context', 'request/header', 'agent/inbox/spliced',
  'compaction/start', 'compaction/end', 'compaction/prune', 'compaction/summary',
  'llm/retry', 'llm/retry-started',
  'session/end-seed', 'session/title', 'session/title-llm-request',
  'command/run', 'command/done', 'todo/write', 'web/deepseek-search-llm-request',
  'feedback/record', 'goal/change', 'hook/invoked', 'hook/result', 'model/selection',
  'plan/mode', 'schedule/change', 'session-log-deepseek/delivery-accepted',
  'subagent/descriptor', 'subagent/model-selection-policy',
  'team/member', 'team/task',
  'tool-workflow/agent-end', 'tool-workflow/agent-start',
  'tool-workflow/run-end', 'tool-workflow/run-start',
])

// ---------- 输出 ----------
let failed = 0
const results = []
function report(kind, id, label, evidence = '') {
  results.push({ id, kind, label, evidence })
  if (kind === 'FAIL') failed++
  if (!jsonOut) console.log(`${kind.padEnd(4)} ${id}  ${label}${evidence ? `  [${evidence}]` : ''}`)
}
const check = (cond, id, label, evidence = '', failKind = 'FAIL') =>
  report(cond ? 'PASS' : failKind, id, label, evidence)

// ---------- 目标文件解析 ----------
function sessionFiles() {
  if (argv[0] && !argv[0].startsWith('--')) {
    const p = argv[0]
    let real = p
    try { real = realpathSync(p) } catch {}
    if (statSync(p).isDirectory()) {
      const cand = join(p, 'session.jsonl.zstd')
      return existsSync(cand) ? [cand] : []
    }
    return [real]
  }
  const all = []
  const sessionsRoot = join(DSH_HOME, 'sessions')
  if (!existsSync(sessionsRoot)) return all
  for (const ws of readdirSync(sessionsRoot)) {
    const wsDir = join(sessionsRoot, ws)
    let st
    try { st = statSync(wsDir) } catch { continue }
    if (!st.isDirectory()) continue
    for (const sd of readdirSync(wsDir)) {
      const f = join(wsDir, sd, 'session.jsonl.zstd')
      if (existsSync(f)) all.push(f)
    }
  }
  if (argv.includes('--all')) return all
  all.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return all.slice(0, 1) // --latest 默认
}

// ---------- 单会话检查 ----------
function checkSession(path) {
  const isZstd = path.endsWith('.zstd')
  let text = ''
  if (isZstd) {
    const z = spawnSync('zstd', ['-dc', path], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
    if (z.status !== 0 || z.error) {
      report('SKIP', 'S9', `zstd 解压失败或不可用（${z.error?.message ?? `exit=${z.status}`}），全部内容检查跳过`, path)
      return
    }
    text = z.stdout
  } else {
    try { text = readFileSync(path, 'utf8') } catch (e) {
      report('FAIL', 'READ', '会话文件不可读', `${e.message} ${path}`)
      return
    }
  }
  const fileBytes = isZstd ? statSync(path).size : Buffer.byteLength(text)

  const events = []
  let lineNo = 0
  for (const line of text.split('\n')) {
    lineNo++
    if (!line.trim()) continue
    let d
    try { d = JSON.parse(line) } catch {
      report('FAIL', 'JSON', `第 ${lineNo} 行 JSON 损坏（恢复时会拒绝该行）`, path)
      continue
    }
    if (typeof d.type === 'string') events.push(d)
  }
  report('PASS', 'JSON', `解析 ${events.length} 个事件（${lineNo} 行）`)

  // S6 seq 完整性：单调递增 + 首个 seq=0 是硬约束（回退/重复=损坏）。
  // 空洞不判 FAIL：harness 压缩（surfaceOp: replace 投影层）会在文件级留 seq 空洞且正常恢复——
  // 实测活跃会话 364 处空洞仍可恢复；空洞与「截断损坏」无法从文件可靠区分，故降 WARN。
  {
    let prev = null
    let firstSeqSeen = null
    let reverse = []
    let gapCount = 0
    let maxGap = 0
    for (const d of events) {
      if (typeof d.seq !== 'number') continue
      if (firstSeqSeen === null) firstSeqSeen = d.seq
      if (prev !== null) {
        if (d.seq <= prev) {
          reverse.push(`${d.type}@seq${d.seq}（prev=${prev}）`)
          if (reverse.length >= 3) break
        } else if (d.seq > prev + 1) {
          gapCount++
          maxGap = Math.max(maxGap, d.seq - prev - 1)
        }
      }
      prev = d.seq
    }
    const firstBad = firstSeqSeen !== null && firstSeqSeen !== 0
    check(reverse.length === 0 && !firstBad, 'S6', 'seq 完整性（单调递增、首 seq=0）',
      reverse.length ? reverse.join(', ') : (firstBad ? `首个带 seq 事件 seq=${firstSeqSeen}（应为 0）` : ''))
    if (reverse.length === 0 && !firstBad && gapCount > 0) {
      report('WARN', 'S6', `seq 存在 ${gapCount} 处空洞（最大 ${maxGap}）——压缩投影的正常痕迹，harness 恢复不受影响`, '')
    }
  }

  // S1 孤儿 tool_call：callId 无对应 tool/result；活跃尾部的 in-flight 调用按 warn 不 FAIL。
  {
    const calls = []
    const resultIds = new Set()
    const collect = (v, out) => {
      if (Array.isArray(v)) return v.forEach(x => collect(x, out))
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if ((k === 'callId' || k === 'toolCallId') && typeof x === 'string') out.add(x)
          else collect(x, out)
        }
      }
    }
    for (const d of events) {
      if (d.type === 'tool/call' && typeof d.data?.callId === 'string') calls.push({ id: d.data.callId, seq: d.seq })
      if (d.type === 'tool/result') collect(d.data, resultIds)
    }
    const lastSeqs = new Set(events.slice(-3).map(e => e.seq))
    const orphans = calls.filter(c => !resultIds.has(c.id))
    const inFlight = orphans.filter(c => lastSeqs.has(c.seq))
    const stale = orphans.filter(c => !lastSeqs.has(c.seq))
    check(stale.length === 0, 'S1', '孤儿 tool_call（无对应 tool/result 且非活跃尾部）',
      stale.length ? `seq=${stale.map(c => c.seq).join(',')}` : (inFlight.length ? `${inFlight.length} 个活跃尾部 in-flight（warn 级）` : ''))
    if (inFlight.length > 0 && stale.length === 0) report('WARN', 'S1', '活跃尾部 in-flight 工具调用（会话仍在运行则正常）', `seq=${inFlight.map(c => c.seq).join(',')}`)
  }

  // S2 未闭合 turn
  {
    const starts = events.filter(e => e.type === 'turn/start').length
    const ends = events.filter(e => e.type === 'turn/end').length
    if (starts > ends + 1) check(false, 'S2', '未闭合 turn（卡「运行中」）', `turn/start=${starts} turn/end=${ends}`)
    else if (starts === ends + 1) report('WARN', 'S2', '存在一个未闭合 turn（会话活跃中则正常）', `turn/start=${starts} turn/end=${ends}`)
    else check(true, 'S2', 'turn 闭合平衡', `start=${starts} end=${ends}`)
  }

  // S8 未知事件类型（第三方插件合法扩展用 --ignore-type 或 --lenient-unknown）
  {
    const unknown = [...new Set(events.map(e => e.type).filter(t => !KNOWN_TYPES.has(t) && !ignoreTypes.has(t)))]
    check(unknown.length === 0, 'S8', '未知事件类型（harness 恢复整包拒绝的前提）',
      unknown.join(', '), lenientUnknown ? 'WARN' : 'FAIL')
  }

  // S9 zstd 帧数（单帧日志 → session.list 整体 500）
  if (isZstd) {
    const l = spawnSync('zstd', ['-l', path], { encoding: 'utf8' })
    if (l.status !== 0) {
      report('SKIP', 'S9', 'zstd -l 不可用，跳过帧数检查', path)
    } else {
      const frameLine = l.stdout.split('\n').map(s => s.trim()).filter(Boolean)[1] ?? ''
      const frames = parseInt(frameLine.split(/\s+/)[0], 10)
      check(!Number.isNaN(frames) && frames > 1, 'S9', 'zstd 多帧容器', Number.isNaN(frames) ? `无法解析帧数: ${frameLine}` : `frames=${frames}`)
    }
  } else {
    report('SKIP', 'S9', '非 .zstd 输入，跳过帧数检查', '')
  }

  // S10 sourceEventSeqs 引用必须指向更早的事件
  // 0.1.2 起编码为 range-pairs 形式：数字 = 单条 seq；[start, end] = 连续区间
  // （官方 decodeSeqRanges：start<=end、全部非负安全整数、解码后严格递增）。
  // 区间内任一条都必须在当前事件 seq 之前，即 end < d.seq 即可。
  {
    let bad = []
    for (const d of events) {
      const refs = d.sourceEventSeqs
      if (!Array.isArray(refs) || typeof d.seq !== 'number') continue
      const scan = (r) => {
        if (typeof r === 'number') {
          return Number.isSafeInteger(r) && r >= 0 && r < d.seq
        }
        if (Array.isArray(r) && r.length === 2 && Number.isSafeInteger(r[0]) && Number.isSafeInteger(r[1])) {
          return r[0] >= 0 && r[1] >= r[0] && r[1] < d.seq
        }
        return false
      }
      for (const r of refs) {
        if (!scan(r)) {
          bad.push(`${d.type}@seq${d.seq} refs=${JSON.stringify(r)}`)
          if (bad.length >= 3) break
        }
      }
      if (bad.length >= 3) break
    }
    check(bad.length === 0, 'S10', 'sourceEventSeqs 只引用更早事件', bad.join(', '))
  }

  // S11 物化堆估算（max(事件×600B, 字节×6) 超阈值 → 冷启动卡顿风险）
  {
    const heapEst = Math.max(events.length * 600, fileBytes * 6)
    const limit = heapMb * 1024 * 1024
    const over = heapEst > limit
    report(over ? 'WARN' : 'PASS', 'S11', `物化堆估算 ${(heapEst / 1024 / 1024).toFixed(0)} MiB（阈值 ${heapMb} MiB）`,
      over ? '冷启动/恢复卡顿风险' : '')
  }
}

// ---------- 主流程 ----------
const files = sessionFiles()
if (files.length === 0) {
  console.error('verify-session: 找不到会话文件（指定路径或确认 ~/.dsh/sessions 存在）')
  process.exit(2)
}
if (!jsonOut) console.log(`== dsh-verify-session: ${files.length} 个会话\n`)
for (const f of files) {
  if (!jsonOut) console.log(`--- ${f}`)
  checkSession(f)
  if (!jsonOut) console.log('')
}
if (jsonOut) console.log(JSON.stringify({ files, checks: results, failed }, null, 2))
else console.log(`== 结果：${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}${failed ? ' — 日志损坏可能导致会话恢复被拒绝或列表 500' : ''}`)
process.exit(failed === 0 ? 0 : 1)
