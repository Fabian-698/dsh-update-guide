#!/usr/bin/env node
/**
 * sync-gates — 把 owner 技能里的规范闸门同步成本技能的内置副本（用于"只复制升级技能到另一台机器"）。
 *
 * 归属：verify-session.mjs / verify-patch.mjs / verify-patch-surface.mjs 的规范版本分别在
 * dsh-session-logs、dsh-config-assembly 技能里；scripts/verify-*.mjs 是解析薄壳。
 *
 * 用法：
 *   node scripts/sync-gates.mjs --list             列出每个闸门的解析结果与哈希
 *   node scripts/sync-gates.mjs --embed            从 owner 拷贝到 scripts/gates/（覆盖）
 *   node scripts/sync-gates.mjs --check            校验 scripts/gates/ 与 owner 是否一致（用于防漂移）
 *   --skills-root <dir>   技能根目录，默认按本技能兄弟目录解析(技能树上一级)，可用 DSH_SKILLS_ROOT 覆盖
 * 退出码：0 = 正常/一致；1 = --check 发现漂移或缺副本；2 = --embed 有 owner 缺失。
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const skillRoot = resolve(here, '..')
const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const has = name => argv.includes(name)
// 默认与 shim 的解析位置一致: shim 找的是本技能目录的兄弟 <owner>/scripts/...,
// 所以技能根默认是技能树的上一级, 而不是全局 ~/.dsh/skills(技能装在别处时会找错目录)。
const siblingRoot = resolve(here, '..', '..')
const defaultRoot = existsSync(join(siblingRoot, 'dsh-session-logs')) || existsSync(join(siblingRoot, 'dsh-config-assembly'))
  ? siblingRoot
  : join(homedir(), '.dsh', 'skills')
const skillsRoot = resolve(arg('--skills-root', process.env.DSH_SKILLS_ROOT || defaultRoot))
const MODE = has('--embed') ? 'embed' : has('--check') ? 'check' : 'list'
const GATES = [
  { name: 'verify-session.mjs', owner: 'dsh-session-logs' },
  { name: 'verify-patch.mjs', owner: 'dsh-config-assembly' },
  { name: 'verify-patch-surface.mjs', owner: 'dsh-config-assembly' },
]
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex')
const ownerPath = g => join(skillsRoot, g.owner, 'scripts', g.name)
const embeddedPath = g => join(here, 'gates', g.name)

let problems = 0
for (const g of GATES) {
  const owner = ownerPath(g)
  const embedded = embeddedPath(g)
  const hasOwner = existsSync(owner)
  const hasEmbedded = existsSync(embedded)
  if (MODE === 'embed') {
    if (!hasOwner) { console.error('[skip] ' + g.name + '：owner 不存在 ' + owner); problems++; continue }
    mkdirSync(join(here, 'gates'), { recursive: true })
    copyFileSync(owner, embedded)
    console.log('[embed] ' + g.name + ' <- ' + owner + '  sha256=' + sha(embedded).slice(0, 12))
    continue
  }
  if (MODE === 'check') {
    if (!hasEmbedded) { console.log('[miss]  ' + g.name + '：无内置副本（正常，本机走 owner 解析）'); continue }
    if (!hasOwner) { console.log('[stale] ' + g.name + '：有内置副本但 owner 技能缺失，无法校验（独立复制场景，忽略）'); continue }
    const same = sha(owner) === sha(embedded)
    console.log((same ? '[ok]    ' : '[DRIFT] ') + g.name + ' owner vs gates/')
    if (!same) problems++
    continue
  }
  const target = hasEmbedded ? embedded : hasOwner ? owner : null
  console.log((target ? '[ok] ' : '[miss] ') + g.name + (target ? ' -> ' + target : '（owner 与 gates/ 都不存在）'))
  if (!target) problems++
}
if (MODE === 'embed') console.log(problems ? '完成，但有 ' + problems + ' 个 owner 缺失' : '完成：内置闸门已生成')
process.exit(MODE === 'check' ? (problems ? 1 : 0) : MODE === 'embed' ? (problems ? 2 : 0) : 0)
