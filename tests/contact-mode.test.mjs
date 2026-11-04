// ⭐ 按联系人模式 —— 一个 IM 联系人（私聊对象 / 群）一份记忆，跨新会话保留，彼此不串
//
// 写法照工作区模式那份：**先设好临时家目录、再 import**，绝不碰真实的 ~/.dsh 和 ~/.dsh-qqbot。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'fish-ct-'))
process.env.HOME = home
process.env.USERPROFILE = home // Windows 上 os.homedir() 读这个
process.env.DSH_HOME = join(home, '.dsh')
mkdirSync(join(home, '.dsh', 'sessions'), { recursive: true })
mkdirSync(join(home, '.dsh-qqbot'), { recursive: true })

const { __测试: api } = await import('../lib/index.js')
after(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })

const 映射文件 = join(home, '.dsh-qqbot', 'model-prefs.json')
let 第几次 = 0
function 写映射(sessionIds) {
  writeFileSync(映射文件, JSON.stringify({ overrides: {}, sessionIds, presets: {} }))
  // 同一毫秒里连写两次 mtime 可能不变 —— 手动往后拨，保证读到的是新内容
  const t = new Date(Date.now() + ++第几次 * 1000)
  utimesSync(映射文件, t, t)
}
const 按联系人 = { 模式: 'contact' }

test('私聊按人、群按群，各是各的库', () => {
  写映射({
    'qqbot:1001:c2c:AAAA': 'session-a1',
    'qqbot:1001:c2c:BBBB': 'session-b1',
    'qqbot:1001:group:GGGG': 'session-g1',
  })
  const a = api.库名('session-a1', 按联系人)
  const b = api.库名('session-b1', 按联系人)
  const g = api.库名('session-g1', 按联系人)
  assert.equal(a, 'ct_qq-1001-c2c-AAAA')
  assert.equal(g, 'ct_qq-1001-group-GGGG')
  assert.notEqual(a, b)
  assert.notEqual(a, g)
})

test('在 QQ 里发 /new 换了新会话，还是同一个库；旧会话 id 也认得', () => {
  写映射({
    'qqbot:1001:c2c:AAAA': 'session-a2', // /new 之后
    'qqbot:1001:c2c:BBBB': 'session-b1',
    'qqbot:1001:group:GGGG': 'session-g1',
  })
  assert.equal(api.库名('session-a2', 按联系人), 'ct_qq-1001-c2c-AAAA')
  assert.equal(api.库名('session-a1', 按联系人), 'ct_qq-1001-c2c-AAAA')
})

test('认不出来的会话退回按会话，不猜', () => {
  assert.equal(api.库名('session-zzz', 按联系人), 'session-zzz')
  assert.equal(api.会话的联系人(''), '')
})

test('映射文件坏了不抛错，已认得的照旧', () => {
  writeFileSync(映射文件, '{坏')
  const t = new Date(Date.now() + ++第几次 * 1000)
  utimesSync(映射文件, t, t)
  assert.doesNotThrow(() => api.库名('session-a2', 按联系人))
  assert.equal(api.库名('session-a2', 按联系人), 'ct_qq-1001-c2c-AAAA')
  assert.equal(api.库名('session-new', 按联系人), 'session-new')
})

test('不是 qqbot 格式的键一律不认', () => {
  写映射({ 'other:1:c2c:X': 'session-x', 'qqbot:1001:c2c:../../etc': 'session-y' })
  assert.equal(api.库名('session-x', 按联系人), 'session-x')
  assert.equal(api.库名('session-y', 按联系人), 'session-y')
})

test('别的模式不受影响', () => {
  assert.equal(api.库名('session-b1', { 模式: 'session' }), 'session-b1')
  assert.equal(api.库名('session-b1', {}), 'session-b1')
  assert.equal(api.归一模式('contact'), 'contact')
  assert.equal(api.归一模式('workspace'), 'workspace')
  assert.equal(api.归一模式('乱填'), 'session')
  assert.equal(api.归一模式(undefined), 'session')
})
