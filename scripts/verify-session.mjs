#!/usr/bin/env node
/**
 * 薄壳闸门：verify-session.mjs
 *
 * 规范实现(owner)：dsh-session-logs/scripts/verify-session.mjs
 * 本技能不再保存副本，解析顺序：
 *   1. scripts/gates/verify-session.mjs          —— 独立复制到别的机器时由 sync-gates.mjs --embed 生成
 *   2. ../dsh-session-logs/scripts/verify-session.mjs —— 本机技能族存在时的规范版本
 * 两个来源都缺失时给出修复指引并 exit 2。
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const skillRoot = resolve(here, '..')
const candidates = [
  join(here, 'gates', 'verify-session.mjs'),
  join(skillRoot, '..', 'dsh-session-logs', 'scripts', 'verify-session.mjs'),
]
const target = candidates.find(p => existsSync(p))
if (!target) {
  console.error(
    'verify-session.mjs: 找不到闸门实现（scripts/gates/ 与 ../dsh-session-logs/scripts/ 都不存在）。\n' +
      '  修复一：把 owner 技能 dsh-session-logs 一并安装到 ' + resolve(skillRoot, '..') + '\n' +
      '  修复二：在拥有该技能的机器上执行 node scripts/sync-gates.mjs --embed 后重新复制本技能目录',
  )
  process.exit(2)
}
if (process.env.DSH_GATE_VERBOSE) console.error('[gate] verify-session.mjs -> ' + target)
const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(r.status ?? 1)
