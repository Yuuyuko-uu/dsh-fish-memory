// issue #42：一键更新读 `ctx.pluginManager` 会抛「without inject」
//
// Cordis 对**没进依赖名单**的服务不是返回 undefined，而是直接抛 ——
// 所以以前那句 `if (!pm)` 的兜底走不到，请求在它之前就炸了。
// 这里用一个「读 pluginManager 就抛」的假 ctx（和 Cordis 行为一样）钉住修复。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSelfUpdate } from '../lib/selfupdate.mjs'

// 造一个「像正常安装（在 node_modules 里）的包根」，不然会被当成 link: 的开发副本
function 造包根() {
  const 根 = mkdtempSync(join(tmpdir(), 'fishmem-42-'))
  const 包 = join(根, 'node_modules', 'dsh-fish-memory')
  mkdirSync(包, { recursive: true })
  writeFileSync(
    join(包, 'package.json'),
    JSON.stringify({
      name: 'dsh-fish-memory',
      version: '1.6.1',
      repository: { type: 'git', url: 'git+https://github.com/Yuuyuko-uu/dsh-fish-memory.git' },
    }),
  )
  // 空的 DSH_HOME + 一个把依赖写成 github: 的 profile：走「同源更新」那条路，结果确定
  const 家 = join(根, 'home')
  mkdirSync(join(家, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(
    join(家, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: { 'dsh-fish-memory': 'github:Yuuyuko-uu/dsh-fish-memory' } }),
  )
  return { 包根: 包, 家 }
}

// 跟 Cordis 一样：读没申明的服务就抛
function 造上下文(pm) {
  const 上下文 = {
    get pluginManager() {
      throw new Error('cannot get property "pluginManager" without inject')
    },
    reflect: { get: (名) => (名 === 'pluginManager' ? pm : undefined) },
  }
  return 上下文
}

test('读 pluginManager 会抛的 ctx，也照样能装（不抛，落到 installBundle）', async () => {
  const { 包根, 家 } = 造包根()
  const 旧 = process.env.DSH_HOME
  process.env.DSH_HOME = 家
  try {
    let 收到 = null
    const 自查更新 = createSelfUpdate({ packageRoot: 包根, diag: () => {} })
    const r = await 自查更新.install(
      造上下文({
        installBundle: async (spec) => {
          收到 = spec
          return { changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'install', target: spec }
        },
      }),
    )
    assert.equal(收到, 'github:Yuuyuko-uu/dsh-fish-memory', '要拿邮箱那个 spec 去装')
    assert.equal(r.ok, true)
    assert.match(r.say, /重启|生效/, '要把「要重启才生效」说出来')
  } finally {
    if (旧 === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = 旧
  }
})

test('宿主说 already-installed 时不能报「装好了」', async () => {
  const { 包根, 家 } = 造包根()
  const 旧 = process.env.DSH_HOME
  process.env.DSH_HOME = 家
  try {
    const 自查更新 = createSelfUpdate({ packageRoot: 包根, diag: () => {} })
    const r = await 自查更新.install(
      造上下文({
        installBundle: async () => ({
          changed: false,
          application: 'failed',
          stage: 'install',
          target: 'dsh-fish-memory',
          error: { code: 'already-installed' },
        }),
      }),
    )
    assert.equal(r.ok, false, '被宿主拒了就不能说成功')
    assert.match(r.error, /already-installed/)
    assert.match(r.error, /先卸再装/, '要告诉她怎么办')
  } finally {
    if (旧 === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = 旧
  }
})

test('连 reflect 都没有时，退回友好提示而不是抛', async () => {
  const { 包根 } = 造包根()
  const 自查更新 = createSelfUpdate({ packageRoot: 包根, diag: () => {} })
  const 上下文 = {
    get pluginManager() {
      throw new Error('cannot get property "pluginManager" without inject')
    },
  }
  const r = await 自查更新.install(上下文)
  assert.equal(r.ok, false)
  assert.match(r.error, /没有插件管理接口/)
})
