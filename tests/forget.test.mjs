// ⭐ 在聊天里让它忘掉 / 说说记得什么（forget、list_memories 两个工具的核心）
//
// 写法照工作区模式那份：**先设 DSH_HOME、再 import**，测试只用这个临时家目录，绝不碰真实的 ~/.dsh。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'fish-forget-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'sessions'), { recursive: true })
mkdirSync(join(home, 'fish-memory'), { recursive: true })

const { __测试: api } = await import('../lib/index.js')
after(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })

const 库 = (sid) => join(home, 'fish-memory', sid + '.json')
function 造库(sid, texts, deleted = []) {
  const memories = texts.map((text, i) => ({ id: 'm' + (i + 1), text, createdAt: '2026-11-0' + (i + 1) + 'T10:00:00.000Z' }))
  writeFileSync(库(sid), JSON.stringify({ version: 2, memories, deleted, traces: [] }))
}
const 读库 = (sid) => JSON.parse(readFileSync(库(sid), 'utf8'))
// 这个库所有备份的全文（.bak + 每天一份）
function 备份们(sid) {
  const 份 = [库(sid) + '.bak']
  const B = join(home, 'fish-memory-backup')
  if (existsSync(B)) for (const d of readdirSync(B)) 份.push(join(B, d, sid + '.json'))
  return 份.filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8'))
}

test('像不像：相关的高、无关的 0', () => {
  assert.ok(api.像不像('我住在北京', 'ta 住在北京朝阳') > 0.5)
  assert.equal(api.像不像('喜欢猫', '明天要面试'), 0)
  assert.equal(api.像不像('', '任何'), 0)
})

test('第一步只找候选，不删', () => {
  造库('session-a', ['ta 住在北京朝阳', 'ta 喜欢吃草莓', '周五要面试'])
  const r = api.忘掉('session-a', { what: '我住哪' })
  assert.equal(r.ok, true)
  assert.match(r.message, /m1｜/)
  assert.doesNotMatch(r.message, /面试/)
  assert.equal(读库('session-a').memories.length, 3)
})

test('第二步按编号真删：不进「已删除」，别的不动', () => {
  const r = api.忘掉('session-a', { ids: ['m1'] })
  assert.equal(r.ok, true)
  const d = 读库('session-a')
  assert.deepEqual(d.memories.map((m) => m.id), ['m2', 'm3'])
  assert.ok(!(d.deleted || []).some((m) => m.id === 'm1'))
  // 写库前的那次备份不能还留着它
  const 备 = 备份们('session-a')
  assert.ok(备.length > 0)
  for (const t of 备) {
    assert.doesNotMatch(t, /北京朝阳/)
    assert.match(t, /草莓/) // 别的照留
  }
})

test('编号不对就不删', () => {
  const r = api.忘掉('session-a', { ids: ['不存在'] })
  assert.equal(r.ok, false)
  assert.equal(读库('session-a').memories.length, 2)
})

test('全部忘掉：连「已删除」里的也清掉', () => {
  造库('session-b', ['ta 叫小明', 'ta 怕黑'], [{ id: 'old', text: '以前删过的' }])
  const r = api.忘掉('session-b', { all: true })
  assert.equal(r.ok, true)
  const d = 读库('session-b')
  assert.equal(d.memories.length, 0)
  assert.equal((d.deleted || []).length, 0)
  assert.equal((d.traces || []).length, 0)
  assert.equal(备份们('session-b').length, 0)
})

test('只动当前这个库，别的会话不受影响', () => {
  造库('session-c', ['ta 住在上海'])
  造库('session-d', ['ta 住在上海'])
  api.忘掉('session-c', { all: true })
  assert.equal(读库('session-c').memories.length, 0)
  assert.equal(读库('session-d').memories.length, 1)
})

test('什么都没给就提示，不动库', () => {
  const r = api.忘掉('session-d', {})
  assert.equal(r.ok, false)
  assert.equal(读库('session-d').memories.length, 1)
})

test('没有相关的：说不用删', () => {
  const r = api.忘掉('session-d', { what: '我的猫叫什么' })
  assert.equal(r.ok, true)
  assert.match(r.message, /没有/)
})

test('列出记忆：新的在前，已被取代的不列', () => {
  writeFileSync(库('session-e'), JSON.stringify({ version: 2, traces: [], deleted: [], memories: [
    { id: 'a', text: '旧的身高 165', createdAt: '2026-10-01T00:00:00.000Z', supersededBy: 'b' },
    { id: 'b', text: '身高 170', createdAt: '2026-10-05T00:00:00.000Z' },
    { id: 'c', text: '喜欢下雨天', createdAt: '2026-11-01T00:00:00.000Z' },
  ] }))
  const r = api.列出记忆('session-e')
  assert.match(r.message, /共 2 条/)
  assert.ok(r.message.indexOf('喜欢下雨天') < r.message.indexOf('身高 170'))
  assert.doesNotMatch(r.message, /165/)
  assert.match(api.列出记忆('session-空').message, /还没记住/)
})
