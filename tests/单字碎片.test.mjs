// 单字碎片不当证据（1.5.9）
//
// 现象：「对的对的，我家小源还是我的宝」注入了两条讲「老猫」的记忆——
//   靠的是「源」（从「小源」「血源」切出来的碎片，df=1 → 稀有度 1.0）
//   和「对」（通用门已判死的常用词，被安全垫又放回来了）。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'fish-frag-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'sessions'), { recursive: true })
mkdirSync(join(home, 'fish-memory'), { recursive: true })

const { recall, loadStore, __测试: api } = await import('../lib/index.js')
after(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })

const 库 = (sid) => join(home, 'fish-memory', sid + '.json')
const 天 = '2026-10-20T10:00:00.000Z'
const 事件 = (id, text) => ({ id, text, at: 天, createdAt: 天, category: 'event', importance: 0.5 })
const 现在 = Date.parse('2026-11-01T00:00:00Z')

test('一句无关的话不会靠单字碎片注入别的记忆', () => {
  const sid = 's-frag'
  writeFileSync(库(sid), JSON.stringify({
    version: 2,
    policy: { threshold: 0.3, rarityK: 0.8, queryGate: 0.8 },
    memories: [
      事件('m1', '老猫是魂游老玩家，最喜欢对《影之刃零》的连招研究'),
      事件('m2', '老猫对历史感兴趣，尤其是三国那段'),
    ],
    deleted: [],
    traces: [],
  }))
  const r = recall(loadStore(sid), '对的对的，我家小源还是我的宝', 现在, sid)
  const ids = r.selected.map((x) => x.m.id)
  assert.deepEqual(ids, [], '这两条跟那句话没有实词关系，不该进来')
})

test('正经实词照样能命中（别把安全垫拆坏了）', () => {
  const sid = 's-real'
  writeFileSync(库(sid), JSON.stringify({
    version: 2,
    policy: { threshold: 0.3, rarityK: 0.8, queryGate: 0 },
    memories: [事件('m1', '老猫对历史感兴趣，尤其是三国那段')],
    deleted: [],
    traces: [],
  }))
  const r = recall(loadStore(sid), '三国那段历史你记得吗', 现在, sid)
  assert.ok(r.selected.some((x) => x.m.id === 'm1'), '真问到历史，这条要能想起来')
})

test('词表里的单字也不当证据（「源」在词典.txt 里有词条，但只是切分边界）', () => {
  const sid = 's-dict1'
  writeFileSync(库(sid), JSON.stringify({
    version: 2,
    policy: { threshold: 0.3, rarityK: 0.8, queryGate: 0 },
    memories: [事件('m1', '老猫是魂游老玩家，最喜欢对《影之刃零》的连招研究')],
    deleted: [],
    traces: [],
  }))
  const r = recall(loadStore(sid), '对的对的，我家小源还是我的宝', 现在, sid)
  assert.deepEqual(r.selected.map((x) => x.m.id), [], '单字「源」「对」都不该把它拽进来')
})

test('整句只剩单字时还留着（短句不能一条都想不起来）', () => {
  const sid = 's-short'
  writeFileSync(库(sid), JSON.stringify({
    version: 2,
    policy: { threshold: 0.1, rarityK: 0.8, queryGate: 0 },
    memories: [事件('m1', '猫今天又把杯子碰倒了')],
    deleted: [],
    traces: [],
  }))
  const r = recall(loadStore(sid), '猫', 现在, sid)
  assert.ok(r.selected.some((x) => x.m.id === 'm1'), '单字短句照样能想起来')
})
