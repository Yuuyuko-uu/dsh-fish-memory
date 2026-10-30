import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The published DSH 0.2.1-rc.3 approval context, joined with blank lines by
// @deepseek-ai/dsh-system-prompt's joinContextSections(). See also:
// https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/snapshots/sdk/serial-created/session.jsonl
const approval = 'Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.'
const snapshot = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: workspace-write.\n\n' + approval
const home = mkdtempSync(join(tmpdir(), 'fish-runtime-query-'))
process.env.DSH_HOME = home
process.env.DSH_HOST_MODULES = join(home, 'empty-host-modules')
process.env.APPDATA = join(home, 'empty-appdata')
const plugin = await import('../lib/index.js')
const dir = join(home, 'fish-memory')
mkdirSync(dir, { recursive: true })

test.after(() => rmSync(home, { recursive: true, force: true }))

test('ask policy in a separate runtime-context paragraph is not a query', () => {
  assert.equal(plugin.清掉注入上下文(snapshot), '')
})
test('a policy paragraph does not swallow user text after its blank-line boundary', () => {
  assert.equal(plugin.清掉注入上下文(snapshot + '\n\n请记住我喜欢喝茉莉花茶'), '请记住我喜欢喝茉莉花茶')
})
test('ordinary prose about approval policies is preserved', () => {
  assert.equal(plugin.清掉注入上下文('Approval policy design needs discussion'), 'Approval policy design needs discussion')
})
test('existing never-policy filtering is preserved', () => {
  assert.equal(plugin.清掉注入上下文('Approval prompts are disabled in this session: actions that require approval are rejected automatically.'), '')
})

function queryFor(sid, events, inbox) {
  writeFileSync(join(dir, sid + '.json'), JSON.stringify({ version: 2, policy: {}, memories: [
    { id: 'tea', text: '我喜欢喝茉莉花茶', createdAt: new Date().toISOString(), related: ['茉莉花茶'] },
  ], deleted: [], traces: [] }))
  const listeners = new Map()
  let context
  const agent = { session: { id: sid, header: {}, snapshotEvents: () => events }, ctx: {
    on(name, fn) { listeners.set(name, fn); return () => {} },
    systemPrompt: { section: () => () => {}, context(spec) { context = spec; return () => {} } },
  } }
  const ctx = {
    agents: { list: () => [agent] }, sessions: { list: () => [] },
    get: () => ({ archivedSessionIds: [] }), on: () => () => {}, interval: () => () => {},
    effect: fn => fn(), webServer: { register: () => () => {} },
    llm: { async *stream() { throw new Error('test must not call a model') } },
  }
  plugin.apply(ctx)
  assert.ok(context, 'production memory context must be registered')
  if (inbox) listeners.get('agent/inbox/inserted')({ message: { content: [{ type: 'text', text: inbox }] } })
  const rendered = context.text()
  const stored = JSON.parse(readFileSync(join(dir, sid + '.json'), 'utf8'))
  return { rendered, trace: stored.traces.at(-1) }
}
const message = text => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } })

test('production injection searches the user message before the host snapshot', () => {
  const result = queryFor('user-before-snapshot', [message('我喜欢喝茉莉花茶'), message(snapshot)])
  assert.equal(result.trace.query, '我喜欢喝茉莉花茶')
  assert.deepEqual(result.trace.picked, ['tea'])
  assert.match(result.rendered, /茉莉花茶/)
})
test('production injection falls back to the inbox when history is only host context', () => {
  const result = queryFor('inbox-fallback', [message(snapshot)], '我喜欢喝茉莉花茶')
  assert.equal(result.trace.query, '我喜欢喝茉莉花茶')
  assert.deepEqual(result.trace.picked, ['tea'])
})
test('production injection skips a host-only turn instead of recording an approval query', () => {
  const result = queryFor('host-only', [message(snapshot)])
  assert.equal(result.trace, undefined)
  assert.equal(result.rendered, '')
})
