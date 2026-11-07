/**
 * 管理接口的准入 —— 失败即拒绝（issue #35）。
 *
 * 以前 `只认本人` 在拿不到 connection、或者 requestRejection 自己抛错时**放行**，
 * 于是本机任意网页都能打到 `/dsh-fish-memory/install`（一键安装包）。
 * 现在反过来：**判不了就拒**，宁可设置页多试一次，也不让别人的网页能装东西。
 */

const 本地来源 = /^(?:dsh-app:|https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$)/i

/**
 * 建一个准入函数。返回 null = 放行；返回 { 码, 说 } = 拒绝。
 */
export function 建准入(ctx, 记账 = () => {}) {
  return function 准入(req) {
    let 拒
    try {
      const 连接 = ctx.get('connection')
      if (!连接 || typeof 连接.requestRejection !== 'function') {
        // ⚠ 失败即拒绝：拿不到宿主的准入服务，就当这个请求不可信
        return { 码: 503, 说: '拿不到宿主的 connection 服务' }
      }
      拒 = 连接.requestRejection(req)
    } catch (error) {
      return { 码: 503, 说: '准入服务自己抛错：' + ((error && error.message) || error) }
    }
    if (拒 === 401 || 拒 === 403) return { 码: 拒, 说: '宿主判了外来请求' }

    // 再兜一层：浏览器带的「跨站」标记 / 不是本机来的 Origin
    const 头 = (req && req.headers) || {}
    if (String(头['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      return { 码: 403, 说: '跨站请求' }
    }
    const 源 = String(头.origin || '')
    if (源 && !本地来源.test(源)) return { 码: 403, 说: '来源不是本机：' + 源.slice(0, 80) }
    return null
  }
}

/**
 * 包一个路由处理器：先过准入，拒了就回 JSON。
 */
export function 包准入(准入, handler, 记账 = () => {}) {
  return async function 带准入的(req, res) {
    const 结果 = 准入(req)
    if (结果) {
      try {
        记账('管理接口拒了一次（' + 结果.码 + '，' + 结果.说 + '）：' + String((req && req.url) || ''))
      } catch (error) {}
      try {
        res.writeHead(结果.码, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          ok: false,
          error: 结果.码 === 401 ? 'authentication_required'
            : 结果.码 === 503 ? 'management_unavailable' : 'management_forbidden',
          说: 结果.说,
        }))
      } catch (error) {}
      return
    }
    return handler(req, res)
  }
}
