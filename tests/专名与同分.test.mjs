// 1.6.3 的回归：issue #40 补的那两层
//
//   ① 词表里没有的专有名词（「糯鲸」这种）要能当线索，不能因为切成单字就消失
//   ② 匹配分一样时，不能靠鲜活度瞎猜 —— 先比命中几个词、再比命中的词多长
//
// 跑法：node --test tests/专名与同分.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let 模块 = null
async function 载入() {
  if (模块) return 模块
  const 家 = fs.mkdtempSync(path.join(os.tmpdir(), 'fishmem-专名-'))
  process.env.DSH_HOME = 家
  模块 = await import('../lib/index.js')
  return 模块
}

test('同分时先看命中几个词，再看命中的词有多长', async () => {
  const { 比召回 } = await 载入()
  const 少 = { s: { C: 0.3132, hitN: 1, hitLen: 2, P: 0.9 } }
  const 多 = { s: { C: 0.3134, hitN: 3, hitLen: 7, P: 0.1 } }
  assert.ok(比召回(多, 少) < 0, '命中词多的该排前面（哪怕鲜活度低）')

  const 长 = { s: { C: 0.313, hitN: 1, hitLen: 6, P: 0.1 } }
  const 短 = { s: { C: 0.313, hitN: 1, hitLen: 2, P: 0.9 } }
  assert.ok(比召回(长, 短) < 0, '命中词数一样时，词更长的排前面')

  // C 差得看得见（三位小数不同）时，还是 C 说了算
  const 高 = { s: { C: 0.4, hitN: 1, hitLen: 2, P: 0.1 } }
  const 低 = { s: { C: 0.3, hitN: 9, hitLen: 40, P: 9 } }
  assert.ok(比召回(高, 低) < 0, 'C 明显更高就按 C 排，不许被二阶信号顶掉')

  // 全一样 → 回到 P
  const p高 = { s: { C: 0.5, hitN: 2, hitLen: 4, P: 0.8 } }
  const p低 = { s: { C: 0.5, hitN: 2, hitLen: 4, P: 0.2 } }
  assert.ok(比召回(p高, p低) < 0, '都比不出来才回到鲜活度那一套')

  assert.equal(比召回(null, undefined), 0, '缺字段也不炸')
})


test('召回：问「糯鲸是谁」，能想起那条讲糯鲸的记忆', async () => {
  const 家 = fs.mkdtempSync(path.join(os.tmpdir(), 'fishmem-召回-'))
  const 旧家 = process.env.DSH_HOME
  process.env.DSH_HOME = 家
  try {
    const sid = 'session-nuojing'
    const 库 = {
      version: 4,
      policy: { queryGate: 0, threshold: 0.2, maxItems: 6, maxChars: 4000 },
      memories: [
        {
          id: 'm-nuojing',
          text: '糯鲸是她给自己起的名字，别叫错',
          at: '2026-11-01T10:00:00.000Z',
          category: 'stable_profile',
          importance: 1,
        },
        {
          id: 'm-other',
          text: '备份要怎么做：改文件之前先备份一份',
          at: '2026-11-02T10:00:00.000Z',
          category: 'event',
          importance: 0.5,
        },
      ],
      traces: [],
      deleted: [],
    }
    fs.mkdirSync(path.join(家, 'fish-memory'), { recursive: true })
    fs.writeFileSync(path.join(家, 'fish-memory', sid + '.json'), JSON.stringify(库))
    fs.writeFileSync(path.join(家, 'fish-memory-config.json'), JSON.stringify({ switchMigrated: true, 全局开关: true, sessions: {} }))

    // 重新载入模块，让它读这个新家
    const 模 = await import('../lib/index.js?t=' + Date.now())
    const 结果 = 模.recall ? null : null
    // recall 不外露 —— 走注入那条路：装一次插件，拿 systemPrompt.context 的 text()
    let recallText = null
    const agent = {
      session: {
        id: sid,
        snapshotEvents: () => [{ type: 'user/message', data: { text: '糯鲸最近还好吗？' } }],
      },
      ctx: {
        on: () => () => {},
        tools: { register: () => () => {} },
        systemPrompt: { section: () => () => {}, context: ({ text }) => { recallText = text; return () => {} } },
      },
    }
    const ctx = {
      on: () => () => {},
      get: (名) => (名 === 'connection' ? { requestRejection: () => undefined } : null),
      webServer: { register: () => () => {} },
      interval: () => () => {},
      effect: (fn) => { try { fn() } catch (e) {} return () => {} },
      tools: { register: () => () => {} },
      systemPrompt: { section: () => () => {}, context: () => () => {} },
      agents: { list: () => [agent], get: () => agent },
      sessions: { list: () => [] },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }
    模.apply(ctx, {})
    assert.equal(typeof recallText, 'function', '按会话的注入钩子该挂上')
    const 注入 = recallText()
    assert.match(String(注入), /糯鲸/, '问「糯鲸最近还好吗」时，讲糯鲸那条该被想起来（名字被切成单字就丢了 → C=0）')
  } finally {
    if (旧家 === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = 旧家
    fs.rmSync(家, { recursive: true, force: true })
  }
})
