// 常驻层：问句门挡下短句时，长期事实照样带上；后台扩词按库排队
//
// 写法照 workspace-mode.test.mjs：**先设 DSH_HOME、再 import**，只用临时家目录。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'fish-resident-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'sessions'), { recursive: true })
mkdirSync(join(home, 'fish-memory'), { recursive: true })

const { recall, loadStore, 记一句话, __测试: api } = await import('../lib/index.js')
after(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })

const 库 = (sid) => join(home, 'fish-memory', sid + '.json')
const 天 = (d) => '2026-10-' + String(d).padStart(2, '0') + 'T10:00:00.000Z'
const 事件 = (id, text, d) => ({ id, text, at: 天(d), createdAt: 天(d), category: 'event', importance: 0.5 })
const 事实 = (id, text, d) => ({ id, text, at: 天(d), createdAt: 天(d), category: 'stable_profile', importance: 1 })
const 现在 = Date.parse('2026-11-01T00:00:00Z')

test('问句门挡下短句时，长期事实照样带上，普通事件不带', () => {
  const sid = 's-gate'
  // 说过 20 句以上门才开：喂一堆天天说的话
  for (let i = 0; i < 30; i++) 记一句话(sid, '嗯嗯 在吗 哈哈 好的 晚安 ' + i)
  writeFileSync(库(sid), JSON.stringify({
    version: 2,
    memories: [事实('m1', 'ta 对芒果过敏', 1), 事实('m2', '我们约好每周日一起看电影', 2), 事件('m3', '周五 ta 去面试', 3)],
    deleted: [],
    traces: [],
  }))
  const r = recall(loadStore(sid), '嗯嗯', 现在, sid)
  assert.ok(r.gate && r.gate.挡了, '这句应该被门挡下')
  assert.deepEqual(r.selected.map((x) => x.m.id).sort(), ['m1', 'm2'])
  assert.ok(r.selected.every((x) => x.常驻))
})

test('门放行时照旧：常驻层 + 召回的事件', () => {
  const sid = 's-open'
  writeFileSync(库(sid), JSON.stringify({
    version: 2,
    memories: [事实('m1', 'ta 对芒果过敏', 1), 事件('m2', '周五 ta 去面试，紧张', 3)],
    deleted: [],
    traces: [],
  }))
  const r = recall(loadStore(sid), '面试准备得怎么样了', 现在, sid)
  const ids = r.selected.map((x) => x.m.id)
  assert.ok(ids.includes('m1') && ids.includes('m2'))
  assert.ok(!(r.gate && r.gate.挡了))
})

test('后台排队：同一个库的活一个接一个跑', async () => {
  const 序 = []
  const 慢 = (名, ms) => () => new Promise((r) => setTimeout(() => { 序.push(名); r() }, ms))
  api.后台排队('q', 慢('先', 30))
  await api.后台排队('q', 慢('后', 1))
  assert.deepEqual(序, ['先', '后'])
})
