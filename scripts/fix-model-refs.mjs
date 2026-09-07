#!/usr/bin/env node
/**
 * fix-model-refs — 批量修复 UNKNOWN_MODEL:把引用失效模型(provider/model 不在当前
 * settings.yaml 声明集)的顶层会话,切到指定模型。免手写 curl 循环。
 *
 * 用法:
 *   node fix-model-refs.mjs [--dsh-home ~/.dsh] --list
 *       只列出引用失效模型的会话(默认动作,不改动任何东西)
 *   node fix-model-refs.mjs [--dsh-home ~/.dsh] \
 *        --provider deepseek-official --model deepseek-v4-flash \
 *        [--reasoningEffort high] [--all] [--dry-run] [--token-file <cookie>]
 *        --provider/--model 指定目标;默认只切"引用无效"的会话,
 *        --all 强制所有顶层会话都切到目标(统一切换)。
 *        --dry-run 只打印将发送的会话列表与请求,不发请求。
 *        --token-file 指定登录 cookie jar(先 curl -c 拿好);缺省则自动
 *        尝试 GET /?token=DSH_TOKEN (env) 建档。
 *
 * 判定与 scan-upgrade.mjs 的 checkModelRefs 完全一致(优先 model/selection,
 * 否则 request/header;跳过子代理会话)。
 *
 * 退出码: 0 = 全部成功(或 --list 无失效); 1 = 有失败/有失效未修。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ARGV = process.argv.slice(2)
let DSH_HOME = homedir() + '/.dsh'
const homeIdx = ARGV.indexOf('--dsh-home')
if (homeIdx >= 0 && ARGV[homeIdx + 1]) DSH_HOME = resolve(ARGV[homeIdx + 1])
const opt = (name, def) => {
  const i = ARGV.indexOf(name)
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : def
}
const has = name => ARGV.includes(name)
const LIST = has('--list')
const PROVIDER = opt('--provider', null)
const MODEL = opt('--model', null)
const EFFORT = opt('--reasoningEffort', 'high')
const ALL = has('--all')
const DRY = has('--dry-run')
const COOKIE_FILE = opt('--token-file', null)

const BASE = 'http://127.0.0.1:3080'

// ---------- settings.yaml providers 解析(与 scan-upgrade.mjs 同一逻辑) ----------
function parseProviders(settingsText) {
  const providers = new Map()
  let curName = null
  for (const line of settingsText.split('\n')) {
    const pm = line.match(/^    (\S+):\s*$/)
    if (pm) { curName = pm[1]; providers.set(curName, new Set()); continue }
    if (curName !== null) {
      const mm = line.match(/^        - id:\s*(\S+)/)
      if (mm) providers.get(curName).add(mm[1])
      else if (/^  \S+:/.test(line)) curName = null
    }
  }
  return providers
}

const OFFICIAL_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'])

function collectTopLevelSessions() {
  const sessRoot = join(DSH_HOME, 'sessions')
  if (!existsSync(sessRoot)) return []
  const sessions = [] // {id, file, ref, provider, model, invalid}
  for (const ws of readdirSync(sessRoot)) {
    const wd = join(sessRoot, ws)
    if (!statSync(wd).isDirectory()) continue
    for (const sd of readdirSync(wd)) {
      const f = join(wd, sd, 'session.jsonl.zstd')
      if (!existsSync(f)) continue
      const r = spawnSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 90_000 })
      if (r.status !== 0) continue
      const firstLine = r.stdout.split('\n', 1)[0] ?? ''
      if (/"origin"\s*:\s*"subagent"/.test(firstLine) || /"kind"\s*:\s*"subagent"/.test(firstLine)) continue
      let sel = null, hdr = null
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
      const slash = ref.indexOf('/')
      const provider = ref.slice(0, slash)
      const model = ref.slice(slash + 1)
      sessions.push({ id: sd, file: f, ref, provider, model })
    }
  }
  return sessions
}

// ---------- 登录 ----------
function ensureCookie() {
  if (COOKIE_FILE && existsSync(COOKIE_FILE)) return COOKIE_FILE
  const token = process.env.DSH_TOKEN
  if (!token) return null
  const jar = COOKIE_FILE || '/tmp/dsh-fix-model-refs-cookies.txt'
  const r = spawnSync('curl', ['-s', '-c', jar, '-o', '/dev/null', `${BASE}/?token=${token}`], { encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) return null
  return jar
}

function selectModel(sid, provider, model, jar) {
  const body = JSON.stringify({
    type: 'client-request', rpcId: 'fix-' + Date.now() % 100000,
    method: 'session/selectModel',
    payload: { args: { request: { sessionId: sid, provider, model, reasoningEffort: EFFORT } } },
  })
  const args = ['-s', '-b', jar, '-X', 'POST', '-H', 'Content-Type: application/json',
    `${BASE}/api/session/selectModel`, '--data-binary', '@-']
  const r = spawnSync('curl', args, { encoding: 'utf8', input: body, timeout: 30_000 })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

// ---------- 主流程 ----------
const settingsFile = join(DSH_HOME, 'settings.yaml')
const settingsText = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : ''
const providers = parseProviders(settingsText)

const sessions = collectTopLevelSessions()
for (const s of sessions) {
  if (s.provider === 'deepseek-official') s.invalid = !OFFICIAL_MODELS.has(s.model)
  else s.invalid = !(providers.get(s.provider)?.has(s.model) ?? false)
}
const invalid = sessions.filter(s => s.invalid)
const validCount = sessions.length - invalid.length

console.log(`扫描: 顶层 ${sessions.length} 会话(子代理已跳过), 引用有效 ${validCount}, 无效 ${invalid.length}`)
if (invalid.length) {
  for (const s of invalid) console.log(`  INVALID ${s.ref}  <- ${s.id}`)
} else {
  console.log('无失效模型引用,无需修复')
}

if (LIST || !PROVIDER || !MODEL) {
  if (invalid.length) console.log('\n修复: 见 SKILL.md 模型章节 / references/model-fix.md,或用:')
  if (invalid.length) console.log(`  node fix-model-refs.mjs --provider <p> --model <m> [--all] [--dry-run] [--token-file <cookie>]`)
  process.exit(invalid.length ? 1 : 0)
}

// 目标模型合法性预检
const targetOk = PROVIDER === 'deepseek-official' ? OFFICIAL_MODELS.has(MODEL) : (providers.get(PROVIDER)?.has(MODEL) ?? false)
if (!targetOk) {
  console.error(`目标模型不在声明集: ${PROVIDER}/${MODEL}(settings.yaml 无此 provider/model)`)
  process.exit(2)
}

const targets = ALL ? sessions : invalid
if (!targets.length) { console.log('没有需要切换的会话'); process.exit(0) }
console.log(`\n目标模型: ${PROVIDER}/${MODEL} (reasoningEffort=${EFFORT})${ALL ? ' [--all 强制全部]' : ''} ——共 ${targets.length} 会话`)

if (DRY) {
  for (const s of targets) console.log(`  WOULD  ${s.ref} -> ${PROVIDER}/${MODEL}  (${s.id})`)
  process.exit(0)
}

const jar = ensureCookie()
if (!jar) {
  console.error('未取得登录 cookie:请先 curl -c <file> "http://127.0.0.1:3080/?token=<TOKEN>" 然后用 --token-file <file>')
  process.exit(2)
}

let ok = 0, fail = 0
for (const s of targets) {
  const r = selectModel(s.id, PROVIDER, MODEL, jar)
  if (r.status !== 0 || /"ok"\s*:\s*false/.test(r.stdout)) {
    fail++
    console.log(`  FAIL  ${s.ref} -> ${PROVIDER}/${MODEL}  (${s.id}): ${(r.stdout || r.stderr || '').slice(0, 160)}`)
  } else {
    ok++
    console.log(`  OK    ${s.ref} -> ${PROVIDER}/${MODEL}  (${s.id})`)
  }
}
console.log(`\n完成: 成功 ${ok} / 失败 ${fail}${fail ? '(失败多为 token 过期或会话忙,可重跑,幂等)' : ''}`)
process.exit(fail ? 1 : 0)
