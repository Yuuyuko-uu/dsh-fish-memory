// ⭐ 1.5.6（issue #27）：有的机器上 ctx.agents.list() 一直是空的 ——
//   只靠 tick 轮询的话，记忆永远挂不上（diag 里只有「tick：agents=0」）。
//   现在多一条 agent/created 兜底：事件带着 agent 本体，不看那个列表。
//
// 这条测试盯的是**结构**：兜底还在、挂载入口还被两边共用。
// （真正挂载要完整的宿主 ctx，单测造不出来，所以这里锁结构。）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const 源 = readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib', 'index.js'), 'utf8')

test('agent/created 兜底还在', () => {
  assert.ok(源.includes("ctx.on('agent/created'"), 'agent/created 监听不见了 —— list() 为空时又没救了')
})

test('挂载逻辑抽成了一个函数，轮询和事件共用', () => {
  assert.ok(源.includes('function 挂一个(agent)'), '没有 挂一个() 这个入口')
  const tick段 = 源.slice(源.indexOf('function tick()'))
  assert.ok(tick段.includes('挂一个(agent)'), 'tick 里没有调用 挂一个(agent)')
})

test('agents=0 时会说清楚，而不是只写一个 0', () => {
  assert.ok(源.includes('一个 agent 都没拿到'), 'agents=0 时没有给人看的提示')
})

test('挂一个 里自己取归档名单（原来是 tick 的局部变量）', () => {
  const 起 = 源.indexOf('function 挂一个(agent)')
  const 段 = 源.slice(起, 起 + 600)
  assert.ok(段.includes('归档名单(ctx)'), '挂一个 里没取归档名单，会 ReferenceError')
})
