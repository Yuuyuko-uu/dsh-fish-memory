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

// ⭐ 1.4.7：别的插件加的**来源头**（QQ 桥就是这种）—— 表头下面紧跟正文、中间没有空行。
//   以前这里无条件「跳到空行」，正文被一起跳掉 → 函数返回空串 →
//   那一轮 query 是空的 → 不召回、不写 trace、不打注入日志（整条消息一条记忆都召不到）。
test('来源头下面紧跟正文（中间没有空行）时，正文要留下', () => {
  for (const 头 of ['【QQ私聊】', '【QQ群 123456】', '【本机注入·不是QQ·不是主人】']) {
    assert.equal(模.清掉注入上下文(头 + 换行 + '你还记得吗'), '你还记得吗', 头)
  }
  // 本来就有空行的那种以前就是对的，别改坏
  assert.equal(模.清掉注入上下文('【QQ私聊】' + 换行 + 换行 + '你还记得吗'), '你还记得吗')
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

// ⭐ 1.4.4：线索不能是宿主/插件塞进来的东西 —— 以前靠文本白名单，
//   宿主换个措辞（`Approval prompts` → `Approval policy: ask`）就漏，
//   插件自己 render 的列表项（`- 3 天前（10-27）：…`）也漏，全被当成「她说的那句话」。
test('审批策略换成 ask 那句，也要剥干净', () => {
  const 原 = 'Current runtime context. 开头那句' + 换行 + 换行
    + 'Approval policy: ask. Operations that require approval may ask through the configured answerers.'
  assert.equal(模.清掉注入上下文(原), '')
})

test('「Elapsed since」那行也是运行环境，一起剥', () => {
  const 原 = 'Time sampled while preparing turn 1, step 1: 2026-10-30T19:00:00+08:00' + 换行
    + 'Browser time zone for this request: Asia/Shanghai.' + 换行
    + 'Elapsed since the preceding step message: 5m 39s.'
  assert.equal(模.清掉注入上下文(原), '')
})

test('记忆提醒后面那种「3 天前（10-27）：…」列表项，也要剥（以前只认昨天/前天/日期）', () => {
  const 原 = '【你记得的事】' + 换行 + '下面是你们过去真实发生过的事。' + 换行 + 换行
    + '- 昨天 16:10：某条' + 换行
    + '- 3 天前（10-27）：提交代码时不许手写作者身份' + 换行
    + '- 一直：她这一阵学会了做蛋炒饭'
  assert.equal(模.清掉注入上下文(原), '')
})

test('方块后面接着是真话时，真话要留下', () => {
  const 原 = '【你记得的事】' + 换行 + '下面是你们过去真实发生过的事。' + 换行 + 换行
    + '- 3 天前（10-27）：某条记忆' + 换行
    + '宝宝我想吃火锅'
  assert.equal(模.清掉注入上下文(原), '宝宝我想吃火锅')
})

// ⭐ 1.4.4：按 source.kind 认「谁在说话」，而不是猜文本
const 事件 = (类型, 来源, 文字, 时间) => ({
  type: 'user/message',
  time: 时间 || 0,
  data: { role: 'user', source: { kind: 来源 }, content: [{ type: 'text', text: 文字 }] },
})

test('运行环境那条整条跳过，取前面真说的那句', () => {
  const ev = [
    事件('user/message', 'user', '你在吗'),
    事件('user/message', 'runtime-context', 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.Approval policy: ask.'),
  ]
  assert.equal(模.挑这一轮的真话(ev), '你在吗')
})

test('插件替她开口的那种（speak-up / her-words）不算她说的', () => {
  const ev = [
    事件('user/message', 'speak-up', '该去找他聊天了。'),
    事件('user/message', 'user', '我回来了'),
    事件('user/message', 'speak-up', 'Lucky！骰子骰中了，可以去找他聊天了'),
  ]
  assert.equal(模.挑这一轮的真话(ev), '我回来了')
})

test('时间那条 / 技能目录那条也跳过', () => {
  const ev = [
    事件('user/message', 'user', '帮我看看这个 bug'),
    事件('user/message', 'time-context', 'Time sampled while preparing turn 1, step 1: …'),
    事件('user/message', 'skill-catalog', '<system-reminder> 技能目录变了'),
  ]
  assert.equal(模.挑这一轮的真话(ev), '帮我看看这个 bug')
})

test('没有 source 的老消息，认不出来就不拦', () => {
  const ev = [{ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '宝宝早' }] } }]
  assert.equal(模.挑这一轮的真话(ev), '宝宝早')
})

// ⚠ 黑名单而不是白名单：第三方 IM 桥用的 kind 我们不认识，
//   要是把它们当「不是人话」跳过，那些用户就永远检索不到记忆了。
test('不认识的来源当人话，不拦', () => {
  const ev = [事件('user/message', 'im-connect', '宝贝我到家了')]
  assert.equal(模.挑这一轮的真话(ev), '宝贝我到家了')
})

test('plugin: 开头那种是插件自己塞的，跳过', () => {
  const ev = [
    事件('user/message', 'user', '真实的一句'),
    事件('user/message', 'plugin:meow-memory', '[meow-memory-dream] 记忆整理任务'),
  ]
  assert.equal(模.挑这一轮的真话(ev), '真实的一句')
})

test('全是上下文、一句真话都没有 → 返回空（上层就不注入）', () => {
  const ev = [事件('user/message', 'runtime-context', 'Current runtime context. …')]
  assert.equal(模.挑这一轮的真话(ev), '')
})

test('夹在一条里的：真话 + 运行环境 → 取出来的是真话', () => {
  const ev = [
    事件('user/message', 'user', '宝宝我想吃火锅' + 换行 + 'Current runtime context. 后面这些是环境'),
  ]
  assert.equal(模.清掉注入上下文(模.挑这一轮的真话(ev)).trim(), '宝宝我想吃火锅')
})

// ⭐ 1.4.4：老召回记录里混着机器文本的那批 —— 加载时清掉，别白占 100 条上限
test('认得出老的记忆提醒残渣（`- 3 天前（10-27）：…`）', () => {
  assert.equal(模.明显是机器写的('- 3 天前（10-27）：提交代码时不许手写作者身份'), true)
  assert.equal(模.明显是机器写的('- 一直：她这一阵学会了做蛋炒饭'), true)
  assert.equal(模.明显是机器写的('- 9 天前（10-21）：她决定新书正文全部自己手打'), true)
})

test('认得出运行环境那几行', () => {
  assert.equal(模.明显是机器写的('Approval policy: ask. Operations that require approval'), true)
  assert.equal(模.明显是机器写的('Time sampled while preparing turn 1, step 1: …'), true)
  assert.equal(模.明显是机器写的('<system-reminder> A skill is …'), true)
  assert.equal(模.明显是机器写的('[model changed: assistant turns above this point'), true)
})

test('认得出别的插件塞的提示', () => {
  assert.equal(模.明显是机器写的('（上面这些是片子里的字幕。）'), true)
  assert.equal(模.明显是机器写的('（此刻你）心情开心。用这个心情定你这一轮的口气'), true)
  assert.equal(模.明显是机器写的('（到谷时啦，去 B 站刷一轮吧～'), true)
})

test('人真的说的话不能误判成机器文本', () => {
  const 真话 = [
    '那宝宝，你现在在说说话呢你随便像平时一样说话',
    '宝宝，你的颜表情呢？',
    '哎，反正就好烦啊。宝宝，你这次怎么就没怎么多说呢？',
    '我刚才说 - 那个气泡的问题你改好了没有',
  ]
  for (const s of 真话) assert.equal(模.明显是机器写的(s), false, s)
})
