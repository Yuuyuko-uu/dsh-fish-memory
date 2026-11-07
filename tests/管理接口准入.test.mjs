// ⭐ 1.5.7（issue #35）：管理接口的准入 —— 失败即拒绝。
//
// 以前的写法在「拿不到 connection 服务」或者「requestRejection 自己抛错」时**放行**，
// 于是本机任意网页都能打到管理接口（含一键安装）。
// 现在反过来：判不了就拒。
import test from 'node:test'
import assert from 'node:assert/strict'
import { 建准入, 包准入 } from '../lib/准入.mjs'

function 造ctx(连接) {
  return { get: (名) => (名 === 'connection' ? 连接 : undefined) }
}

test('宿主明确拒绝（401/403）→ 拒', () => {
  const 准入 = 建准入(造ctx({ requestRejection: () => 403 }))
  assert.equal(准入({ headers: {} }).码, 403)
})

test('拿不到 connection 服务 → 拒（失败即拒绝）', () => {
  const 准入 = 建准入(造ctx(undefined))
  const 结果 = 准入({ headers: {} })
  assert.ok(结果, '以前这里会放行')
  assert.equal(结果.码, 503)
})

test('准入服务自己抛错 → 拒', () => {
  const 准入 = 建准入(造ctx({ requestRejection: () => { throw new Error('炸了') } }))
  assert.equal(准入({ headers: {} }).码, 503)
})

test('正常请求 → 放行', () => {
  const 准入 = 建准入(造ctx({ requestRejection: () => undefined }))
  assert.equal(准入({ headers: { origin: 'http://127.0.0.1:19387' } }), null)
})

test('跨站请求 → 拒（就算宿主放行）', () => {
  const 准入 = 建准入(造ctx({ requestRejection: () => undefined }))
  assert.equal(准入({ headers: { 'sec-fetch-site': 'cross-site' } }).码, 403)
})

test('外来的 Origin → 拒', () => {
  const 准入 = 建准入(造ctx({ requestRejection: () => undefined }))
  assert.equal(准入({ headers: { origin: 'https://evil.example' } }).码, 403)
})

test('本机几种写法都放行', () => {
  const 准入 = 建准入(造ctx({ requestRejection: () => undefined }))
  for (const 源 of ['http://localhost:5173', 'http://127.0.0.1:19387', 'dsh-app://x']) {
    assert.equal(准入({ headers: { origin: 源 } }), null, 源 + ' 应该放行')
  }
})

test('包准入：拒的时候回 JSON，不调 handler', async () => {
  const 准入 = 建准入(造ctx(undefined))
  let 调了 = false
  const 回 = { 码: 0, 体: '' }
  const res = { writeHead(码) { 回.码 = 码 }, end(体) { 回.体 = 体 } }
  await 包准入(准入, () => { 调了 = true })({ headers: {}, url: '/x' }, res)
  assert.equal(调了, false, '拒了就不许再进 handler')
  assert.equal(回.码, 503)
  assert.equal(JSON.parse(回.体).error, 'management_unavailable')
})
