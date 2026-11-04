// 人称跟着会话走：没设过的会话落回全局默认，设过的各算各的。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-rencheng-'))
process.env.DSH_HOME = home
const { __测试: api } = await import('../lib/index.js')

test('没设过的时候：指对方是 ta，自称是「我」', () => {
  assert.equal(api.pronounOf('session-a'), 'ta')
  assert.equal(api.selfPronounOf('session-a'), '我')
})

test('空会话号不会炸，也回到默认', () => {
  assert.equal(api.pronounOf(''), 'ta')
  assert.equal(api.selfPronounOf(''), '我')
})

test('换称呼：设成「他」时提示词里的「她」跟着换，「她们」也一起换（都是对方）', () => {
  const 原文 = '以后她说什么话的时候应该想起这一条'
  assert.equal(api.换称呼(原文, '他'), '以后他说什么话的时候应该想起这一条')
  // 默认（ta / 她 / 没设）不动原文
  assert.equal(api.换称呼(原文, ''), 原文)
  assert.equal(api.换称呼(原文, '她'), 原文)
})
