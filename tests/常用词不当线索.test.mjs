// ⭐ 1.6.6：常用词不该当线索。
//
// 漏洞：`没`(词频 27) 和 `去`(21) 分开看都很常用、本来都被挡掉了；
// 可它们拼成「没去」，词频表里没有这个词，而老写法把「不在表里」一律当最稀有（1.0）算 →
// 这个虚词组合反而成了最硬的一条证据，能把毫不相干的旧记忆拉出来。
//
// 改法（不是手写黑名单，是通用规则）：
//   **一个词不会比它里面最具体的那个字更具体。**
//   不在词表里的词，稀有度取它所有单字里最高的那一个。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'

process.env.DSH_HOME = process.env.DSH_HOME || tmpdir()
const 模 = await import('../lib/index.js?q=' + Date.now())

test('全是常用字拼出来的词，不算线索', () => {
  for (const w of ['没去', '还没', '就是', '这个']) {
    assert.equal(模.算线索(w), false, w + ' 不该算线索')
  }
})

test('本来就太常用的词，照旧不算线索', () => {
  for (const w of ['没有', '可以', '一直', '今天']) {
    assert.equal(模.算线索(w), false, w + ' 不该算线索')
  }
})

test('带一个不常用的字，就照样算线索', () => {
  for (const w of ['钥匙', '拖鞋', '咳嗽', '枕头', '雨伞']) {
    assert.equal(模.算线索(w), true, w + ' 应该算线索')
  }
})

test('最常用的单字自己不算线索', () => {
  for (const w of ['去', '来', '做', '说', '想', '要', '有', '在', '就', '都', '也']) {
    assert.equal(模.算线索(w), false, w + ' 不该算线索')
  }
})

test('不在词表里的词，稀有度不会高过它最具体的那个字', () => {
  const 没 = 模.通用稀有('没')
  const 去 = 模.通用稀有('去')
  assert.equal(模.通用稀有('没去'), Math.max(没, 去))
  assert.ok(模.通用稀有('没去') < 0.4, '「没去」应该落在线下')
})
