// 记忆注入：**没有检索词**那一轮（speak-up 主动开口 / 新会话第一轮）兜长期事实。
//
// 以前调用方写的是 `if (!query) return ''` —— 检索词空就一条都不注入，
// 而这一轮恰恰是上下文最空的一轮。现在改走 常驻兜底()：只拿稳定事实，不碰事件。
//
// 写法照 常驻层.test.mjs：**先设 DSH_HOME、再 import**，只用临时家目录。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'fish-fallback-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'sessions'), { recursive: true })
mkdirSync(join(home, 'fish-memory'), { recursive: true })

const { loadStore, render, __测试: api } = await import('../lib/index.js')
after(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })

const 库 = (sid) => join(home, 'fish-memory', sid + '.json')
const 天 = (d) => '2026-10-' + String(d).padStart(2, '0') + 'T10:00:00.000Z'
const 事件 = (id, text, d) => ({ id, text, at: 天(d), createdAt: 天(d), category: 'event', importance: 0.5 })
const 事实 = (id, text, d, 补 = {}) => ({
  id,
  text,
  at: 天(d),
  createdAt: 天(d),
  category: 'stable_profile',
  importance: 1,
  ...补,
})
const 现在 = Date.parse('2026-11-01T00:00:00Z')

function 建库(sid, memories) {
  writeFileSync(库(sid), JSON.stringify({ version: 2, memories, deleted: [], traces: [] }))
}

// ⭐ 只兜长期事实：事件一条都不进来（没那句话，就没理由挑事件）
test('没有检索词时只带稳定事实，事件不进来', () => {
  const sid = 's-fact'
  建库(sid, [
    事实('m1', 'ta 对芒果过敏', 1),
    事实('m2', 'ta 的名字是「小冰飞飞」', 2),
    事件('e1', '周五 ta 去面试，紧张', 3),
    事件('e2', '我们聊了练字', 4),
  ])
  const r = api.常驻兜底(loadStore(sid), 现在, sid)
  const ids = r.selected.map((x) => x.m.id)
  assert.deepEqual(ids.sort(), ['m1', 'm2'], '只该有两条稳定事实')
  assert.ok(!ids.includes('e1') && !ids.includes('e2'), '事件不该被硬塞进来')
})

// 「已被取代」和「精炼时跳过」的都不进来 —— 跟检索那套判据保持一致
test('已被取代 / 精炼跳过的稳定事实不进来', () => {
  const sid = 's-replaced'
  建库(sid, [
    事实('m1', 'ta 现在住杭州', 1),
    事实('m2', 'ta 以前住北京', 2, { 已被取代: true }),
    事实('m3', 'ta 爱喝美式', 3, { refinedSkip: true }),
  ])
  const r = api.常驻兜底(loadStore(sid), 现在, sid)
  assert.deepEqual(r.selected.map((x) => x.m.id), ['m1'])
})

// 排不下时别丢最新的那条：同重要度按时间倒序
test('重要度相同按时间新的在前', () => {
  const sid = 's-order'
  建库(sid, [事实('m1', '约定一', 1), 事实('m2', '约定二', 5), 事实('m3', '约定三', 9)])
  const r = api.常驻兜底(loadStore(sid), 现在, sid)
  assert.deepEqual(r.selected.map((x) => x.m.id), ['m3', 'm2', 'm1'])
})

// 重要度高的先排
test('重要度高的排前面', () => {
  const sid = 's-importance'
  建库(sid, [
    事实('m1', '一般喜好', 9, { importance: 0.5 }),
    事实('m2', '身体禁忌', 1, { importance: 1 }),
  ])
  const r = api.常驻兜底(loadStore(sid), 现在, sid)
  assert.deepEqual(r.selected.map((x) => x.m.id), ['m2', 'm1'])
})

// 最多 4 条：位置很少，不跟检索抢预算
test('最多只带 4 条', () => {
  const sid = 's-cap'
  const 一堆 = []
  for (let i = 1; i <= 7; i++) 一堆.push(事实('m' + i, '约定第 ' + i + ' 条', i, { importance: 1 }))
  建库(sid, 一堆)
  const r = api.常驻兜底(loadStore(sid), 现在, sid)
  assert.equal(r.selected.length, 4, '再多也只带 4 条')
  assert.deepEqual(r.selected.map((x) => x.m.id), ['m7', 'm6', 'm5', 'm4'], '带的是最新的四条')
})

// 名额跟着弹设置里的 maxItems 缩
test('maxItems 比 4 小时跟着缩', () => {
  const sid = 's-max-items'
  const 一堆 = []
  for (let i = 1; i <= 5; i++) 一堆.push(事实('m' + i, '约定第 ' + i + ' 条', i))
  建库(sid, 一堆)
  const data = loadStore(sid)
  data.policy = { ...(data.policy || {}), maxItems: 2 }
  const r = api.常驻兜底(data, 现在, sid)
  assert.equal(r.selected.length, 2)
})

// 字数预算照旧生效：超预算的进不来，但第一条总能在
test('字数预算超了就不带，但第一条总在', () => {
  const sid = 's-chars'
  建库(sid, [
    事实('m1', '第一条约定的正文写得比较长一些，用来占预算', 5),
    事实('m2', '第二条也写得挺长的，用来把它挤出预算之外', 4),
    事实('m3', '第三条同样很长，肯定进不来', 3),
  ])
  const data = loadStore(sid)
  data.policy = { ...(data.policy || {}), maxItems: 4, maxChars: 24 }
  const r = api.常驻兜底(data, 现在, sid)
  assert.ok(r.selected.length >= 1, '第一条总能进')
  assert.ok(r.selected.length < 3, '预算小的时候不该全塞进来')
  assert.equal(r.selected[0].m.id, 'm1', '第一条是排最前的')
})

// 返回形状：没有门、没有打分，标了兜底 —— 让调用方能跟着跳过「搜空扩词」
test('返回形状：gate 为 null、兜底为 true、不带打分', () => {
  const sid = 's-shape'
  建库(sid, [事实('m1', 'ta 对芒果过敏', 1)])
  const r = api.常驻兜底(loadStore(sid), 现在, sid)
  assert.equal(r.gate, null)
  assert.equal(r.兜底, true)
  assert.deepEqual(r.scored, [])
  assert.ok(r.selected.every((x) => x.常驻), '兜底行要标 常驻')
})

// 空库不炸
test('空库不炸，一个字都不注入', () => {
  const sid = 's-empty'
  建库(sid, [])
  const r = api.常驻兜底(loadStore(sid), 现在, sid)
  assert.deepEqual(r.selected, [])
  assert.equal(render(r.selected, 现在, '她'), '')
})

// 兜出来的那几条能正常渲染（相对时间写法跟检索路径一致）
test('兜底结果能正常渲染', () => {
  const sid = 's-render'
  建库(sid, [事实('m1', 'ta 对芒果过敏', 1)])
  const r = api.常驻兜底(loadStore(sid), 现在, sid)
  const 文 = render(r.selected, 现在, '她')
  assert.ok(文.includes('芒果'), '正文要在：' + 文)
})
