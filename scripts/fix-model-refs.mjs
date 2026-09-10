#!/usr/bin/env node
/**
 * fix-model-refs — 批量修复 UNKNOWN_MODEL:把引用失效模型(provider/model 不在当前
 * settings.yaml 声明集)的顶层会话,切到指定模型。免手写 curl 循环。
 *
 * 兼容 dsh 0.1.5 会话存储:每个会话目录优先 session.v3.jsonl.zstd(V3),否则回退
 * session.jsonl.zstd(旧格式);V3 与旧格式的 model/selection、request/header 解析一致。
 * 子代理会话(header origin/kind=subagent、delegationDepth>0、parentSession 任一)跳过。
 *
 * 用法:
 *   node fix-model-refs.mjs [--dsh-home ~/.dsh] --list
 *       只列出引用失效模型的会话(默认动作,不改动任何东西)
 *   node fix-model-refs.mjs [--dsh-home ~/.dsh] \
 *        --provider deepseek-official --model deepseek-flash \
 *        [--reasoningEffort high] [--all] [--dry-run] [--token-file <cookie>]
 *        --provider/--model 指定目标(0.1.5 推荐 deepseek-official/deepseek-flash);
 *        默认只切"引用无效"的会话,--all 强制所有顶层会话都切到目标(统一切换)。
 *        --dry-run 只打印将发送的会话列表与请求,不发请求。
 *        --token-file 指定登录 cookie jar(先 curl -c 拿好);缺省则自动
 *        尝试 GET /?token=DSH_TOKEN (env) 建档。
 *
 * 模型声明集(与 scan-upgrade.mjs 语义一致):
 *   deepseek-official = 0.1.5 内置 4 个 id(deepseek-flash、deepseek-v4-flash、
 *   deepseek-v4-pro、deepseek-v4-flash-vision-exp) ∪ settings.yaml 顶层
 *   llm-deepseek.models[*].id;其他 provider 取 llm-pi-ai.providers.<name>.models[*].id。
 *
 * 注意: 自 dsh 0.1.5 起,session/selectModel 成功后会把选择同时写入全局默认模型
 * (agentDefaultModel.saveSelection);非 --dry-run 的批量修复会改默认模型。
 *
 * 退出码: 0 = 全部成功(或 --list 无失效); 1 = 有失败/有失效未修; 2 = 目标模型不在声明集。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ARGV = process.argv.slice(2)
let DSH_HOME = homedir() + '/.dsh'
const homeIdx = ARGV.indexOf('--dsh-home')
if (homeIdx >= 0) {
  const v = ARGV[homeIdx + 1]
  if (!v || v.startsWith('--')) { console.error('--dsh-home 缺少目录参数(例: --dsh-home ~/.dsh)'); process.exit(2) }
  DSH_HOME = resolve(v)
}
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

// ---------- settings.yaml 模型目录解析(与 scan-upgrade.mjs 的缩进栈实现同一语义) ----------
// 只认两条路径: llm-pi-ai.providers.<name>.models[*].id 与顶层 llm-deepseek.models[*].id。
// 旧实现按固定缩进匹配, 会把 include/tools 等层级的 - id 误收成 provider/model,
// 导致目标预检通过但 dsh 实际不认; 现与 scan 共用"缩进栈 + 路径校验"。
function parseSettingsModelCatalog(settingsText) {
  const providers = new Map() // name -> Set(modelId)
  const deepseek = new Set()
  const stack = [] // {indent, key}
  const unquote = s => s.replace(/^["']|["']$/g, '')
  for (const rawLine of settingsText.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '')
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = line.match(/^\s*/)[0].length
    const body = line.trim()
    const li = body.match(/^-\s*id:\s*(.+?)\s*$/)
    if (li) {
      const path = stack.filter(s => s.indent < indent).map(s => s.key)
      if (path.length === 4 && path[0] === 'llm-pi-ai' && path[1] === 'providers' && path[3] === 'models') {
        if (!providers.has(path[2])) providers.set(path[2], new Set())
        providers.get(path[2]).add(unquote(li[1]))
      } else if (path.length === 2 && path[0] === 'llm-deepseek' && path[1] === 'models') {
        deepseek.add(unquote(li[1]))
      }
      continue
    }
    const kv = body.match(/^([^:]+):\s*(.*)$/)
    if (!kv) continue
    const key = unquote(kv[1].trim())
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key })
  }
  return { providers, deepseek }
}

// 0.1.5 内置 deepseek-official 模型 id(与 dsh-llm-deepseek 的 DEFAULT_MODELS 一致)
const OFFICIAL_MODELS = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'])

// 每个会话目录优先 V3 日志(0.1.5),否则旧日志
function sessionLogFile(dir) {
  const v3 = join(dir, 'session.v3.jsonl.zstd')
  if (existsSync(v3)) return v3
  const v2 = join(dir, 'session.jsonl.zstd')
  return existsSync(v2) ? v2 : null
}

// header(首行)表明这是子代理会话:origin/kind=subagent、delegationDepth>0、parentSession 存在
function isSubagentHeader(firstLine) {
  if (/"origin"\s*:\s*"subagent"/.test(firstLine)) return true
  if (/"kind"\s*:\s*"subagent"/.test(firstLine)) return true
  if (/"parentSession"\s*:/.test(firstLine)) return true
  const dm = firstLine.match(/"delegationDepth"\s*:\s*(\d+)/)
  return !!dm && Number(dm[1]) > 0
}

function collectTopLevelSessions() {
  const sessRoot = join(DSH_HOME, 'sessions')
  if (!existsSync(sessRoot)) return []
  const sessions = [] // {id, file, ref, provider, model, invalid}
  for (const ws of readdirSync(sessRoot)) {
    const wd = join(sessRoot, ws)
    let wst
    try { wst = statSync(wd) } catch { continue } // 悬空符号链接/权限异常不能让整次扫描崩溃
    if (!wst.isDirectory()) continue
    for (const sd of readdirSync(wd)) {
      const f = sessionLogFile(join(wd, sd))
      if (!f) continue
      const r = spawnSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 90_000 })
      if (r.status !== 0) continue
      const firstLine = r.stdout.split('\n', 1)[0] ?? ''
      if (isSubagentHeader(firstLine)) continue
      let sel = null, hdr = null
      for (const line of r.stdout.split('\n')) {
        // V3 与旧格式的 model/selection、request/header 结构相同,同一套提取逻辑
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
// 1) 已有 jar 先鉴权探测: 401 时立即 exit 2, 否则后续批量请求会"假成功"。
// 2) 自建 jar 放私有临时目录(0700)并 chmod 600; token 经 curl --config - 从 stdin 传入, 不进 argv/ps。
function probeAuth(jar) {
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-b', jar, BASE + '/'], { encoding: 'utf8', timeout: 15_000 })
  return r.status === 0 && r.stdout.trim() === '200'
}
function ensureCookie() {
  if (COOKIE_FILE && existsSync(COOKIE_FILE)) {
    if (probeAuth(COOKIE_FILE)) return COOKIE_FILE
    console.error('--token-file 指定的 cookie 无效或已过期(鉴权探测未获 200);请重新用登录 token 生成 cookie')
    process.exit(2)
  }
  const token = process.env.DSH_TOKEN
  if (!token) return null
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fix-model-'))
  chmodSync(dir, 0o700)
  const jar = COOKIE_FILE || join(dir, 'cookies.txt')
  const cfg = `url = "${BASE}/?token=${token}"\noutput = "/dev/null"\ncookie-jar = "${jar}"\n`
  const r = spawnSync('curl', ['-s', '--config', '-'], { encoding: 'utf8', input: cfg, timeout: 30_000 })
  if (r.status !== 0) return null
  try { chmodSync(jar, 0o600) } catch { /* 平台不支持时忽略 */ }
  if (!probeAuth(jar)) return null // token 无效/服务未启动: 不要带着空 jar 继续
  return jar
}

function selectModel(sid, provider, model, jar) {
  const body = JSON.stringify({
    type: 'client-request', rpcId: 'fix-' + Date.now() % 100000,
    method: 'session/selectModel',
    payload: { args: { request: { sessionId: sid, provider, model, reasoningEffort: EFFORT } } },
  })
  const args = ['-s', '-f', '-w', '\n%{http_code}', '-b', jar, '-X', 'POST', '-H', 'Content-Type: application/json',
    `${BASE}/api/session/selectModel`, '--data-binary', '@-']
  const r = spawnSync('curl', args, { encoding: 'utf8', input: body, timeout: 30_000 })
  const raw = (r.stdout || '').trim()
  const nl = raw.lastIndexOf('\n')
  const httpCode = nl >= 0 ? raw.slice(nl + 1).trim() : ''
  const payloadText = nl >= 0 ? raw.slice(0, nl) : raw
  let okFlag = false
  try { const j = JSON.parse(payloadText || '{}'); okFlag = !!(j && j.result && j.result.ok === true) } catch { okFlag = false }
  return { status: r.status, stdout: payloadText, stderr: r.stderr || '', httpCode, ok: okFlag }
}

// 0.1.5 行为变化:selectModel 成功后会把选择同时写入全局默认模型
function warnDefaultModelWrite() {
  console.log('\n⚠ 注意(dsh 0.1.5):session/selectModel 成功后会把本次选择同时写入全局默认模型')
  console.log('  (agentDefaultModel.saveSelection),批量修复会改变全局默认模型,而不只是目标会话。')
  console.log('  仅预览请加 --dry-run。')
}

// ---------- 主流程 ----------
const settingsFile = join(DSH_HOME, 'settings.yaml')
const settingsText = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : ''
const { providers, deepseek: deepseekModels } = parseSettingsModelCatalog(settingsText)
// deepseek-official 合法集 = 0.1.5 内置 id ∪ settings.yaml 顶层 llm-deepseek.models
const officialModels = new Set([...OFFICIAL_MODELS, ...deepseekModels])

const sessions = collectTopLevelSessions()
for (const s of sessions) {
  if (s.provider === 'deepseek-official') s.invalid = !officialModels.has(s.model)
  else s.invalid = !(providers.get(s.provider)?.has(s.model) ?? false)
}
const invalid = sessions.filter(s => s.invalid)
const validCount = sessions.length - invalid.length

console.log(`扫描: 顶层 ${sessions.length} 会话(优先 V3 日志,子代理已跳过), 引用有效 ${validCount}, 无效 ${invalid.length}`)
if (invalid.length) {
  for (const s of invalid) console.log(`  INVALID ${s.ref}  <- ${s.id}`)
} else {
  console.log('无失效模型引用,无需修复')
}

if (LIST || !PROVIDER || !MODEL) {
  if (invalid.length) console.log('\n修复: 见 SKILL.md 模型章节 / references/model-fix.md,或用:')
  if (invalid.length) console.log('  node fix-model-refs.mjs --provider deepseek-official --model deepseek-flash [--all] [--dry-run] [--token-file <cookie>]')
  process.exit(invalid.length ? 1 : 0)
}

// 目标模型合法性预检(deepseek-official 含内置集与 llm-deepseek.models 扩展)
const targetOk = PROVIDER === 'deepseek-official' ? officialModels.has(MODEL) : (providers.get(PROVIDER)?.has(MODEL) ?? false)
if (!targetOk) {
  console.error(`目标模型不在声明集: ${PROVIDER}/${MODEL}(settings.yaml/内置集无此 provider/model)`)
  process.exit(2)
}

const targets = ALL ? sessions : invalid
if (!targets.length) { console.log('没有需要切换的会话'); process.exit(0) }
console.log(`\n目标模型: ${PROVIDER}/${MODEL} (reasoningEffort=${EFFORT})${ALL ? ' [--all 强制全部]' : ''} ——共 ${targets.length} 会话`)

if (DRY) {
  for (const s of targets) console.log(`  WOULD  ${s.ref} -> ${PROVIDER}/${MODEL}  (${s.id})`)
  console.log('\n[dry-run] 未发送任何请求。真正执行时(dsh 0.1.5 起)selectModel 会同时写入全局默认模型(agentDefaultModel.saveSelection);')
  console.log('确认后去掉 --dry-run 再跑。')
  process.exit(0)
}

// 真正发请求前,醒目提示 0.1.5 的全局默认模型副作用
warnDefaultModelWrite()

const jar = ensureCookie()
if (!jar) {
  console.error('未取得登录 cookie:设置 DSH_TOKEN 环境变量,或用登录 token 生成 cookie 后 --token-file <file>(cookie 等同 API 凭据,注意 0600 与用后即删)')
  process.exit(2)
}

let ok = 0, fail = 0
for (const s of targets) {
  const r = selectModel(s.id, PROVIDER, MODEL, jar)
  if (r.status !== 0 || !r.ok) {
    fail++
    console.log(`  FAIL  ${s.ref} -> ${PROVIDER}/${MODEL}  (${s.id}): HTTP ${r.httpCode || '-'} ${(r.stdout || r.stderr || '').slice(0, 160)}`)
  } else {
    ok++
    console.log(`  OK    ${s.ref} -> ${PROVIDER}/${MODEL}  (${s.id})`)
  }
}
console.log(`\n完成: 成功 ${ok} / 失败 ${fail}${fail ? '(失败多为 token 过期或会话忙,可重跑,幂等)' : ''}`)
process.exit(fail ? 1 : 0)
