#!/usr/bin/env node
/**
 * repair-v0-sessions — 修复无法迁移到 V3 的 v0 会话日志(dsh 0.1.5+)
 *
 * 背景:0.1.5-rc.1 的 v0→v1 迁移器是"冻结校验",会拒绝旧版本写入的三种历史形态:
 *   A. 插件消息 source 带 summary 但 form != notice(dsh-mnemon 旧版)
 *   B. subagent/descriptor version=2(字段与 v3 相同,只是版本号旧)
 *   C. assistant/chunk finish 的 v1 平铺 replayState(当前格式为 { response, blocks })
 * 这类会话在升级后打开即报 "resume failed ... refuses this format v0 Session"。
 *
 * 本脚本的做法:离线解压 → 逐行最小规范化 → 用 dsh 自带的 sessionFormatCatalog
 * 跑完整迁移链(transformed 校验) → 重新多帧压缩 → 再次完整校验 → 原子替换原文件。
 * 任何一步不通过都不写盘;已有 v3 后继的会话目录一律跳过;不删除任何原文件。
 *
 * 用法:
 *   node scripts/repair-v0-sessions.mjs [--dsh-home ~/.dsh] [--list] [--json]
 *   node scripts/repair-v0-sessions.mjs [--dsh-home ~/.dsh] --apply [--limit N] [--force]
 *     --list    只体检并列出可修复/不可修复会话(默认动作,不写盘)
 *     --apply   执行修复(要求存在 sessions.bak-* 备份,或显式 --force)
 *     --json    机器可读输出(--list)
 *     --limit   最多处理 N 个会话
 *     --force   跳过备份检查(不建议)
 * 退出码:0 = 无需修复或全部成功; 1 = 有不可修复项或 apply 失败; 2 = 环境不满足
 *
 * 约束:Node ESM、只用 node: 内建 + zstd CLI;注释/报错中文。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const ARGV = process.argv.slice(2)
const has = n => ARGV.includes(n)
const opt = (n, d) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : d }
let DSH_HOME = resolve(opt('--dsh-home', join(homedir(), '.dsh')))
const LIST = has('--list') || !has('--apply')
const APPLY = has('--apply')
const JSON_OUT = has('--json')
const FORCE = has('--force')
const LIMIT = Number(opt('--limit', '0')) || 0

// ---------- 解析 dsh 自带的格式目录(catalog) ----------
function resolveCatalog() {
  const probe = []
  if (process.env.DSH_SESSION_CATALOG) probe.push(process.env.DSH_SESSION_CATALOG)
  const which = spawnSync('which', ['dsh'], { encoding: 'utf8' })
  if (which.status === 0 && which.stdout.trim()) {
    try {
      const real = realpathSync(which.stdout.trim().split('\n')[0])
      const pkgRoot = resolve(dirname(real), '..')
      probe.push(join(pkgRoot, 'node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js'))
    } catch { /* 继续尝试其他位置 */ }
  }
  probe.push(join(dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js'))
  return probe.find(existsSync) ?? null
}

const catalogPath = resolveCatalog()
if (!catalogPath) {
  console.error('找不到 dsh-session-format-catalog(需要本机安装 dsh 0.1.5+;可用 DSH_SESSION_CATALOG 指定路径)')
  process.exit(2)
}
const { sessionFormatCatalog } = await import(pathToFileURL(catalogPath).href)

// ---------- 迁移校验(与 harness 恢复同一条链) ----------
function restore(rows) {
  const r = sessionFormatCatalog.createRestore(rows[0], { recovery: 'recoverable', validation: 'transformed' })
  for (let i = 1; i < rows.length; i++) r.decodeRow(rows[i])
  return r.finish()
}
function parseRows(text) {
  const rows = []
  for (const line of text.split('\n')) if (line.trim()) rows.push(JSON.parse(line))
  return rows
}
function decodeZstd(file) {
  const r = spawnSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, timeout: 240000 })
  if (r.status !== 0) throw new Error('zstd 解压失败: ' + String(r.stderr || '').slice(0, 120))
  return r.stdout
}

// ---------- 三类历史形态的最小规范化 ----------
// 与 dsh 校验器同语义(session-format-v0-to-v1/lib/index.js):
//   - pluginSourceValue: kind=plugin、form 已定义且非 notice 时不允许 summary;form 未定义时放行。
//     source 可嵌套在 data.source / data.message.source / data.inserted[*].source, 必须递归。
//   - subagent/descriptor: v0 源只认 version===3, 任意其他值(2、1、undefined…)都会被拒。
function stripBadPluginSummaries(value) {
  if (Array.isArray(value)) { let n = 0; for (const v of value) n += stripBadPluginSummaries(v); return n }
  if (!value || typeof value !== 'object') return 0
  let n = 0
  if (value.kind === 'plugin' && typeof value.form === 'string' && value.form !== 'notice' && value.summary !== undefined) { delete value.summary; n++ }
  for (const k of Object.keys(value)) n += stripBadPluginSummaries(value[k])
  return n
}
function normalize(rows) {
  const counts = { summary: 0, descriptor: 0, replay: 0 }
  for (const row of rows) {
    counts.summary += stripBadPluginSummaries(row.data)
    if (row.type === 'subagent/descriptor' && row.data && row.data.version !== 3) { row.data.version = 3; counts.descriptor++ }
    const rs = row.data && row.data.chunk && row.data.chunk.replayState
    if (rs && typeof rs === 'object' && Object.prototype.hasOwnProperty.call(rs, 'kind')) {
      const blocks = rs.blocks
      const response = { ...rs }
      delete response.blocks
      row.data.chunk.replayState = blocks === undefined ? { response } : { response, blocks }
      counts.replay++
    }
  }
  return counts
}

// ---------- 发现 v0-only 会话(有 v3 后继的跳过) ----------
function discover() {
  const root = join(DSH_HOME, 'sessions')
  if (!existsSync(root)) return []
  const files = []
  for (const ws of readdirSync(root)) {
    const wd = join(root, ws)
    let st; try { st = statSync(wd) } catch { continue }
    if (!st.isDirectory()) continue
    for (const sd of readdirSync(wd)) {
      const d = join(wd, sd)
      if (existsSync(join(d, 'session.v3.jsonl.zstd'))) continue
      const f = join(d, 'session.jsonl.zstd')
      if (existsSync(f)) files.push(f)
    }
  }
  return files
}

const sessRoot = join(DSH_HOME, 'sessions')
if (!existsSync(DSH_HOME) || !existsSync(sessRoot)) {
  console.error('DSH_HOME 或 sessions 目录不存在: ' + sessRoot + ' (用 --dsh-home 指定正确的 dsh 主目录)')
  process.exit(2)
}
const files = discover()
const result = { dshHome: DSH_HOME, total: files.length, clean: 0, fixable: [], unfixable: [], applied: 0, applyFailed: [] }

for (const f of files) {
  // --limit 的语义是"最多处理 N 个待修复会话";已可迁移/不可修复的不占用配额。
  // 达到上限后停止继续分类,因此 --limit 下的 clean/不可修复计数是部分值,对账时不要带 --limit。
  if (LIMIT && result.fixable.length >= LIMIT) break
  let rows
  try { rows = parseRows(decodeZstd(f)) } catch (e) { result.unfixable.push({ file: f, reason: String(e.message).slice(0, 160) }); continue }
  let beforeOk = true
  try { restore(rows) } catch { beforeOk = false }
  if (beforeOk) { result.clean++; continue }
  const rows2 = parseRows(decodeZstd(f)) // 避免解码器状态残留
  const counts = normalize(rows2)
  try {
    restore(rows2)
    result.fixable.push({ file: f, counts })
  } catch (e) {
    result.unfixable.push({ file: f, reason: String(e.message).slice(0, 160), counts })
  }
}

// ---------- apply ----------
// 备份门禁: 至少要有一个 sessions.bak-* 目录里存在与首个待修文件同相对路径的备份,
// 只放个空目录或无关文件不算数。
function hasBackupFor(relPath) {
  try {
    return readdirSync(DSH_HOME).some(n => {
      if (!n.startsWith('sessions.bak-')) return false
      try { return existsSync(join(DSH_HOME, n, relPath)) } catch { return false }
    })
  } catch { return false }
}
function applyOne(item) {
  const f = item.file
  const st0 = statSync(f)
  const rows = parseRows(decodeZstd(f))
  const counts = normalize(rows)
  // 注意:restore() 会原地展开/标注 packed row,所以序列化必须用未被 restore 碰过的 rows
  const encoded = []
  for (const row of rows) encoded.push(zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n')))
  const tmp = f + '.repair-tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  writeFileSync(tmp, Buffer.concat(encoded), { mode: 0o600 })
  try {
    const rows2 = parseRows(decodeZstd(tmp))
    restore(rows2) // 落盘前的最终校验:对重编码后的真实字节再跑一遍全链
    const st1 = statSync(f)
    if (st1.size !== st0.size || st1.mtimeMs !== st0.mtimeMs) throw new Error('源文件在校验期间被修改,放弃写入')
    if (existsSync(join(dirname(f), 'session.v3.jsonl.zstd'))) throw new Error('会话已生成 v3 后继(可能被打开或迁移),跳过源文件写入')
    if (existsSync(join(dirname(f), 'session.lock'))) throw new Error('会话被 dsh 持有(session.lock 存在),跳过源文件写入')
    renameSync(tmp, f)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

if (APPLY) {
  const targets = LIMIT ? result.fixable.slice(0, LIMIT) : result.fixable
  if (targets.length && !FORCE) {
    const firstRel = relative(sessRoot, targets[0].file)
    if (!hasBackupFor(firstRel)) {
      console.error('未发现覆盖目标会话的 sessions.bak-* 备份(需含 ' + firstRel + ');先完整备份再执行,或使用 --force(不建议)')
      process.exit(2)
    }
  }
  for (const item of targets) {
    try { applyOne(item); result.applied++; console.log('  OK    ' + item.file.replace(DSH_HOME + '/', '') + '  ' + JSON.stringify(item.counts)) }
    catch (e) { result.applyFailed.push({ file: item.file, reason: String(e.message).slice(0, 160) }); console.log('  FAIL  ' + item.file.replace(DSH_HOME + '/', '') + '  ' + String(e.message).slice(0, 120)) }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 1))
} else {
  console.log('v0-only 会话 ' + result.total + ': 已可迁移 ' + result.clean + ', 可修复 ' + result.fixable.length + ', 不可修复 ' + result.unfixable.length + (APPLY ? ', 已修复 ' + result.applied + ', 失败 ' + result.applyFailed.length : ''))
  for (const it of result.fixable) console.log('  可修复 ' + it.file.replace(DSH_HOME + '/', '') + '  ' + JSON.stringify(it.counts))
  for (const u of result.unfixable.slice(0, 10)) console.log('  不可修复 ' + u.file.replace(DSH_HOME + '/', '') + ' :: ' + u.reason)
}
process.exit(result.unfixable.length || result.applyFailed.length ? 1 : 0)
