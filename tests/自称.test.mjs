// 「它自称什么」：提示词里那些「我」换成它的自称，「我们」不能动。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-zicheng-'))
process.env.DSH_HOME = home
const { __测试: api } = await import('../lib/index.js')

test('没设的时候，自称就是「我」，文本一个字不动', () => {
  assert.equal(api.自称(), '我')
  const 原文 = '用「我」指代自己，用「ta」指代用户'
  assert.equal(api.换自称成(原文, '我'), 原文)
  assert.equal(api.换自称成(原文, ''), 原文)
  assert.equal(api.换自称成(原文, '   '), 原文)
})

test('设成「本小姐」时，提示词里的「我」跟着换', () => {
  const 原文 = '用「我」指代自己，讲自己的事写「我.名字」。'
  assert.equal(api.换自称成(原文, '本小姐'), '用「本小姐」指代自己，讲自己的事写「本小姐.名字」。')
})

test('「我们」不许被拆坏', () => {
  const 原文 = '我们一起做的那些东西，我说过的话。'
  assert.equal(api.换自称成(原文, '在下'), '我们一起做的那些东西，在下说过的话。')
})

test('顺序替换不会套娃（本小姐里没有「我」）', () => {
  assert.equal(api.换自称成('我说的', '在下'), '在下说的')
  assert.equal(api.换自称成('我说的', '俺'), '俺说的')
})
