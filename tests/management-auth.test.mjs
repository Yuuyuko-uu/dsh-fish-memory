// 记忆管理路由只认 owner（DSH Connection admission）；全部是合成数据，不碰真实记忆。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = fs.mkdtempSync(join(tmpdir(), 'fish-auth-test-'))
process.env.DSH_HOME = home
process.env.DSH_HOST_MODULES = join(home, 'no-host-modules')
process.env.APPDATA = join(home, 'empty-appdata')
const { apply } = await import('../lib/index.js')

function routesWith(connection) {
  const routes = new Map()
  apply({
    connection, agents: { list: () => [], get: () => null }, sessions: { list: () => [] },
    get: () => null, on: () => () => {}, interval: () => () => {}, effect: fn => fn(),
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => {} } },
  })
  return routes
}
async function call(handler) {
  let status = 200, body = ''
  await handler({ url: '/', headers: {}, async *[Symbol.asyncIterator]() { yield '{}' } },
    { writeHead(code) { status = code }, setHeader() {}, end(text) { body = String(text ?? '') } })
  return { status, body }
}

test('没有登录、不是 owner、宿主没有 connection 服务时，每个管理路由都拒绝', async () => {
  for (const [connection, status] of [[undefined, 503], [{ admit: () => ({ rejection: 401 }) }, 401],
    [{ admit: () => ({ peer: { principal: { kind: 'guest' } } }) }, 403], [{ admit: () => { throw new Error('x') } }, 503]]) {
    const routes = routesWith(connection)
    assert.ok(routes.size > 3)
    for (const [path, handler] of routes) {
      const result = await call(handler)
      assert.equal(result.status, status, path)
      assert.match(result.body, /management_access_denied/)
    }
  }
})
