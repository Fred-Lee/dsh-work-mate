#!/usr/bin/env node
/**
 * Built-artifact tool gate: load dist/index.js the way the host does (no
 * bundler, real module evaluation) and assert the registered tool surface.
 * `pnpm verify:client` covers the client bundle; this covers the host bundle.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = process.cwd()
const moduleUrl = pathToFileURL(join(root, 'dist', 'index.js')).href
const mod = await import(moduleUrl)

const registered = []
const available = {}
const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  get: (key) => available[key],
  inject: (deps, callback) => {
    if (deps.every((dep) => available[dep] !== undefined)) {
      callback({ ...available, get: (key) => available[key] })
    }
    return {}
  },
  provide: () => {},
  effect: (fn) => fn(),
}

mod.apply(ctx)

const names = registered.map((definition) => definition.name)
const required = [
  'workmate_proposal_create',
  'workmate_proposal_status',
  'workmate_proposal_archive',
  'workmate_assess_risk',
  'workmate_metrics',
  'workmate_bands',
]
const missing = required.filter((name) => !names.includes(name))
// 团队执行器已移除（change `remove-team-executor`）：这 6 个工具必须消失，
// 否则说明构建产物里还留着一份已删源码的旧实现。
// swarm 已移除（change `remove-swarm-parallel`）：这两个工具同理。
const banned = [
  'workmate_team_prepare',
  'workmate_team_plan',
  'workmate_team_run',
  'workmate_team_status',
  'workmate_team_inbox',
  'workmate_team_answer',
  'workmate_swarm_plan',
  'workmate_swarm_task',
].filter((name) => names.includes(name))
if (banned.length > 0) {
  console.error(`[built-tools] FAILED — removed tools must be gone: ${banned.join(', ')}`)
  process.exit(1)
}
if (mod.name !== 'workmate') {
  console.error(`[built-tools] FAILED — unexpected export name ${String(mod.name)}`)
  process.exit(1)
}
if (missing.length > 0) {
  console.error(`[built-tools] FAILED — missing tools: ${missing.join(', ')}`)
  process.exit(1)
}
console.log(`[built-tools] ok — name=${mod.name}, tools=${registered.length}, no team/swarm tools`)
