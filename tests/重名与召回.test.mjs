// 1.6.2 的回归：issue #39（重名不再无限重试）和 issue #41（一条用户消息只检索一次）
//
// 跑法：node --test tests/重名与召回.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { 是重名错误 } from '../lib/index.js'

test('重名错误认得出（issue #39 里那条原文）', () => {
  const 原文 = 'tool "remember" is already registered (for a per-agent variant, register through that agent\'s `agent.ctx` instead)'
  assert.equal(是重名错误(原文), true)
  assert.equal(是重名错误('tool "remember" is already registered in this scope'), true)
  assert.equal(是重名错误('tool already exists'), true)
})

test('别的错不算重名 —— 那些还该重试', () => {
  assert.equal(是重名错误('cannot get property "tools" without inject'), false)
  assert.equal(是重名错误(''), false)
  assert.equal(是重名错误(undefined), false)
  assert.equal(是重名错误('ENOENT: no such file'), false)
})

/* ── 重名时只试一次，不每 0.5 秒刷 ─────────────────────── */

test('全局注册撞名之后不再重试（只注册一次）', async () => {
  const 家 = fs.mkdtempSync(path.join(os.tmpdir(), 'fishmem-重名-'))
  const 旧家 = process.env.DSH_HOME
  process.env.DSH_HOME = 家
  try {
    fs.writeFileSync(path.join(家, 'fish-memory-config.json'), JSON.stringify({ switchMigrated: true, 全局开关: true, sessions: {} }))

    let 注册次数 = 0
    let 心跳 = null
    const 记的 = []
    const ctx = {
      on: () => () => {},
      get: (名) => (名 === 'connection' ? { requestRejection: () => undefined } : null),
      webServer: { register: () => () => {} },
      interval: (fn) => { 心跳 = fn; return () => {} },
      effect: (fn) => { try { fn() } catch (e) {} return () => {} },
      tools: {
        register: () => {
          注册次数 += 1
          throw new Error('tool "remember" is already registered (for a per-agent variant, register through that agent\'s `agent.ctx` instead)')
        },
      },
      systemPrompt: { section: () => () => {}, context: () => () => {} },
      logger: { info: (s) => 记的.push(String(s)), warn: (s) => 记的.push(String(s)), error: (s) => 记的.push(String(s)) },
    }
    const agents = { list: () => [], get: () => null }
    const 插件 = await import('../lib/index.js')
    插件.apply(ctx, {})
    assert.equal(typeof 心跳, 'function', 'tick 应该被排上')

    // 模拟 17 分钟：每 0.5 秒一跳 = 2040 跳
    for (let i = 0; i < 2040; i++) 心跳()

    assert.equal(注册次数, 1, '重名之后不该再试第二次（以前会试 2040 次）')
  } finally {
    if (旧家 === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = 旧家
    fs.rmSync(家, { recursive: true, force: true })
  }
})
