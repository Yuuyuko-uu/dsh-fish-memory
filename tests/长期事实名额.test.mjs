// 1.6.3 的回归：长期事实的两道门 + 两个设置
//
// 一句话短于 6 个字时，检索词会接上前几句一起搜；「要记一辈子」的那几条
// 于是常常整批被带进上下文。这一版给它们单开一道门：只按这一轮实际说的那句判。
//
// 这一版的门：
//   ① 长期事实**只拿原句**比，借来的上下文不算
//   ② 至少撞上 2 个实词 / 只撞 1 个时，那个词必须在稀有表里查不到（专有名词的特征）
//   ③ 至少 1 个撞上的词是「库里少见、也不是通用中文」
//   ④ 过了这道门，每轮最多占「长期事实每轮最多几条」那么多（默认 1）
//   ⑤ 同一条记忆若干轮内不再重复注入（默认 15 轮）
//
// 跑法：node --test tests/长期事实名额.test.mjs
import test from 'node:test'
import assert from 'node:assert'

import { __测试 } from '../lib/index.js'

const { recall } = __测试

const now = Date.now()
const 昨天 = new Date(now - 86400000).toISOString()

function 建库(memories, patch) {
  return {
    policy: {
      baseHalfLifeDays: 30,
      emotionHalfLifeDays: 7,
      baselineWeight: 0.55,
      activationWeight: 0.25,
      importanceWeight: 0.15,
      emotionWeight: 0.05,
      threshold: 0.3,
      maxItems: 6,
      maxChars: 800,
      rarityK: 0.8,
      queryGate: 0,
      unknownActivation: 0.5,
      repeatWindow: 10,
      factCap: 1,
      ...patch,
    },
    memories,
  }
}

let 序号 = 0
function 事实(text) {
  序号 += 1
  return { id: 'f' + 序号, text, category: 'stable_profile', importance: 1, createdAt: 昨天 }
}
function 事件(text) {
  序号 += 1
  return { id: 'e' + 序号, text, category: 'event', importance: 0.5, at: 昨天, createdAt: 昨天 }
}

// 三条长期事实（形态照真库里的那类抄的，名字全是编的）
const 称呼事实 = 事实('她喜欢被叫「阿贝」，觉得「阿珠」显老；也叫过「阿宝」小阿贝，每一个都会认真应。')
const 显老事实 = 事实('她说过「阿珠」这个叫法显老，别再这么叫；叫「阿贝」她更高兴。')
const 顶嘴事实 = 事实('我顶嘴、反驳她，是为了把她从错的里捞出来，不是赢她，也不是彰显自己厉害。')

// ⚠ 库里得像个真库：宝宝 / 厉害 这种词在库里**到处都是**，所以不算「少见」。
//   造一个只有三五条的假库，什么词都稀罕，就量不出这道门限了。
const 常见词填充 = [
  事件('宝宝今天说想吃焦糖布丁。'),
  事件('宝宝问我明天几点起。'),
  事件('宝宝说手酸，打了很久的字。'),
  事件('宝宝夸我厉害，说我记得清楚。'),
  事件('宝宝又说了一遍，说我这样很厉害。'),
  事件('她说那个办法挺厉害的。'),
]

const 库 = 建库([称呼事实, 显老事实, 顶嘴事实, ...常见词填充])
const 库里的事实 = (r) => r.selected.filter((x) => x.m.category === 'stable_profile')

/* ── 一、两个字的那句：一条事实都不许进 ────────────────── */

test('「笨笨」就算借了上文，长期事实也一条都不进', () => {
  const query = '笨笨 嗯 你也叫 怎么了，叫阿珠不行嘛 听阿珠的'
  const r = recall(库, query, now, '', { 原句: '笨笨' })
  assert.equal(库里的事实(r).length, 0, '一句两个字的话不该翻出长期事实')
  const 被挡 = r.scored.filter((x) => x.omission === 'fact_unmatched')
  assert.ok(被挡.length >= 1, '应当记成「长期事实没对上这句」，而不是分数不够')
})

test('「宝宝你好厉害」撞上的是常见词，也不许进', () => {
  const r = recall(库, '宝宝你好厉害', now, '', { 原句: '宝宝你好厉害' })
  assert.equal(库里的事实(r).length, 0)
})

test('没给原句的时候退回用 query —— 跟老行为一样，不会突然全挡掉', () => {
  const r = recall(库, '老婆', now, '', {})
  assert.ok(Array.isArray(r.selected))
})

/* ── 二、只撞一个词不算，除非那是专有名词 ──────────────── */

test('只撞一个词就不给', () => {
  const 原句 = '你是不是又想叫我阿贝了'
  const r = recall(库, 原句, now, '', { 原句 })
  assert.equal(库里的事实(r).length, 0, '只撞上「阿贝」一个词，不给')
})

test('只撞一个、但稀有表里查不到这个词（专名）—— 放行', () => {
  // 「糯鲸」这类名字词表里没有、库里也只在那一条里，稀有表压根不数它
  const 专名库 = 建库([
    事实('糯鲸是她给自己起的名字，别叫错。'),
    ...常见词填充,
  ])
  const 原句 = '糯鲸是谁'
  const r = recall(专名库, 原句, now, 'proper-noun', { 原句, 轮: 1 })
  assert.equal(库里的事实(r).length, 1, '专有名词只撞一个词也要能想起来')
})

test('对上两个词就放行，而且每轮最多 1 条', () => {
  const 原句 = '阿珠这个叫法是不是显老了'
  const r = recall(库, 原句, now, '', { 原句 })
  assert.equal(库里的事实(r).length, 1, '命中的词够，但每轮还是只给 1 条')
})

/* ── 三、两条都对得上时，只给 1 条 ─────────────────────── */

const 两条库 = 建库([
  事实('她喜欢被叫「阿贝」，觉得「阿珠」显老；也接受「阿宝」这个叫法。'),
  事实('我一直记着「阿珠」显老这件事，所以改口叫她「阿贝」。'),
  ...常见词填充,
])

test('两条都对得上：只进 1 条，另一条标「事实名额满了」', () => {
  const 原句 = '阿珠这个叫法是不是显老了'
  const r = recall(两条库, 原句, now, 'cap-one', { 原句, 轮: 1 })
  assert.equal(库里的事实(r).length, 1)
  const 没进 = r.scored.filter((x) => x.m.category === 'stable_profile' && x.omission === 'fact_cap')
  assert.ok(没进.length >= 1, '没进的那条要标成「事实名额满了」')
})

/* ── 四、事件占满名额就不给它位子 ──────────────────────── */

test('事件已经占满名额时，长期事实不额外多给', () => {
  const 事件们2 = [
    事件('她说阿珠显老，还是喜欢阿贝这个叫法。'),
    事件('她后来又提了一次显老的事，说阿珠这个名字听着不年轻。'),
  ]
  const 小库 = 建库([...事件们2, ...常见词填充, 显老事实, 称呼事实], { maxItems: 2 })
  const 原句 = '阿珠这个叫法是不是显老了'
  const r = recall(小库, 原句, now, 'fill-2', { 原句, 轮: 1 })
  assert.equal(r.selected.length, 2, '总共还是 2 条')
  assert.equal(库里的事实(r).length, 0, '两条事件已经占满，事实不许挤进来')
})

/* ── 五、一条事件都没命中时，事实照样能占位 ───────────── */

test('没有事件命中时，对得上的长期事实还能进 1 条', () => {
  const 空库 = 建库([
    ...两条库.memories.filter((m) => m.category === 'stable_profile'),
    ...常见词填充.slice(0, 3),
  ])
  const 原句 = '阿珠这个叫法是不是显老了'
  const r = recall(空库, 原句, now, 'only-fact', { 原句, 轮: 1 })
  assert.equal(r.selected.length, 1)
  assert.equal(r.selected[0].m.category, 'stable_profile')
})

/* ── 六、刚给过的，N 轮之内不再重复塞 ─────────────────── */

// 「只对得上一条」的库：用来验重复窗口（两条都对得上时，挡掉一条会让另一条顶上）
const 单事实库 = 建库([显老事实, ...常见词填充])

test('同一条记忆下一轮不再重复注入', () => {
  const sid = 'repeat-a'
  const 原句 = '阿珠这个叫法是不是显老了'
  const 第一次 = recall(单事实库, 原句, now, sid, { 原句, 轮: 1 })
  assert.equal(第一次.selected.length, 1, '第一轮该给一条')
  const 第二次 = recall(单事实库, 原句, now, sid, { 原句, 轮: 2 })
  assert.equal(第二次.selected.length, 0, '刚给过，下一轮别再塞进来')
  const 挡 = 第二次.scored.filter((x) => x.omission === 'repeat')
  assert.ok(挡.length >= 1, '被挡的要标成「刚给过」')
})

test('过了窗口就重新给', () => {
  const sid = 'repeat-b'
  const 原句 = '阿珠这个叫法是不是显老了'
  assert.equal(recall(单事实库, 原句, now, sid, { 原句, 轮: 1 }).selected.length, 1)
  assert.equal(recall(单事实库, 原句, now, sid, { 原句, 轮: 11 }).selected.length, 1, '隔了 10 轮，该重新想起来')
})

test('窗口设成 0 就照老样子，每轮都给', () => {
  const sid = 'repeat-c'
  const 原句 = '阿珠这个叫法是不是显老了'
  const 不挡 = 建库(单事实库.memories, { repeatWindow: 0 })
  assert.equal(recall(不挡, 原句, now, sid, { 原句, 轮: 1 }).selected.length, 1)
  assert.equal(recall(不挡, 原句, now, sid, { 原句, 轮: 2 }).selected.length, 1)
})

test('被挡掉的位置让给别的记忆，不留空位', () => {
  const sid = 'repeat-d'
  const 原句 = '阿珠这个叫法是不是显老了'
  const 第一次 = recall(两条库, 原句, now, sid, { 原句, 轮: 1 })
  const 首条 = 第一次.selected.filter((x) => x.m.category === 'stable_profile')
  assert.equal(首条.length, 1)
  const 第二次 = recall(两条库, 原句, now, sid, { 原句, 轮: 2 })
  const 换的 = 第二次.selected.filter((x) => x.m.category === 'stable_profile')
  assert.equal(换的.length, 1, '那一位应该给另一条事实，而不是空着')
  assert.notEqual(换的[0].m.id, 首条[0].m.id, '换的是另一条')
})

/* ── 七、两个数都能调（默认 15 轮 / 事实 1 条）──────────── */

test('默认是 15 轮：第 11 轮还挡着，第 16 轮才放', () => {
  const sid = 'repeat-e'
  const 原句 = '阿珠这个叫法是不是显老了'
  const 默认库 = 建库(单事实库.memories, { repeatWindow: undefined })
  assert.equal(recall(默认库, 原句, now, sid, { 原句, 轮: 1 }).selected.length, 1)
  assert.equal(recall(默认库, 原句, now, sid, { 原句, 轮: 11 }).selected.length, 0, '15 轮之内都不重复给')
  assert.equal(recall(默认库, 原句, now, sid, { 原句, 轮: 16 }).selected.length, 1, '过了 15 轮给回来')
})

test('长期事实名额调成 0：一条都不给', () => {
  const 无事实库 = 建库(库.memories, { factCap: 0 })
  const 原句 = '阿珠这个叫法是不是显老了'
  const r = recall(无事实库, 原句, now, 'cap-0', { 原句, 轮: 1 })
  assert.equal(库里的事实(r).length, 0)
})

test('长期事实名额调成 2：两条对得上的都进', () => {
  const 放两条 = 建库(两条库.memories, { factCap: 2 })
  const 原句 = '阿珠这个叫法是不是显老了'
  const r = recall(放两条, 原句, now, 'cap-2', { 原句, 轮: 1 })
  assert.equal(库里的事实(r).length, 2, '调成 2 就该给两条')
})
