import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

// Only synthetic stores and fake host/model services; never use the caller's DSH_HOME.
const home = mkdtempSync(join(tmpdir(), 'fish-purge-test-'))
process.env.DSH_HOME = home
process.env.DSH_HOST_MODULES = join(home, 'empty-host-modules')
process.env.APPDATA = join(home, 'empty-appdata')
const plugin = await import('../lib/index.js')
const dir = join(home, 'fish-memory')
mkdirSync(dir, { recursive: true })
const memory = (id) => ({ id, text: '合成记忆 ' + id, createdAt: '2026-10-01T00:00:00Z', related: [] })
const store = (sid, active = ['a', 'b'], deleted = []) => {
  writeFileSync(join(dir, sid + '.json'), JSON.stringify({ version: 2, policy: {},
    memories: active.map(memory), deleted: deleted.map(id => ({ ...memory(id), deletedAt: '2026-10-02T00:00:00Z' })), traces: [] }))
}
const disk = sid => JSON.parse(readFileSync(join(dir, sid + '.json'), 'utf8'))
const ids = entries => entries.map(m => m.id).sort()
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
function host(mod = plugin, liveAgents = []) {
  const routes = new Map()
  const calls = []
  const agent = { options: { provider: 'fixture', model: 'fixture' } }
  const ctx = {
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    agents: { list: () => liveAgents, get: () => agent }, sessions: { list: () => [] },
    get: () => null, on: () => () => {}, interval: () => () => {},
    effect: fn => fn(),
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => {} } },
    llm: { async *stream() {
      const call = calls.shift()
      assert.ok(call, 'all model calls must be explicitly stubbed')
      call.started.resolve()
      yield { type: 'text-delta', text: await call.reply.promise }
    } },
  }
  mod.apply(ctx)
  return {
    ctx,
    hold() { const call = { started: deferred(), reply: deferred() }; calls.push(call); return call },
    async post(path, body) {
      const handler = routes.get('/dsh-fish-memory' + path)
      assert.ok(handler, 'production route registered: ' + path)
      const req = { url: path, async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
      let output
      await handler(req, { writeHead() {}, end(value) { output = JSON.parse(value) } })
      return output
    },
  }
}
const h = host()

for (const action of ['purge', 'purgeall', 'purgebatch']) {
  test(action + ': a delayed expansion cannot restore permanently removed active records', async () => {
    const sid = 'active-' + action
    store(sid)
    const call = h.hold()
    const pending = h.post('/expand', { session: sid })
    await call.started.promise
    assert.equal((await h.post('/delete', { session: sid, id: 'a' })).ok, true)
    assert.equal((await h.post('/delete', { session: sid, action, id: 'a', ids: ['a'] })).ok, true)
    assert.deepEqual(ids(disk(sid).deleted), [], 'purge takes effect immediately')
    const added = await h.post('/add', { session: sid, text: '清理后新记忆' })
    call.reply.resolve('1|旧词 旧事\n2|另外 内容')
    const result = await pending
    assert.deepEqual(ids(disk(sid).memories), ['b', added.id].sort())
    assert.equal(result.ok, false, 'stale model work is reported, not acknowledged as saved')
    assert.match(result.message, /清理|清空/)
    assert.deepEqual(disk(sid).memories.find(m => m.id === 'b').related, [], 'retry the whole stale batch')
    assert.deepEqual(disk(sid).deleted, [])
  })
}

test('purging trash also prevents an old snapshot from restoring deleted payloads', async () => {
  const sid = 'trash-purge'
  store(sid, ['b'], ['trash'])
  const call = h.hold()
  const pending = h.post('/expand', { session: sid })
  await call.started.promise
  await h.post('/delete', { session: sid, action: 'purgeall' })
  call.reply.resolve('1|合成 词语')
  assert.equal((await pending).ok, false)
  assert.deepEqual(disk(sid).deleted, [])
})

test('purgebatch removes only selected trash, and a later explicit restore still works', async () => {
  const sid = 'selective-purge'
  store(sid, ['active'], ['gone', 'kept'])
  const result = await h.post('/delete', { session: sid, action: 'purgebatch', ids: ['gone'] })
  assert.equal(result.ok, true)
  assert.deepEqual(ids(disk(sid).deleted), ['kept'])
  assert.deepEqual(ids(disk(sid).memories), ['active'])
  assert.equal((await h.post('/delete', { session: sid, action: 'restore', id: 'kept' })).ok, true)
  assert.deepEqual(ids(disk(sid).memories), ['active', 'kept'])
  assert.deepEqual(disk(sid).deleted, [])
})

test('ordinary concurrent additions keep working on legacy stores with no epoch', async () => {
  const sid = 'legacy-merge'
  store(sid, ['a'])
  const call = h.hold()
  const pending = h.post('/expand', { session: sid })
  await call.started.promise
  const added = await h.post('/add', { session: sid, text: '并发新增' })
  call.reply.resolve('1|合成 词语')
  assert.equal((await pending).ok, true)
  assert.deepEqual(ids(disk(sid).memories), ['a', added.id].sort())
  assert.deepEqual(disk(sid).memories.find(m => m.id === 'a').related, ['合成', '词语'])
})

test('a fresh task can save after purge and ordinary saves preserve the epoch', async () => {
  const sid = 'fresh-after-purge'
  store(sid, ['a'], ['trash'])
  await h.post('/delete', { session: sid, action: 'purgeall' })
  const epoch = disk(sid).purgeEpoch
  assert.equal(typeof epoch, 'string')
  assert.ok(epoch.length > 0)
  const call = h.hold()
  const pending = h.post('/expand', { session: sid })
  await call.started.promise
  call.reply.resolve('1|新词 内容')
  assert.equal((await pending).ok, true)
  assert.equal(disk(sid).purgeEpoch, epoch)
})

test('another session purge does not invalidate this session', async () => {
  store('unrelated-a', ['a'])
  store('unrelated-b', [], ['trash'])
  const call = h.hold()
  const pending = h.post('/expand', { session: 'unrelated-a' })
  await call.started.promise
  await h.post('/delete', { session: 'unrelated-b', action: 'purgeall' })
  call.reply.resolve('1|合成 词语')
  assert.equal((await pending).ok, true)
})

test('epoch on disk rejects work retained by an older plugin instance', async () => {
  const sid = 'reload-purge'
  store(sid, ['a'])
  const call = h.hold()
  const pending = h.post('/expand', { session: sid })
  await call.started.promise
  const newer = host(await import('../lib/index.js?new-instance'))
  await newer.post('/delete', { session: sid, id: 'a' })
  await newer.post('/delete', { session: sid, action: 'purgeall' })
  call.reply.resolve('1|合成 词语')
  assert.equal((await pending).ok, false)
  assert.deepEqual(disk(sid).memories, [])
  assert.deepEqual(disk(sid).deleted, [])
})

test('explicit copy adopts the destination epoch and only adds what is missing', async () => {
  store('copy-from', ['a'], ['trash'])
  store('copy-to', ['b'], ['trash'])
  await h.post('/delete', { session: 'copy-from', action: 'purgeall' })
  await h.post('/delete', { session: 'copy-to', action: 'purgeall' })
  const epoch = disk('copy-to').purgeEpoch
  const result = await h.post('/copy-to', { session: 'copy-from', to: 'copy-to' })
  assert.equal(result.ok, true)
  const 到 = disk('copy-to')
  // ⭐ 1.3.7：复制是「并进去」——目标原来那条得留着
  assert.ok(到.memories.some(m => m.id === 'b'), '目标会话原有的记忆被覆盖了')
  // 来源那条按内容并进来（id 是新的，两边不会再撞）
  assert.ok(到.memories.some(m => m.text === memory('a').text), '来源那条没加进来')
  assert.ok(到.memories.some(m => m.id === 'a'), '来源那条该沿用原来的 id（那边没有同 id）')
  assert.equal(到.purgeEpoch, epoch)
})

test('a corrupt post-purge file fails closed instead of reviving a legacy snapshot', async () => {
  const sid = 'corrupt-after-purge'
  store(sid, ['a'])
  const call = h.hold()
  const pending = h.post('/expand', { session: sid })
  await call.started.promise
  await h.post('/delete', { session: sid, id: 'a' })
  await h.post('/delete', { session: sid, action: 'purgeall' })
  writeFileSync(join(dir, sid + '.json'), '{')
  call.reply.resolve('1|合成 词语')
  assert.equal((await pending).ok, false)
  assert.equal(readFileSync(join(dir, sid + '.json'), 'utf8'), '{', 'failure cannot overwrite the damaged evidence')
})

test('a failed purge write reports failure and leaves the prior store intact', async () => {
  const sid = 'purge-write-failure'
  store(sid, ['active'], ['trash'])
  const path = join(dir, sid + '.json')
  const before = readFileSync(path, 'utf8')
  const realRename = fs.renameSync
  let hits = 0
  try {
    fs.renameSync = (from, to) => {
      if (String(to) === path) {
        hits++
        throw Object.assign(new Error('synthetic write failure'), { code: 'EACCES' })
      }
      return realRename(from, to)
    }
    syncBuiltinESMExports()
    const result = await h.post('/delete', { session: sid, action: 'purgeall' })
    assert.equal(result.ok, false)
    assert.match(result.message, /synthetic write failure/)
    assert.equal(hits, 1, 'exercise the final atomic replacement')
    assert.equal(readFileSync(path, 'utf8'), before)
  } finally {
    fs.renameSync = realRename
    syncBuiltinESMExports()
  }
})

test('automatic expansion discards pre-purge work even after an explicit copy restores the same id', async () => {
  const sid = 'auto-purge'
  store(sid, ['a'])
  store('auto-copy-source', ['a'])
  const call = h.hold()
  const pending = plugin.自动扩词(h.ctx, sid)
  await call.started.promise
  await h.post('/delete', { session: sid, id: 'a' })
  await h.post('/delete', { session: sid, action: 'purgeall' })
  assert.equal((await h.post('/copy-to', { session: 'auto-copy-source', to: sid })).ok, true)
  call.reply.resolve('1|过期 结果')
  assert.equal(await pending, 0)
  assert.deepEqual(disk(sid).memories[0].related, [])
})

test('branch inheritance adopts the child epoch rather than its parent epoch', async () => {
  store('fork-source', ['parent'], ['trash'])
  await h.post('/delete', { session: 'fork-source', action: 'purgeall' })
  const child = { session: { id: 'fork-child', header: { id: 'fork-child', parentSession: 'fork-source' } } }
  host(plugin, [child])
  assert.deepEqual(ids(disk('fork-child').memories), ['parent'])
  assert.equal(disk('fork-child').purgeEpoch, '')
})

const file = sid => join(dir, sid + '.json')
const corruptBackups = sid => fs.readdirSync(dir).filter(name => name.startsWith(sid + '.json.corrupt-'))
const damagedBytes = Buffer.from([0x7b, 0x0d, 0x0a, 0x22, 0xff, 0x00])
function refinable(sid, deleted = []) {
  store(sid, ['a'], deleted)
  const data = disk(sid)
  data.memories[0].source = '档案导入'
  writeFileSync(file(sid), JSON.stringify(data))
}
const replyFor = route => route === '/refine' ? '1|合成提炼后的记忆|合成 词语' : '1|合成 词语'

test('nonempty purgeall rejects delayed refine before any subsequent write', async () => {
  const sid = 'purge-refine'
  refinable(sid)
  const call = h.hold()
  const pending = h.post('/refine', { session: sid })
  await call.started.promise
  assert.equal((await h.post('/delete', { session: sid, id: 'a' })).ok, true)
  const purged = await h.post('/delete', { session: sid, action: 'purgeall' })
  const afterPurge = readFileSync(file(sid))
  call.reply.resolve(replyFor('/refine'))
  const result = await pending
  assert.equal(purged.ok, true)
  assert.equal(result.ok, false)
  assert.deepEqual(readFileSync(file(sid)), afterPurge)
  assert.deepEqual(disk(sid).memories, [])
  assert.deepEqual(disk(sid).deleted, [])
})

test('a failed nonempty purge does not invalidate legitimate inflight expansion', async () => {
  const sid = 'failed-purge-inflight'
  store(sid, ['a'], ['trash'])
  const call = h.hold()
  const pending = h.post('/expand', { session: sid })
  await call.started.promise
  const realRename = fs.renameSync
  let purged, hits = 0
  fs.renameSync = (from, to) => {
    if (String(to) === file(sid)) {
      hits++
      throw Object.assign(new Error('synthetic purge failure'), { code: 'EACCES' })
    }
    return realRename(from, to)
  }
  syncBuiltinESMExports()
  try { purged = await h.post('/delete', { session: sid, action: 'purgeall' }) }
  finally { fs.renameSync = realRename; syncBuiltinESMExports() }
  call.reply.resolve(replyFor('/expand'))
  const result = await pending
  assert.equal(hits, 1)
  assert.equal(purged.ok, false)
  assert.equal(result.ok, true)
  assert.equal(disk(sid).purgeEpoch, '')
  assert.deepEqual(ids(disk(sid).deleted), ['trash'])
  assert.deepEqual(disk(sid).memories[0].related, ['合成', '词语'])
})

for (const route of ['/expand', '/refine']) {
  for (const hasEpoch of [false, true]) {
    test(`empty purgeall preserves ${hasEpoch ? 'current' : 'legacy'} epoch and delayed ${route}`, async () => {
      const sid = 'noop-' + route.slice(1) + '-' + hasEpoch
      refinable(sid, hasEpoch ? ['trash'] : [])
      if (hasEpoch) await h.post('/delete', { session: sid, action: 'purgeall' })
      const before = readFileSync(file(sid), 'utf8')
      const call = h.hold()
      const pending = h.post(route, { session: sid })
      await call.started.promise
      const purged = await h.post('/delete', { session: sid, action: 'purgeall' })
      const afterPurge = readFileSync(file(sid), 'utf8')
      call.reply.resolve(replyFor(route))
      const result = await pending
      assert.equal(purged.ok, true)
      assert.equal(afterPurge, before, 'zero removals must not write a new epoch')
      assert.equal(result.ok, true)
      assert.equal(disk(sid).purgeEpoch || '', JSON.parse(before).purgeEpoch || '')
      assert.deepEqual(disk(sid).memories[0].related, ['合成', '词语'])
    })
  }

  test(`nonempty purgeall rejects delayed ${route} even after corrupt-store recovery`, async () => {
    const sid = 'recover-stale-' + route.slice(1)
    refinable(sid)
    const call = h.hold()
    const pending = h.post(route, { session: sid })
    await call.started.promise
    assert.equal((await h.post('/delete', { session: sid, id: 'a' })).ok, true)
    assert.equal((await h.post('/delete', { session: sid, action: 'purgeall' })).ok, true)
    const purgedEpoch = disk(sid).purgeEpoch
    writeFileSync(file(sid), damagedBytes)
    const added = await h.post('/add', { session: sid, text: '损坏后新记忆' })
    assert.equal(added.ok, true)
    assert.notEqual(disk(sid).purgeEpoch, purgedEpoch)
    call.reply.resolve(replyFor(route))
    assert.equal((await pending).ok, false)
    assert.deepEqual(ids(disk(sid).memories), [added.id])
    assert.deepEqual(disk(sid).deleted, [])
    const backups = corruptBackups(sid)
    assert.equal(backups.length, 1)
    assert.deepEqual(readFileSync(join(dir, backups[0])), damagedBytes)
  })
}

test('empty purgeall does not create an absent store or rewrite a corrupt one', async () => {
  const sid = 'noop-absent'
  assert.equal((await h.post('/delete', { session: sid, action: 'purgeall' })).ok, true)
  assert.equal(fs.existsSync(file(sid)), false)
  writeFileSync(file(sid), damagedBytes)
  assert.equal((await h.post('/delete', { session: sid, action: 'purgeall' })).ok, true)
  assert.equal((await h.post('/delete', { session: sid, action: 'purge', id: 'a' })).ok, false)
  for (const route of ['/expand', '/refine']) {
    const result = await h.post(route, { session: sid })
    assert.equal(result.ok, true)
    assert.equal(result.done, true, 'a corrupt read has no records to submit to the model')
  }
  assert.deepEqual(readFileSync(file(sid)), damagedBytes)
  assert.deepEqual(corruptBackups(sid), [])
})

test('adding after corrupt JSON backs up exact bytes and creates a usable new epoch', async () => {
  const sid = 'corrupt-add'
  writeFileSync(file(sid), damagedBytes)
  const result = await h.post('/add', { session: sid, text: '恢复后的合成记忆' })
  assert.equal(result.ok, true)
  const backups = corruptBackups(sid)
  assert.equal(backups.length, 1)
  assert.deepEqual(readFileSync(join(dir, backups[0])), damagedBytes)
  assert.deepEqual(ids(disk(sid).memories), [result.id])
  const epoch = disk(sid).purgeEpoch
  assert.ok(epoch)
  assert.equal((await h.post('/add', { session: sid, text: '第二条合成记忆' })).ok, true)
  assert.equal(disk(sid).purgeEpoch, epoch)
  assert.deepEqual(corruptBackups(sid), backups)
})

test('a corrupt backup collision never overwrites the earlier backup', async () => {
  const sid = 'corrupt-collision'
  writeFileSync(file(sid), damagedBytes)
  const realCopy = fs.copyFileSync
  let collided, calls = 0
  fs.copyFileSync = (src, dst, flags) => {
    if (String(dst).startsWith(file(sid) + '.corrupt-')) {
      assert.equal(flags, fs.constants.COPYFILE_EXCL)
      if (++calls === 1) {
        collided = String(dst)
        writeFileSync(dst, 'earlier synthetic backup')
      }
    }
    return realCopy(src, dst, flags)
  }
  syncBuiltinESMExports()
  try {
    assert.equal((await h.post('/add', { session: sid, text: '新的合成记忆' })).ok, true)
    assert.equal(calls, 2)
    assert.equal(readFileSync(collided, 'utf8'), 'earlier synthetic backup')
    const latest = corruptBackups(sid).map(name => join(dir, name)).find(path => path !== collided)
    assert.deepEqual(readFileSync(latest), damagedBytes)
  } finally { fs.copyFileSync = realCopy; syncBuiltinESMExports() }
})

for (const code of ['EACCES', 'EIO', 'SYNTAX_FROM_READ']) {
  test(`read failure ${code} cannot be mistaken for recoverable JSON corruption`, async () => {
    const sid = 'read-failure-' + code
    writeFileSync(file(sid), damagedBytes)
    const realRead = fs.readFileSync
    let hits = 0
    fs.readFileSync = (path, ...args) => {
      if (String(path) === file(sid)) {
        hits++
        throw code === 'SYNTAX_FROM_READ' ? new SyntaxError('synthetic read error') : Object.assign(new Error('synthetic read failure'), { code })
      }
      return realRead(path, ...args)
    }
    syncBuiltinESMExports()
    try {
      assert.equal((await h.post('/add', { session: sid, text: '不能写入' })).ok, false)
      assert.ok(hits >= 2)
      assert.deepEqual(realRead(file(sid)), damagedBytes)
      assert.deepEqual(corruptBackups(sid), [])
    } finally { fs.readFileSync = realRead; syncBuiltinESMExports() }
  })
}

test('a failed corrupt backup preserves the original and refuses recovery', async () => {
  const sid = 'corrupt-backup-failure'
  writeFileSync(file(sid), damagedBytes)
  const realCopy = fs.copyFileSync
  let hits = 0
  fs.copyFileSync = (src, dst, ...args) => {
    if (String(dst).startsWith(file(sid) + '.corrupt-')) {
      hits++
      throw Object.assign(new Error('synthetic backup failure'), { code: 'EACCES' })
    }
    return realCopy(src, dst, ...args)
  }
  syncBuiltinESMExports()
  try {
    assert.equal((await h.post('/add', { session: sid, text: '不能写入' })).ok, false)
    assert.equal(hits, 1)
    assert.deepEqual(readFileSync(file(sid)), damagedBytes)
    assert.deepEqual(corruptBackups(sid), [])
  } finally { fs.copyFileSync = realCopy; syncBuiltinESMExports() }
})

test('a failed atomic recovery keeps both original bytes and the corrupt backup for a later retry', async () => {
  const sid = 'corrupt-atomic-failure'
  writeFileSync(file(sid), damagedBytes)
  const realRename = fs.renameSync
  let hits = 0
  fs.renameSync = (from, to) => {
    if (String(to) === file(sid)) {
      hits++
      throw Object.assign(new Error('synthetic replacement failure'), { code: 'EACCES' })
    }
    return realRename(from, to)
  }
  syncBuiltinESMExports()
  try {
    assert.equal((await h.post('/add', { session: sid, text: '尚未持久化' })).ok, false)
    assert.equal(hits, 1)
    assert.deepEqual(readFileSync(file(sid)), damagedBytes)
    const backups = corruptBackups(sid)
    assert.equal(backups.length, 1)
    assert.deepEqual(readFileSync(join(dir, backups[0])), damagedBytes)
    assert.equal(fs.readdirSync(dir).filter(name => name.startsWith(sid + '.json.') && name.endsWith('.tmp')).length, 0)
  } finally { fs.renameSync = realRename; syncBuiltinESMExports() }
  assert.equal((await h.post('/add', { session: sid, text: '重试后的合成记忆' })).ok, true)
  assert.equal(disk(sid).memories.length, 1)
  assert.ok(disk(sid).purgeEpoch)
})

// Direct calls exercise the same production persistence function for interleavings
// that the synchronous /add route cannot yield between its load and save.
test('only the first of two fresh recovery snapshots can commit', () => {
  const sid = 'recovery-contenders'
  writeFileSync(file(sid), damagedBytes)
  const first = plugin.loadStore(sid)
  const second = plugin.loadStore(sid)
  assert.notEqual(first.purgeEpoch, second.purgeEpoch)
  assert.deepEqual(readFileSync(file(sid)), damagedBytes, 'read candidates do not publish an epoch')
  first.memories.push(memory('first'))
  second.memories.push(memory('second'))
  plugin.saveStore(sid, first)
  const committed = readFileSync(file(sid))
  assert.throws(() => plugin.saveStore(sid, second), { code: 'MEMORY_PURGED' })
  assert.deepEqual(readFileSync(file(sid)), committed)
  assert.deepEqual(ids(disk(sid).memories), ['first'])
  assert.equal(corruptBackups(sid).length, 1)
})

for (const candidate of ['committed', 'uncommitted-sibling']) {
  test(`same-byte corruption after purge cannot reactivate a ${candidate} recovery snapshot`, () => {
    const sid = 'recovery-aba-' + candidate
    writeFileSync(file(sid), damagedBytes)
    const first = plugin.loadStore(sid)
    const sibling = plugin.loadStore(sid)
    first.memories.push(memory('synthetic-old'))
    sibling.memories.push(memory('synthetic-sibling'))
    plugin.saveStore(sid, first)
    const stale = candidate === 'committed' ? first : sibling
    const current = plugin.loadStore(sid)
    current.memories = []
    current.deleted = []
    plugin.saveStore(sid, current, { raw: true })
    assert.throws(() => plugin.saveStore(sid, stale), { code: 'MEMORY_PURGED' })
    writeFileSync(file(sid), damagedBytes)
    const backupCount = corruptBackups(sid).length
    assert.throws(() => plugin.saveStore(sid, stale), /旧任务未写入/)
    assert.deepEqual(readFileSync(file(sid)), damagedBytes)
    assert.equal(corruptBackups(sid).length, backupCount)
    const fresh = plugin.loadStore(sid)
    assert.notEqual(fresh.purgeEpoch, first.purgeEpoch)
    assert.notEqual(fresh.purgeEpoch, sibling.purgeEpoch)
    fresh.memories.push(memory('synthetic-new'))
    plugin.saveStore(sid, fresh)
    assert.deepEqual(ids(disk(sid).memories), ['synthetic-new'])
  })
}

test('successful recovery invalidates every candidate even without a subsequent valid read', () => {
  const sid = 'recovery-commit-incident'
  writeFileSync(file(sid), damagedBytes)
  const first = plugin.loadStore(sid), sibling = plugin.loadStore(sid)
  first.memories.push(memory('first'))
  sibling.memories.push(memory('sibling'))
  plugin.saveStore(sid, first)
  writeFileSync(file(sid), damagedBytes)
  for (const candidate of [first, sibling]) {
    assert.throws(() => plugin.saveStore(sid, candidate), /旧任务未写入/)
  }
  assert.deepEqual(readFileSync(file(sid)), damagedBytes)
  assert.equal(corruptBackups(sid).length, 1)
})

for (const observation of ['load-valid', 'save-valid', 'load-missing', 'save-missing', 'load-changed', 'save-changed']) {
  test(`observing ${observation} ends the old corruption incident even if its bytes return`, () => {
    const sid = 'recovery-observed-' + observation
    writeFileSync(file(sid), damagedBytes)
    const stale = plugin.loadStore(sid)
    stale.memories.push(memory('stale'))
    if (observation.endsWith('valid')) {
      writeFileSync(file(sid), JSON.stringify({ ...plugin.blank(), purgeEpoch: 'synthetic-external-epoch' }))
    } else if (observation.endsWith('missing')) {
      fs.rmSync(file(sid))
    } else {
      writeFileSync(file(sid), '{"changed":')
    }
    if (observation.startsWith('load')) plugin.loadStore(sid)
    else assert.throws(() => plugin.saveStore(sid, stale), /旧任务未写入/)
    writeFileSync(file(sid), damagedBytes)
    assert.throws(() => plugin.saveStore(sid, stale), /旧任务未写入/)
    assert.deepEqual(readFileSync(file(sid)), damagedBytes)
    assert.deepEqual(corruptBackups(sid), [])
    const fresh = plugin.loadStore(sid)
    assert.notEqual(fresh.purgeEpoch, stale.purgeEpoch)
    fresh.memories.push(memory('fresh'))
    plugin.saveStore(sid, fresh)
    assert.deepEqual(ids(disk(sid).memories), ['fresh'])
  })
}

for (const mode of ['backup', 'rename']) {
  for (const raw of [false, true]) {
    test(`repeated ${mode} failure preserves the same recovery candidate for raw=${raw} retry`, () => {
      const sid = 'recovery-retry-' + mode + '-' + raw
      writeFileSync(file(sid), damagedBytes)
      const candidate = plugin.loadStore(sid), sibling = plugin.loadStore(sid)
      candidate.memories.push(memory('retry'))
      sibling.memories.push(memory('stale-sibling'))
      const epoch = candidate.purgeEpoch
      const key = mode === 'backup' ? 'copyFileSync' : 'renameSync'
      const original = fs[key]
      let hits = 0
      fs[key] = (from, to, ...args) => {
        if (mode === 'backup' ? String(to).startsWith(file(sid) + '.corrupt-') : String(to) === file(sid)) {
          hits++
          throw Object.assign(new Error('synthetic recovery retry failure'), { code: 'EACCES' })
        }
        return original(from, to, ...args)
      }
      syncBuiltinESMExports()
      try {
        for (let i = 0; i < 2; i++) {
          assert.throws(() => plugin.saveStore(sid, candidate, { raw }), /synthetic recovery retry failure/)
          assert.deepEqual(readFileSync(file(sid)), damagedBytes)
          assert.equal(candidate.purgeEpoch, epoch, 'failed writes must not mutate the candidate epoch')
        }
        assert.equal(hits, 2)
      } finally { fs[key] = original; syncBuiltinESMExports() }
      plugin.saveStore(sid, candidate, { raw })
      assert.deepEqual(ids(disk(sid).memories), ['retry'])
      writeFileSync(file(sid), damagedBytes)
      assert.throws(() => plugin.saveStore(sid, sibling), /旧任务未写入/)
      assert.throws(() => plugin.saveStore(sid, candidate), /旧任务未写入/)
      assert.deepEqual(readFileSync(file(sid)), damagedBytes)
    })
  }
}

for (const action of ['copy', 'branch']) {
  test(`${action} recovery invalidates other candidates from the destination incident`, async () => {
    const source = 'incident-' + action + '-source', target = 'incident-' + action + '-target'
    store(source, ['source'])
    writeFileSync(file(target), damagedBytes)
    const stale = plugin.loadStore(target)
    stale.memories.push(memory('old-target'))
    if (action === 'copy') {
      assert.equal((await h.post('/copy-to', { session: source, to: target })).ok, true)
    } else {
      const child = { session: { id: target, header: { id: target, parentSession: source } } }
      host(plugin, [child])
    }
    assert.deepEqual(ids(disk(target).memories), ['source'])
    writeFileSync(file(target), damagedBytes)
    assert.throws(() => plugin.saveStore(target, stale), /旧任务未写入/)
    assert.deepEqual(readFileSync(file(target)), damagedBytes)
    assert.equal(corruptBackups(target).length, 1)
  })
}

test('empty purgeall does not invalidate a still-uncommitted recovery incident', async () => {
  const sid = 'incident-empty-purge'
  writeFileSync(file(sid), damagedBytes)
  const candidate = plugin.loadStore(sid)
  candidate.memories.push(memory('fresh'))
  assert.equal((await h.post('/delete', { session: sid, action: 'purgeall' })).ok, true)
  assert.deepEqual(readFileSync(file(sid)), damagedBytes)
  plugin.saveStore(sid, candidate)
  assert.deepEqual(ids(disk(sid).memories), ['fresh'])
})

test('a recovery snapshot is invalid when the damaged bytes have changed', async () => {
  const sid = 'recovery-bytes-change'
  writeFileSync(file(sid), damagedBytes)
  const stale = plugin.loadStore(sid)
  stale.memories.push(memory('stale'))
  const changed = Buffer.from('{"changed":')
  writeFileSync(file(sid), changed)
  assert.throws(() => plugin.saveStore(sid, stale), /内容已变化/)
  assert.deepEqual(readFileSync(file(sid)), changed)
  assert.deepEqual(corruptBackups(sid), [])
  const added = await h.post('/add', { session: sid, text: '重新读取后的记忆' })
  assert.equal(added.ok, true)
  assert.deepEqual(ids(disk(sid).memories), [added.id])
  assert.deepEqual(readFileSync(join(dir, corruptBackups(sid)[0])), changed)
})

test('clone, cross-session use, altered epoch, and an old snapshot cannot forge recovery authority', () => {
  const sid = 'recovery-scope', other = 'recovery-other'
  store(sid)
  const old = plugin.loadStore(sid)
  writeFileSync(file(sid), damagedBytes)
  writeFileSync(file(other), damagedBytes)
  const fresh = plugin.loadStore(sid)
  const clone = JSON.parse(JSON.stringify(fresh))
  const spread = { ...fresh }
  old.purgeEpoch = fresh.purgeEpoch
  for (const snapshot of [clone, spread, old]) {
    assert.throws(() => plugin.saveStore(sid, snapshot), /旧任务未写入/)
  }
  assert.throws(() => plugin.saveStore(other, fresh), /旧任务未写入/)
  fresh.purgeEpoch = ''
  assert.throws(() => plugin.saveStore(sid, fresh), /旧任务未写入/)
  for (const target of [sid, other]) {
    assert.deepEqual(readFileSync(file(target)), damagedBytes)
    assert.deepEqual(corruptBackups(target), [])
  }
})

test('explicit copy can recover only its freshly read corrupt destination', async () => {
  const source = 'recovery-copy-source', target = 'recovery-copy-target'
  store(source, ['source'], ['trash'])
  await h.post('/delete', { session: source, action: 'purgeall' })
  const sourceBytes = readFileSync(file(source))
  writeFileSync(file(target), damagedBytes)
  const result = await h.post('/copy-to', { session: source, to: target })
  assert.equal(result.ok, true)
  assert.deepEqual(ids(disk(target).memories), ['source'])
  assert.notEqual(disk(target).purgeEpoch, disk(source).purgeEpoch)
  assert.deepEqual(readFileSync(file(source)), sourceBytes)
  assert.deepEqual(readFileSync(join(dir, corruptBackups(target)[0])), damagedBytes)
  assert.deepEqual(corruptBackups(source), [])
  writeFileSync(file(source), damagedBytes)
  const targetBytes = readFileSync(file(target))
  assert.equal((await h.post('/copy-to', { session: source, to: target })).ok, false)
  assert.deepEqual(readFileSync(file(target)), targetBytes)
  assert.deepEqual(corruptBackups(source), [], 'an unreadable source is not a recovery instruction')
})

test('branch inheritance preserves corrupt child bytes before adopting parent memories', () => {
  const source = 'recovery-fork-parent', target = 'recovery-fork-child'
  store(source, ['parent'])
  writeFileSync(file(target), damagedBytes)
  const child = { session: { id: target, header: { id: target, parentSession: source } } }
  host(plugin, [child])
  assert.deepEqual(ids(disk(target).memories), ['parent'])
  assert.ok(disk(target).purgeEpoch)
  assert.deepEqual(readFileSync(join(dir, corruptBackups(target)[0])), damagedBytes)
})

test('soft deletion still wins over delayed refine and explicit batch restore passes its IDs', async () => {
  const sid = 'soft-delete-refine'
  refinable(sid)
  const call = h.hold()
  const pending = h.post('/refine', { session: sid })
  await call.started.promise
  assert.equal((await h.post('/delete', { session: sid, id: 'a' })).ok, true)
  call.reply.resolve(replyFor('/refine'))
  assert.equal((await pending).ok, true)
  assert.deepEqual(disk(sid).memories, [])
  assert.deepEqual(ids(disk(sid).deleted), ['a'])
  assert.equal((await h.post('/delete', { session: sid, action: 'restorebatch', ids: ['a'] })).ok, true)
  assert.deepEqual(ids(disk(sid).memories), ['a'])
  assert.deepEqual(disk(sid).deleted, [])
})

test('global parameters survive the merge for both new and recovered stores', async () => {
  const config = join(home, 'fish-memory-config.json')
  const before = fs.existsSync(config) ? readFileSync(config) : null
  writeFileSync(config, JSON.stringify({ policy: { baseHalfLifeDays: 45 } }))
  try {
    for (const corrupt of [false, true]) {
      const sid = 'global-policy-' + corrupt
      if (corrupt) writeFileSync(file(sid), damagedBytes)
      assert.equal(plugin.loadStore(sid).policy.baseHalfLifeDays, 45)
      assert.equal((await h.post('/add', { session: sid, text: '全局参数合成记忆' })).ok, true)
      assert.equal(disk(sid).policy.baseHalfLifeDays, 45)
    }
  } finally {
    if (before !== null) writeFileSync(config, before)
    else fs.rmSync(config)
  }
})
