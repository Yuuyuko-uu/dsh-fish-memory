// issue #36：自查更新（检查更新 / 一键更新）必须走 ctx.inject(['webServer'])，不能递裸 ctx。
//
// 以前直接把 ctx 递给 selfupdate.register()，它内部直接用 ctx.webServer ——
// 没有 webServer 注入就抛「cannot get property "webServer" without inject」，两个路由都挂不上。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const 源 = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('自查更新走 ctx.inject([\'webServer\'])，不递裸 ctx', () => {
  assert.ok(
    源.includes("ctx.inject(['webServer'], (c) => 自查更新.register(c, '/dsh-fish-memory', 准入))"),
    '必须先用 ctx.inject([\'webServer\']) 声明依赖再注册',
  )
  // 反例：裸 ctx 直接递进去
  assert.ok(
    !/^\s{4}自查更新\.register\(ctx, '\/dsh-fish-memory', 准入\)\s*$/m.test(源),
    '不许再把裸 ctx 递给自查更新.register',
  )
})

test('没有 ctx.inject 的老宿主仍然能挂（退回裸 ctx）', () => {
  assert.ok(
    源.includes("自查更新.register(ctx, '/dsh-fish-memory', 准入)"),
    'else 分支要保留给没有 inject 的宿主',
  )
})
