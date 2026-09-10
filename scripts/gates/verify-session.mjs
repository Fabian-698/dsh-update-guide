#!/usr/bin/env node
/**
 * dsh-verify-session: 会话日志完整性闸门（离线，复刻 harness 恢复时的校验语义）。
 * 检查会话日志本身是否损坏——损坏的日志会导致 session 恢复被整包拒绝或
 * session.list 整体 500。素材：官方 SessionLogScanner 语义 + 社区报告
 * （dsh discussion #1043/#1333/#1363/#1452/#1469/#1497/#1538/#1550 等）。
 *
 * 0.1.5 起同一会话目录可能存在两代物理文件：v3（session.v3.jsonl.zstd，
 * header version=3）与旧版（session.jsonl.zstd，header version=0）。发现逻辑
 * 每个会话目录只取权威一代：v3 优先，无 v3 时才取旧版；显式路径也可直接给
 * session[.vN].jsonl[.zstd] 文件。
 *
 * 用法：
 *   node verify-session.mjs [<path>|--all|--latest] [--json] [--heap-mb N]
 *                           [--ignore-type t1,t2] [--lenient-unknown]
 *   <path>      单个会话文件（session[.vN].jsonl[.zstd]；也接受会话目录）
 *   --latest    最新修改的会话（默认）
 *   --all       扫描 ~/.dsh/sessions 下全部会话（输出 v2/v3 计数）
 *   --heap-mb   物化堆估算阈值（默认 1024，超了 warn 冷启动卡顿风险）
 *   --ignore-type 追加合法事件类型（第三方插件扩展时用）
 *   --lenient-unknown 未知事件类型降级为 warn（默认 FAIL：harness 恢复会整包拒绝）
 * 退出码：0 = 通过（含 warn/skip）；1 = 有 FAIL；2 = 找不到会话文件。
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
  <path>  单个会话文件（session[.vN].jsonl[.zstd]；也接受会话目录，v3 优先）
  --latest 最新修改的会话（默认）；--all 全部会话（每个会话目录只取权威一代）
  --ignore-type 追加合法事件类型；--lenient-unknown 未知类型降级 warn
退出码: 0=通过（含 warn/skip）；1=有 FAIL；2=找不到会话文件`)
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

// ---------- 已知事件类型（v2 ∪ v3 并集，与 dsh-update-guide/scripts/scan-upgrade.mjs 完全一致） ----------
// v3 部分同步官方 0.1.5 @deepseek-ai/dsh-session/lib/types/known-event-types.js
// （由 scripts/gen-persistence-catalog.ts 生成）；v2 兼容部分保留 header 记录
// （session）与存储记录层（reasoning-chunks/text-chunks/tool-call-chunks）及
// 0.1.2 时代类型（assistant/chunk、tool/code-dispatch、tool/code-dispatch-start）。
// 两处列表必须逐项一致（selftest 校验），增删请同步。
const KNOWN_TYPES = new Set([
  'session', 'permission/preset', 'sandbox/mode', 'approval/policy', 'approval/asked', 'approval/decided',
  'agent-preset/selected', 'agent/inbox/spliced',
  'step/start', 'step/end', 'turn/start', 'turn/end',
  'user/message', 'assistant/message', 'assistant/attempt', 'assistant/chunk',
  'reasoning-chunks', 'text-chunks', 'tool-call-chunks', 'system/message',
  'tool/call', 'tool/result', 'tool/code-dispatch', 'tool/code-dispatch-start',
  'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
  'request/context', 'request/header',
  'compaction/start', 'compaction/end', 'compaction/prune', 'compaction/summary',
  'llm/retry', 'llm/retry-started',
  'session/end-seed', 'session/title', 'session/title-llm-request',
  'command/run', 'command/done', 'todo/write', 'web/deepseek-search-llm-request',
  'feedback/record', 'feedback/message-put', 'feedback/message-delete', 'deliverables/presented',
  'goal/change', 'hook/invoked', 'hook/result', 'model/selection',
  'plan/mode', 'schedule/change', 'session-log-deepseek/delivery-accepted',
  'subagent/descriptor', 'subagent/catalog', 'subagent/model-selection-policy',
  'team/member', 'team/task', 'team/message/queued', 'team/message/delivered',
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
const V3_ZSTD = 'session.v3.jsonl.zstd'
const V2_ZSTD = 'session.jsonl.zstd'
const V3_JSONL = 'session.v3.jsonl'
const V2_JSONL = 'session.jsonl'

// 一个会话目录的权威文件：v3 优先（新的物理代），无 v3 时才用旧版；
// 避免同一会话的两代文件被重复扫描。
function authorityInDir(dir) {
  for (const name of [V3_ZSTD, V3_JSONL, V2_ZSTD, V2_JSONL]) {
    const f = join(dir, name)
    let st
    try { st = statSync(f) } catch { continue }
    if (st.isFile()) return f
  }
  return null
}

// 文件名对应的物理代（用于 v2/v3 计数与 S12 一致性检查）
function generationOf(path) {
  const b = basename(path)
  if (b === V3_ZSTD || b === V3_JSONL) return 'v3'
  if (b === V2_ZSTD || b === V2_JSONL) return 'v2'
  return 'unknown'
}

function countGens(list) {
  const counts = { v2: 0, v3: 0, unknown: 0 }
  for (const f of list) counts[generationOf(f)]++
  return counts
}

// 取第一个非 flag 参数作为显式路径（跳过 --heap-mb/--ignore-type 的值）
function explicitPathArg() {
  const valueFlags = new Set(['--heap-mb', '--ignore-type'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      if (valueFlags.has(a)) i++
      continue
    }
    return a
  }
  return null
}

function sessionFiles() {
  const explicit = explicitPathArg()
  if (explicit) {
    let real = explicit
    try { real = realpathSync(explicit) } catch { return { files: [], counts: countGens([]) } }
    let st
    try { st = statSync(real) } catch { return { files: [], counts: countGens([]) } }
    if (st.isDirectory()) {
      const f = authorityInDir(real)
      const files = f ? [f] : []
      return { files, counts: countGens(files) }
    }
    // 直接文件：只接受会话日志命名（.jsonl.zstd / .jsonl），session.lock 之类不算会话
    const files = st.isFile() && /\.jsonl(?:\.zstd)?$/.test(real) ? [real] : []
    return { files, counts: countGens(files) }
  }
  const files = []
  const sessionsRoot = join(DSH_HOME, 'sessions')
  if (!existsSync(sessionsRoot)) return { files, counts: countGens(files) }
  for (const ws of readdirSync(sessionsRoot)) {
    const wsDir = join(sessionsRoot, ws)
    let st
    try { st = statSync(wsDir) } catch { continue }
    if (!st.isDirectory()) continue
    for (const sd of readdirSync(wsDir)) {
      const sdDir = join(wsDir, sd)
      let sst
      try { sst = statSync(sdDir) } catch { continue }
      if (!sst.isDirectory()) continue
      const f = authorityInDir(sdDir)
      if (f) files.push(f)
    }
  }
  if (argv.includes('--all')) return { files, counts: countGens(files) }
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const latest = files.slice(0, 1) // --latest 默认
  return { files: latest, counts: countGens(latest) }
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
  let headerRaw = ''
  for (const line of text.split('\n')) {
    lineNo++
    if (!line.trim()) continue
    if (!headerRaw) headerRaw = line.trim()
    let d
    try { d = JSON.parse(line) } catch {
      report('FAIL', 'JSON', `第 ${lineNo} 行 JSON 损坏（恢复时会拒绝该行）`, path)
      continue
    }
    if (typeof d.type === 'string') events.push(d)
  }
  report('PASS', 'JSON', `解析 ${events.length} 个事件（${lineNo} 行）`)

  // S12 文件名与 header.version 一致性（0.1.5 起 v3 文件名为 session.v3.jsonl[.zstd]）
  // 官方 generationLogFilename：version 0 → session.jsonl[.zstd]；version N≥1 → session.vN.jsonl[.zstd]。
  // 旧 header 的 version 0/1/2 均合法（本机旧文件大量为 0），不按数字硬校验；
  // 只有 v3 文件名配非 3 version 是硬错误，旧文件名配 version 3 提示未来重命名。
  {
    let hdr = null
    try { hdr = JSON.parse(headerRaw) } catch {}
    const gen = generationOf(path)
    if (!hdr || hdr.type !== 'session') {
      check(false, 'S12', 'header 记录合法（首行 type 必须是 session）',
        hdr ? `type=${JSON.stringify(hdr.type)}` : '首行 JSON 不可解析')
    } else if (gen === 'v3') {
      check(hdr.version === 3, 'S12', 'V3 文件名与 header.version 一致',
        `version=${String(hdr.version)}（应为 3）`)
    } else if (gen === 'v2' && hdr.version === 3) {
      report('WARN', 'S12', `文件名 ${basename(path)} 与 header.version=3 不符（迁移后未重命名？）`, '')
    } else {
      report('PASS', 'S12', `header 与文件名一致（version=${String(hdr.version)}）`, '')
    }
  }

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

  // S1 孤儿 tool_call：callId 无对应 tool/result。
  // 0.1.5 的 PTC 会话在 run_code 执行期间会先写入嵌套 tool/ptc-dispatch* 事件，根 tool/call
  // 因此会被挤出"最后 3 条"窗口，但它仍在飞；只按尾部窗口判断会把活会话误报成损坏。
  // 规则：未闭合 turn（最后一个 turn 没有 turn/end）内的未配对调用按 WARN；
  //       只有已闭合 turn 里的孤儿调用才 FAIL（那才是恢复会拒绝的损坏）。
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
    const turnStarts = events.filter(e => e.type === 'turn/start' && typeof e.seq === 'number')
    const turnEnds = events.filter(e => e.type === 'turn/end').length
    const openTurnSeq = turnStarts.length > turnEnds ? turnStarts[turnStarts.length - 1].seq : null
    const lastSeqs = new Set(events.slice(-3).map(e => e.seq))
    const orphans = calls.filter(c => !resultIds.has(c.id))
    const isInFlight = c => lastSeqs.has(c.seq) || (openTurnSeq !== null && typeof c.seq === 'number' && c.seq >= openTurnSeq)
    const inFlight = orphans.filter(isInFlight)
    const stale = orphans.filter(c => !isInFlight(c))
    check(stale.length === 0, 'S1', '孤儿 tool_call（无对应 tool/result 且不在活跃 turn）',
      stale.length ? `seq=${stale.map(c => c.seq).join(',')}` : (inFlight.length ? `${inFlight.length} 个活跃 in-flight（warn 级）` : ''))
    if (inFlight.length > 0 && stale.length === 0) report('WARN', 'S1', '活跃 turn 内 in-flight 工具调用（会话仍在运行则正常）', `seq=${inFlight.map(c => c.seq).join(',')}`)
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
const { files, counts } = sessionFiles()
if (files.length === 0) {
  console.error('verify-session: 找不到会话文件（指定路径或确认 ~/.dsh/sessions 存在）')
  process.exit(2)
}
if (!jsonOut) console.log(`== dsh-verify-session: ${files.length} 个会话（v3=${counts.v3} / v2=${counts.v2}${counts.unknown ? ` / 其它=${counts.unknown}` : ''}）\n`)
for (const f of files) {
  if (!jsonOut) console.log(`--- ${f}`)
  checkSession(f)
  if (!jsonOut) console.log('')
}
if (jsonOut) console.log(JSON.stringify({ files, counts, checks: results, failed }, null, 2))
else console.log(`== 结果：${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}${failed ? ' — 日志损坏可能导致会话恢复被拒绝或列表 500' : ''}`)
process.exit(failed === 0 ? 0 : 1)
