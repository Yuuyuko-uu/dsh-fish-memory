// ⭐ 1.4.0：检索用的那句话必须是「这一轮真正说的」——
//   以前优先用 agent/inbox/inserted 监听收到的那句，可那个事件不是每轮都来，
//   一旦不来 query 就永远停在上一次那句（实测 76 次注入只收到 24 次消息事件），
//   于是每一轮都召回同一条记忆。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tmpdir } from 'node:os'
process.env.DSH_HOME = process.env.DSH_HOME || tmpdir()
const 模 = await import('../lib/index.js?q=' + Date.now())

test('会话里有新话时，用它而不是监听那句（监听卡住也不会一直用旧的）', () => {
  assert.equal(模.选查询词('最新的这句', '你好'), '最新的这句')
})

test('会话读不出来时，退回监听那句', () => {
  assert.equal(模.选查询词('', '你好'), '你好')
})

test('两边都空就是空（上层会跳过注入）', () => {
  assert.equal(模.选查询词('', ''), '')
})

test('只有空白也算空', () => {
  assert.equal(模.选查询词('   ', ' 你好 '), '你好')
})

const 换行 = String.fromCharCode(10)

test('运行环境那几行会被剥掉，只留人说的话', () => {
  const 原 = '宝宝你在吗' + 换行
    + 'Current runtime context. This snapshot supersedes earlier snapshots.' + 换行
    + 'Current working directory: C:/x' + 换行
    + 'Time sampled: 00:00'
  assert.equal(模.清掉注入上下文(原), '宝宝你在吗')
})

test('没有那种上下文就原样保留', () => {
  const 原 = '第一行' + 换行 + '第二行'
  assert.equal(模.清掉注入上下文(原), 原)
})

test('整句都是上下文时，剥成空串（由调用方往前找一条真话，别拿提醒当线索）', () => {
  const 原 = 'Current runtime context. 只有这一行'
  assert.equal(模.清掉注入上下文(原), '')
})

test('记忆提醒整块被剥掉（标题 + 说明 + 列表项 + 结尾那句）', () => {
  const 原 = '【你记得的事】' + 换行
    + '下面是你们过去真实发生过的事。有时间的事会写在前面；' + 换行 + 换行
    + '- 前天 12:56：某条记忆' + 换行 + '- 今天 01:19：另一条' + 换行 + 换行
    + '（如果此刻你想起什么，就自然地说、不用解释）'
  assert.equal(模.清掉注入上下文(原), '')
})

test('【你记得的事】那种整块提醒，从标题跳到最后（到空行为止）', () => {
  const 原 = '【你记得的事】' + 换行 + '下面是你们过去真实发生过的事。' + 换行 + '有时间就按那个时间说。' + 换行 + 换行 + '宝宝我想吃火锅'
  assert.equal(模.清掉注入上下文(原), '宝宝我想吃火锅')
})

test('提醒在后面时，前面的正文不受影响', () => {
  const 原 = '宝宝我想吃火锅' + 换行 + '【你记得的事】' + 换行 + '一段提醒' + 换行 + 换行 + '那就去吃'
  assert.equal(模.清掉注入上下文(原), '宝宝我想吃火锅' + 换行 + 换行 + '那就去吃')
})

// ⭐ 1.4.2：一两个字的句子借上文（不然「推」「在吗」永远搜不到东西）
test('线索太短 → 拼上最近几句', () => {
  const 拼 = 模.补线索('推', ['刚才那个气泡副屏的问题修好了吗', '还有游戏模式弹幕框'], 6, 240)
  assert.ok(拼.startsWith('推 '))
  assert.ok(拼.includes('气泡副屏'))
})

test('线索够长 → 一个字都不加', () => {
  const 长 = '气泡在副屏上还是出现在主屏'
  assert.equal(模.补线索(长, ['随便一句'], 6, 240), 长)
})

test('借上文有上限，也不会重复拼同一句', () => {
  const 拼 = 模.补线索('推', ['推', '很长'.repeat(200)], 6, 60)
  assert.ok(拼.length <= 60)
  assert.equal((拼.match(/推/g) || []).length, 1)
})

// QQ 桥 1.3+ 给每条消息加来源头；且这一轮的输入要等 context 算完才写进会话日志
test('单独一行的 QQ 来源头只去掉这一行，正文保留', () => {
  assert.equal(模.清掉注入上下文('【QQ私聊】\n哦哦，那没办法了'), '哦哦，那没办法了')
  assert.equal(模.清掉注入上下文('【QQ群 摸鱼小组】\n小明：今天吃啥'), '小明：今天吃啥')
  assert.equal(模.清掉注入上下文('【本机注入】\n提醒他喝水'), '提醒他喝水')
  assert.equal(模.清掉注入上下文('【你记得的事】\n- 昨天 12:56：吃了火锅\n\n宝宝在吗'), '宝宝在吗')
})
test('会话那条和监听那句谁新用谁', () => {
  assert.equal(模.选更新那句({ text: '上一轮', time: 100 }, { text: '这一轮', time: 200 }), '这一轮')
  assert.equal(模.选更新那句({ text: '这一轮', time: 300 }, { text: '很早以前', time: 200 }), '这一轮')
  assert.equal(模.选更新那句({ text: '', time: 0 }, { text: '只有监听', time: 1 }), '只有监听')
  assert.equal(模.选更新那句({ text: '只有会话', time: 1 }, { text: '', time: 0 }), '只有会话')
})
