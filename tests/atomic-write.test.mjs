import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Every file and host service is synthetic; no user home, model or network is used.
const home = fs.mkdtempSync(join(tmpdir(), 'fish-atomic-test-'))
process.env.DSH_HOME = home
process.env.DSH_HOST_MODULES = join(home, 'no-host-modules')
process.env.APPDATA = join(home, 'empty-appdata')
const { apply } = await import('../lib/index.js')
const directory = join(home, 'fish-memory')
fs.mkdirSync(directory, { recursive: true })
const routes = new Map()
apply({
  connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
  agents: { list: () => [], get: () => null }, sessions: { list: () => [] },
  get: () => null, on: () => () => {}, interval: () => () => {}, effect: fn => fn(),
  webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => {} } },
})
async function post(path, body) {
  let status, result
  await routes.get('/dsh-fish-memory' + path)(
    { url: path, async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } },
    { writeHead(code) { status = code }, end(text) { result = JSON.parse(text) } },
  )
  return { status, result }
}
const original = Object.fromEntries(['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'copyFileSync'].map(key => [key, fs[key]]))
const file = sid => join(directory, sid + '.json')
function seed(sid, deleted = false) {
  const entry = { id: 'old', text: 'Synthetic original memory', createdAt: '2026-10-01T00:00:00Z' }
  const data = { version: 2, policy: {}, memories: deleted ? [] : [entry], deleted: deleted ? [entry] : [], traces: [] }
  const text = JSON.stringify(data, null, 2)
  fs.writeFileSync(file(sid), text)
  return text
}
async function inject(sid, mode, action) {
  const handles = new Map()
  const target = file(sid)
  let hits = 0
  const isTarget = value => typeof value === 'number' ? handles.has(value) : String(value) === target || String(value).startsWith(target + '.') && String(value).endsWith('.tmp')
  fs.openSync = (...args) => { const fd = original.openSync(...args); if (isTarget(args[0])) handles.set(fd, args[0]); return fd }
  fs.writeFileSync = (...args) => {
    if (mode === 'write' && isTarget(args[0])) {
      hits++
      original.writeFileSync(args[0], '{"partial":', args[2])
      throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' })
    }
    return original.writeFileSync(...args)
  }
  fs.fsyncSync = fd => {
    if (mode === 'sync' && isTarget(fd)) { hits++; throw Object.assign(new Error('synthetic sync failure'), { code: 'EIO' }) }
    return original.fsyncSync(fd)
  }
  fs.renameSync = (...args) => {
    if (mode === 'rename' && String(args[1]) === target) { hits++; throw Object.assign(new Error('synthetic rename refusal'), { code: 'EACCES' }) }
    return original.renameSync(...args)
  }
  syncBuiltinESMExports()
  try { return { response: await action(), hits } }
  finally { Object.assign(fs, original); syncBuiltinESMExports() }
}

for (const mode of ['write', 'sync', 'rename']) {
  test(`${mode} failure preserves the previous store and rejects an add`, async () => {
    const sid = 'add-' + mode
    const before = seed(sid)
    const { response, hits } = await inject(sid, mode, () => post('/add', { session: sid, text: 'Synthetic new memory' }))
    assert.equal(response.result.ok, false, 'a failed persistence operation must not acknowledge success')
    assert.equal(hits, 1, 'fault must exercise the actual store write')
    assert.equal(fs.readFileSync(file(sid), 'utf8'), before)
    assert.equal(fs.readdirSync(directory).filter(name => name.startsWith(sid + '.json.') && name.endsWith('.tmp')).length, 0)
  })
}

test('a partial first write leaves no published JSON file', async () => {
  const sid = 'new-store'
  const { response, hits } = await inject(sid, 'write', () => post('/add', { session: sid, text: 'Synthetic first memory' }))
  assert.equal(response.result.ok, false)
  assert.equal(hits, 1)
  assert.equal(fs.existsSync(file(sid)), false)
})

test('a failed raw purge cannot be reported as completed or truncate trash', async () => {
  const sid = 'raw-purge'
  const before = seed(sid, true)
  const { response, hits } = await inject(sid, 'write', () => post('/delete', { session: sid, action: 'purgeall' }))
  assert.equal(response.result.ok, false)
  assert.equal(hits, 1)
  assert.equal(fs.readFileSync(file(sid), 'utf8'), before)
})

test('successful replacement preserves backups and round-trips Unicode', async () => {
  const sid = 'success'
  const before = seed(sid)
  const result = await post('/add', { session: sid, text: '合成偏好：蓝色，星图 🌌' })
  assert.equal(result.status, 200)
  assert.equal(result.result.ok, true)
  const saved = JSON.parse(fs.readFileSync(file(sid), 'utf8'))
  assert.equal(saved.memories.length, 2)
  assert.equal(saved.memories[1].text, '合成偏好：蓝色，星图 🌌')
  assert.equal(fs.readFileSync(file(sid) + '.bak', 'utf8'), before)
})

test('a failed write does not advance the last-backed-up fingerprint', async () => {
  const sid = 'retry-backup'
  const before = seed(sid)
  const request = () => post('/delete', { session: sid, id: 'old' })
  const failed = await inject(sid, 'write', request)
  assert.equal(failed.response.result.ok, false)
  assert.equal(fs.readFileSync(file(sid), 'utf8'), before)
  let backups = 0
  fs.copyFileSync = (...args) => {
    if (String(args[1]) === file(sid) + '.bak') backups++
    return original.copyFileSync(...args)
  }
  syncBuiltinESMExports()
  try {
    assert.equal((await request()).result.ok, true)
    assert.equal(backups, 1, 'retry must still protect the committed previous snapshot')
  } finally { Object.assign(fs, original); syncBuiltinESMExports() }
})

test('trace persistence failure does not discard a valid read-only recall', async () => {
  const sid = 'trace-only'
  seed(sid)
  const store = JSON.parse(fs.readFileSync(file(sid), 'utf8'))
  store.policy = { queryGate: 0, threshold: 0 }
  store.memories[0].category = 'stable_profile'
  store.memories[0].importance = 1
  fs.writeFileSync(file(sid), JSON.stringify(store))
  fs.writeFileSync(join(home, 'fish-memory-config.json'), JSON.stringify({ switchMigrated: true, sessions: { [sid]: true } }))
  let recallText
  const agent = {
    session: { id: sid, snapshotEvents: () => [{ type: 'user/message', data: { text: 'Synthetic original memory' } }] },
    ctx: { on: () => () => {}, tools: { register: () => () => {} }, systemPrompt: {
      section: () => () => {}, context: ({ text }) => { recallText = text; return () => {} },
    } },
  }
  apply({ agents: { list: () => [agent], get: () => agent }, sessions: { list: () => [] },
    get: () => null, on: () => () => {}, interval: () => () => {}, effect: fn => fn(),
    webServer: { register: () => () => {} } })
  assert.equal(typeof recallText, 'function', 'actual per-agent prompt hook must mount')
  const expected = recallText()
  assert.match(expected, /Synthetic original memory/)
  const before = fs.readFileSync(file(sid), 'utf8')
  const { response, hits } = await inject(sid, 'write', async () => ({ result: { text: recallText() } }))
  assert.equal(hits, 1)
  assert.equal(response.result.text, expected, 'optional trace writes must not suppress valid memory')
  assert.equal(fs.readFileSync(file(sid), 'utf8'), before)
})

test('policy writes report partial failure rather than a successful unsaved policy', async () => {
  const sid = 'policy-failure'
  const before = seed(sid)
  const { response, hits } = await inject(sid, 'write', () => post('/policy', { baseHalfLifeDays: 90 }))
  assert.equal(hits, 1)
  assert.equal(response.result.ok, false)
  assert.equal(response.status, 500)
  assert.equal(typeof response.result.changed, 'number')
  assert.equal(fs.readFileSync(file(sid), 'utf8'), before)
})
