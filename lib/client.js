// DSH 鱼的记忆 · 客户端半边（设置左侧栏一项「鱼的记忆」）
window.__ModuleLoader__.load({
  id: 'dsh-fish-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const B = '/dsh-fish-memory'

    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json())
    const post = (p, body) =>
      fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json())

    const fmt = (t) => {
      if (!t) return '（没记时间）'
      const d = new Date(t)
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }
    const rel = (t, now) => {
      if (!t) return '（没记时间）'
      const dayIdx = (x) => Math.floor((new Date(x).getTime() + 8 * 3600000) / 86400000)
      const days = dayIdx(now) - dayIdx(t)
      if (!isFinite(days)) return fmt(t)
      // ⚠⚠ 2026-09-22 修（反馈：「为什么还有今天的事儿」）：
      //   原来是 `if (days <= 0) return '今天 …'` —— **负数的（未来的）也被算成今天** ✗
      //   实测：一条日期在未来的记忆→ 页面显示「今天 12:00」✗✗
      //   → 今天 / 明天 / N 天后 分开写 ✓
      if (days === 0) return '今天 ' + fmt(t).slice(6)
      if (days === -1) return '明天 ' + fmt(t).slice(6)
      if (days < 0) {
        const 后 = -days
        if (后 < 30) return 后 + ' 天后'
        return fmt(t).slice(0, 5) + '（' + Math.floor(后 / 30) + ' 个月后）'
      }
      if (days === 1) return '昨天 ' + fmt(t).slice(6)
      if (days < 30) return days + ' 天前'
      // ⭐ 2026-09-21 晚：**跨年了就必须带年份** —— 不然「09-17」看不出是哪一年 ✗
      //   （反馈：的：「过了一年会怎么显示呢？我现在看没有年份，只有月份」）
      const 今年 = new Date(new Date(now).getTime() + 8 * 3600000).getUTCFullYear()
      const 那年 = new Date(new Date(t).getTime() + 8 * 3600000).getUTCFullYear()
      if (那年 !== 今年) {
        const 差 = 今年 - 那年
        if (差 === 1) return '去年 ' + fmt(t).slice(0, 5)
        return 那年 + '-' + fmt(t).slice(0, 5) + '（' + 差 + ' 年前）'
      }
      // ⚠⚠ 2026-09-22 修（反馈：「不是两个月前啊」）：
      //   原来是 `Math.round(days / 30)` —— **四舍五入**把 47 天说成了「2 个月」✗
      //   47 天明明才一个半月。→ 改成**只进不退**（floor），零头够 15 天就说「个多月」✓
      const 月 = Math.floor(days / 30)
      const 零头 = days - 月 * 30
      return fmt(t).slice(0, 5) + '（' + 月 + (零头 >= 15 ? ' 个多' : ' 个') + '月前）'
    }
    const impName = (v) => (v >= 1 ? '非常重要' : v >= 0.5 ? '比较重要' : '随口提过')

    // ---------- 提炼 / 扩词的进度放在**组件外面** ----------
    // 为什么：跑一轮要十几二十分钟，她中途切走再回来，进度不该消失 ✓
    // ⚠ 两个**各占一格** —— 共用一个格子的话，两个一起跑会互相盖，
    //   看起来就像「点了扩词，过一会儿自己取消了」✗（2026-09-20 踩到）
    const 进度 = { 扩词: { 状态: null, 说明: null }, 提炼: { 状态: null, 说明: null }, 订阅: new Set() }
    // ⭐ 2026-09-22（反馈「点了判断，但他没有弹进度条啊，他就卡着判着呢」）：
    //   「补标不淡」原来**只有一行字、没有进度条** —— 跑起来看不出它在动 ✗
    //   （其实一直在跑，日志里一批批都有；她以为卡死了）
    //   → 给它也配一条进度条 ✓（放在组件外面，切走再回来还在）
    // ⚠ 2026-09-22（她的反馈）：这条原来跟提炼/扩词挤在同一张卡里，
    //   点了重判得往上翻才看得见 ✗ → 挪到按钮行下面，并记下**是哪一种**：
    //   「补标不淡」还是「重判一遍」，进度条上写清楚 ✓
    const 补标进度 = { 已: 0, 总: 0, 在跑: false, 重判: false }
    const 改进度 = (格, 状态, 说明) => {
      const s = 进度[格] || (进度[格] = { 状态: null, 说明: null })
      s.状态 = 状态
      s.说明 = 说明
      for (const f of 进度.订阅) {
        try {
          f()
        } catch (e) {}
      }
    }

    // 一次别画太多行 —— 库里 800 多条的时候，全画出来整个页面都会卡（连别的插件面板一起卡）✗
    const 一次最多画 = 200

    // 权重在页面上按百分比显示 ✓（0.55 → 55）
    const toPct = (v) => Math.round(Number(v) * 1000) / 10
    const fromPct = (v) => Math.round(Number(v) * 10) / 1000

    const S = {
      wrap: { padding: '16px 6px', fontSize: 13, lineHeight: 1.8, maxWidth: 780 },
      dim: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      h: { fontSize: 14, margin: '20px 0 8px', fontWeight: 600 },
      row: { padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.15)', display: 'flex', gap: 10, alignItems: 'baseline' },
      btn: { padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
      inp: { width: 72, padding: '2px 6px', borderRadius: 5, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', fontSize: 12 },
      link: { color: 'var(--dsw-alias-label-secondary, #8fa8c8)', cursor: 'pointer', textDecoration: 'underline' },
      confirm: { display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 8px 8px', padding: '6px 10px', borderRadius: 6, background: 'rgba(200,120,120,.12)', border: '1px solid rgba(200,120,120,.35)', fontSize: 12 },
      // ⚠ flexWrap：放大或窗口窄的时候要能换行，不然会横向撑出容器（右边就看不见了）✗
      nameBox: { display: 'flex', flexWrap: 'wrap', gap: 8, rowGap: 6, alignItems: 'center', margin: '10px 0', padding: '6px 10px', borderRadius: 6, background: 'rgba(128,128,128,.10)', border: '1px solid rgba(128,128,128,.22)', fontSize: 12 },
      editBox: { margin: '4px 0 10px 8px', padding: '8px 10px', borderRadius: 6, background: 'rgba(128,128,128,.10)', border: '1px solid rgba(128,128,128,.28)' },
      askBox: { display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0', padding: '8px 10px', borderRadius: 6, background: 'rgba(224,176,112,.12)', border: '1px solid rgba(224,176,112,.4)', fontSize: 12 },
      barOut: { height: 10, borderRadius: 5, background: 'rgba(128,128,128,.20)', overflow: 'hidden', border: '1px solid rgba(128,128,128,.25)' },
      barIn: { height: '100%', background: 'linear-gradient(90deg,#5b8fd6,#8fd0a0)', transition: 'width .25s' },
      area: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 5, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', fontSize: 13, lineHeight: 1.7, fontFamily: 'inherit', resize: 'vertical' },
      btnDanger: { padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(200,120,120,.6)', background: 'rgba(200,120,120,.18)', color: 'inherit', cursor: 'pointer', fontSize: 12 },
      ok: { color: '#8fd0a0' },
      drop: { color: '#c98080' },
      warn: { color: '#e0b070' },
    }

    const GROUPS = [
      ['weight', '权重', '决定「什么更容易被想起来」。四项加起来必须是 100% —— 你改一项，其余三项自动让位，你填的数会尽量保住。'],
      ['time', '遗忘速度', '数字越大 = 忘得越慢。淡了只是不容易被想起来，不会删。'],
      ['gate', '门槛与条数', '控制「一次塞多少给她」。'],
    ]

    function Section() {
      const [d, setD] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [open, setOpen] = React.useState(null) // 打开哪个会话（两级结构 ✓）
      const [params, setParams] = React.useState(null)
      const [pin, setPin] = React.useState(null) // 她刚改的那一项权重
      const [editing, setEditing] = React.useState(null) // 正在打字的那格（原样显示她敲的字）
      const [notes, setNotes] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [confirm, setConfirm] = React.useState(null) // 正在等确认的删除（二次确认，手滑不了）
      const [showDeleted, setShowDeleted] = React.useState(false)
      const [selfDraft, setSelfDraft] = React.useState({}) // 每个会话「她自己叫什么」的草稿
      const [pronounDraft, setPronounDraft] = React.useState(null) // 用户的称呼草稿
      const [edit, setEdit] = React.useState(null) // 正在改的那条：{id, text, importance}
      const [pronounAsk, setPronounAsk] = React.useState(null) // 改了称呼，问要不要连旧记忆一起改
      const [imp, setImp] = React.useState(null) // 档案导入：扫描结果 + 勾选状态
      const [impBusy, setImpBusy] = React.useState(false)
      const [impNote, setImpNote] = React.useState(null)
      const [impOpen, setImpOpen] = React.useState(false)
      // 进度放在组件外面（见上面「进度」那段）—— 她切走再回来，进度不该消失 ✓
      const [exp, setExpState] = React.useState(进度.扩词.状态)
      const [expNote, setExpNoteState] = React.useState(进度.扩词.说明)
      const [rf, setRfState] = React.useState(进度.提炼.状态)
      const [rfNote, setRfNoteState] = React.useState(进度.提炼.说明)
      const [复制开, set复制开] = React.useState(false) // 「复制记忆到别的会话」展开没有
      const [复制到, set复制到] = React.useState('') // 复制到哪个会话
      const [搜词, set搜词] = React.useState('') // 记忆列表的检索词
      const setExp = (v) => 改进度('扩词', v, 进度.扩词.说明)
      const setExpNote = (v) => 改进度('扩词', 进度.扩词.状态, v)
      const setRf = (v) => 改进度('提炼', v, 进度.提炼.说明)
      const setRfNote = (v) => 改进度('提炼', 进度.提炼.状态, v)
      const [画全部, set画全部] = React.useState(false) // 记忆列表要不要一次画完（默认只画前 200）
      const [看记忆, set看记忆] = React.useState(false) // 记忆列表展开没有（默认折叠，不然把按钮顶到很下面）
      // ⭐ 2026-09-21：列表顺序。记忆库是 push 顺序（老的在前），而下面只画前 200 条 ——
      //   不翻过来的话，她永远看不到刚写进来的那条（851 条里画的是最老的 200 条）。
      //   '新' = 最新的在最上面（默认）；'旧' = 最早的在前（想从头翻的时候用）
      const [顺序, set顺序] = React.useState('新')
      // ⭐ 2026-09-24（反馈）：**「记了时间的」和「没记时间的」混在一坨了** ✗
      //   库里 850 条只有 188 条有日期 —— 混在一起排，「中间那一段」全是没日期的，排序就白排了。
      //   原话：「要么就是这样分类，记了时间的和没记时间的分开……
      //            不然的话记和没记的就全混在一起了，这个排序就没办法用了」
      //   她要的是**自己切**（不是固定的两块）→ 三种视图轮着切 ✓
      //     '全部' = 老样子；'有时间' = 只看有日期的；'没时间' = 只看没日期的
      const [看哪边, set看哪边] = React.useState('全部')
      // ⭐ 2026-09-22（她要的）：长期事实那个「收理的文件夹」展开没有（**默认收着**）
      const [看事实, set看事实] = React.useState(false)
      // ⭐ 2026-09-22：参数那一坨默认收起来（它调一次就不动）
      const [看参数, set看参数] = React.useState(false)
      // ⭐⭐ 2026-09-22（反馈：「查重我们是不是还没找到按钮」）：
      //   去重一直有，但都是**自动**的（召回时、导入时）—— **库里已有的重复没人管** ✗
      //   这里补一个手动查重：列出来、挑、才合 ✓
      const [查重, set查重] = React.useState(null) // 查重结果：{组, 真重复组数, 汇总组数, 能少}
      const [查重选, set查重选] = React.useState({}) // 第几组 → 留哪条的 id
      const [查重开, set查重开] = React.useState(false) // 面板展开没有
      // ⭐⭐ 2026-09-22（她要的）：**批量删除**，但**必须二次确认** ✓
      //   原话：「再出一个批量删除，但还是需要 2 次确认的」
      //   ① 勾选（每条行首一个框）② 点「批量删」→ 出一个确认条 ③ 点「确定删」才真删
      //   删掉的是**收进「已删」**（不是销毁），能找回来 ✓
      const [选中, set选中] = React.useState({}) // 勾了哪些 id
      const [批删问, set批删问] = React.useState(false) // 二次确认条出来了没
      // ⭐ 2026-09-22（反馈「回收站还没有批量删除，就批量清空」）：
      //   「已删掉的」那一栏原来只有「一条条清」和「全清空」→ 补一个**批量清掉** ✓
      //   ⚠ 这个是**真销毁**（不是收起来）→ 界面必须问两遍 ✓
      const [选中清, set选中清] = React.useState({}) // 「已删」里勾了哪些
      const [批清问, set批清问] = React.useState(false)
      const [mdl, setMdl] = React.useState(null) // DSH 里有哪些模型可选
      const [impDir, setImpDir] = React.useState(null) // 档案目录草稿
      const [impNames, setImpNames] = React.useState(null) // 「指她的名字」草稿
      const [impDirs, setImpDirs] = React.useState(null) // 文件夹选择器的列表
      const [找名字, set找名字] = React.useState(null) // 自动找出来的称呼候选
      const [看原文, set看原文] = React.useState({}) // 哪几条在对照「提炼前」的原文
      // ---- 2026-09-21 新加：后台手动加一条记忆 ----
      const [加内容, set加内容] = React.useState('')
      const [加时间, set加时间] = React.useState('') // 留空 = 现在
      const [加重要, set加重要] = React.useState('0.5') // 三档是快捷，也能自己填
      const [加词, set加词] = React.useState('') // 关键词，空格分开
      const [加在谁, set加在谁] = React.useState('') // 加到哪个会话（默认第一个开着的，没有就第一个）
      const [加结果, set加结果] = React.useState(null) // { ok, 文字 }
      const [加展开, set加展开] = React.useState(false)

      // 「指她的名字」那一格：读出来、点一下加/减 ✓
      const 名字串 = () => (impNames !== null ? impNames : (imp.data && imp.data.用户名字 ? imp.data.用户名字 : []).join(','))
      const 名字们 = () => 名字串().split(/[,，]/).map((x) => x.trim()).filter(Boolean)
      const 已选名字 = (n) => 名字们().indexOf(n) >= 0
      const 点名字 = (n) => {
        const 有 = 名字们()
        const i = 有.indexOf(n)
        if (i >= 0) 有.splice(i, 1)
        else 有.push(n)
        setImpNames(有.join(','))
      }
      // 「这个不是她的名字」—— 玩偶名、旧事里的称呼…… 标了就存起来，以后不再出现、也不会被换掉 ✓
      const 标掉名字 = (n) => {
        const 现有 = 找名字 && Array.isArray(找名字.不是名字) ? 找名字.不是名字.slice() : []
        if (现有.indexOf(n) < 0) 现有.push(n)
        post('/names', { notNames: 现有 })
          .then(() => post('/names/scan', { session: open, dir: 现在目录 }))
          .then((r) => {
            set找名字(r)
            const 剩 = 名字们().filter((x) => x !== n)
            setImpNames(剩.join(','))
          })
          .catch((e) => setExpNote('标不了：' + String((e && e.message) || e)))
      }

      // 一个候选名字块：点名字=加/减，点 ✕ = 标成「不是名字」✓
      const 一个名字块 = (x, 淡) =>
        React.createElement(
          'span',
          {
            key: x.name,
            style: Object.assign({}, S.btn, {
              cursor: 'pointer',
              opacity: 淡 ? 0.7 : 1,
              color: 已选名字(x.name) ? '#8fd0a0' : 'inherit',
            }),
          },
          React.createElement('span', { onClick: () => 点名字(x.name) }, (已选名字(x.name) ? '✓ ' : '') + x.name + ' ' + x.n),
          React.createElement(
            'span',
            {
              style: Object.assign({}, S.dim, { marginLeft: 5, cursor: 'pointer' }),
              title: '不是她的名字（玩偶名、旧事里的称呼…）—— 标了就再也不出现，也不会被换掉',
              onClick: (e) => {
                if (e && e.stopPropagation) e.stopPropagation()
                标掉名字(x.name)
              },
            },
            '✕',
          ),
        )

      const load = React.useCallback(() => {
        get('/list')
          .then((x) => {
            setD(x)
            if (x && x.policy) setParams(Object.assign({}, x.policy))
            setErr(null)
          })
          .catch((e) => setErr(String((e && e.message) || e)))
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      // ---- 2026-09-21 新加：手动加一条（提交）----
      // 加到哪个会话：她选的；没选就挑第一个开着的，都没有就第一个
      const 加哪个会话 = React.useCallback(() => {
        if (加在谁) return 加在谁
        const 列 = (d && d.sessions) || []
        const 开着的 = 列.find((x) => x.enabled)
        return (开着的 || 列[0] || {}).id || ''
      }, [加在谁, d])

      const 提交一条 = React.useCallback(() => {
        const 内容 = 加内容.trim()
        if (!内容) {
          set加结果({ ok: false, 文字: '内容不能空' })
          return
        }
        const 会话 = 加哪个会话()
        if (!会话) {
          set加结果({ ok: false, 文字: '没有会话可加' })
          return
        }
        const 重要 = Number(加重要)
        set加结果({ ok: true, 文字: '加着呢…' })
        post('/add', {
          session: 会话,
          text: 内容,
          at: 加时间.trim(),
          importance: Number.isFinite(重要) ? 重要 : 0.5,
          tags: 加词.trim() ? 加词.trim().split(/[\s,，、]+/).filter(Boolean) : [],
        })
          .then((r) => {
            if (r && r.ok) {
              set加结果({ ok: true, 文字: '加上了 ✓（这个会话现在 ' + r.count + ' 条）' })
              set加内容('')
              set加时间('')
              set加词('')
              load()
            } else {
              set加结果({ ok: false, 文字: (r && (r.error || r.message)) || '没加上' })
            }
          })
          .catch((e) => set加结果({ ok: false, 文字: String((e && e.message) || e) }))
      }, [加内容, 加时间, 加重要, 加词, 加哪个会话, load])

      // 订阅外面那个「进度」—— 切走再回来也看得到还在跑 ✓
      React.useEffect(() => {
        const 同步 = () => {
          setExpState(进度.扩词.状态)
          setExpNoteState(进度.扩词.说明)
          setRfState(进度.提炼.状态)
          setRfNoteState(进度.提炼.说明)
        }
        进度.订阅.add(同步)
        同步()
        return () => {
          进度.订阅.delete(同步)
        }
      }, [])

      // 切回这个页面就重读一遍 —— 不然得手动按「刷新」才看得到别处刚发生的变化 ✓
      // ⚠ 但一定要**限流**：库里有 800 多条的时候，/list 要吐 1 MB 左右，
      //   每次切窗口都重读 + 重画一遍，整个页面（连带别的插件面板）都会卡住 ✗
      React.useEffect(() => {
        if (typeof window === 'undefined' || !window.addEventListener) return
        let 上次 = 0
        const 回来就重读 = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          if ((进度.扩词.状态 && 进度.扩词.状态.running) || (进度.提炼.状态 && 进度.提炼.状态.running)) return // 正跑着提炼/扩词，别抢
          const 现在 = Date.now()
          if (现在 - 上次 < 10000) return // 10 秒内只读一次
          上次 = 现在
          load()
        }
        window.addEventListener('focus', 回来就重读)
        document.addEventListener('visibilitychange', 回来就重读)
        return () => {
          window.removeEventListener('focus', 回来就重读)
          document.removeEventListener('visibilitychange', 回来就重读)
        }
      }, [load])

      if (err) return React.createElement('div', { style: S.wrap }, React.createElement('div', { style: S.drop }, '出错了：' + err))
      if (!d || !params) return React.createElement('div', { style: S.wrap }, '加载中…')

      const now = Date.now()

      // ---- 第二级：某个会话的详情 ----
      if (open) {
        const s = (d.sessions || []).find((x) => x.id === open)
        if (!s) return React.createElement('div', { style: S.wrap }, '找不到这个会话')
        const tr = (s.traces || []).slice(-1)[0]
        const 删 = (id, action) => post('/delete', { session: open, id, action }).then(() => { setConfirm(null); load() })
        // 提炼改坏了 —— 退回原文（单条 / 全部）✓
        const 退原文 = (id) =>
          post('/refine/undo', id === '*' ? { session: open, all: true } : { session: open, id: id })
            .then((r) => {
              setConfirm(null)
              setExpNote('✓ 退回了 ' + ((r && r.退了) || 0) + ' 条原文')
              load()
            })
            .catch((e) => setExpNote('退不回：' + String((e && e.message) || e)))
        // 把这一份记忆复制到别的会话（新对话没有上下文，测起来最干净）✓
        const 复制过去 = () =>
          post('/copy-to', { session: open, to: 复制到 })
            .then((r) => {
              setConfirm(null)
              setExpNote(r && r.ok ? '✓ 复制了 ' + r.复制了 + ' 条过去，那边开关也开了' : '✗ ' + ((r && r.message) || '？'))
              load()
            })
            .catch((e) => setExpNote('✗ ' + String((e && e.message) || e)))

        // 二次确认条（点「删」之后才出现，手滑不了）
        const 确认条 = (text, okLabel, action, id) =>
          React.createElement(
            'div',
            { style: S.confirm },
            React.createElement('span', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, text),
            React.createElement('button', { style: S.btnDanger, onClick: () => 删(id, action) }, okLabel),
            React.createElement('button', { style: S.btn, onClick: () => setConfirm(null) }, '算了'),
          )

        // 改一条：文本框 + 重要度 + 存 / 算了
        const 改一条 = (m) =>
          React.createElement(
            'div',
            { style: S.editBox },
            React.createElement('textarea', {
              style: S.area,
              rows: 3,
              value: edit.text,
              onChange: (e) => setEdit(Object.assign({}, edit, { text: e.target.value })),
            }),
            React.createElement(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
              React.createElement('span', { style: S.dim }, '重要度'),
              React.createElement(
                'select',
                {
                  style: S.inp,
                  value: String(edit.importance),
                  onChange: (e) => setEdit(Object.assign({}, edit, { importance: Number(e.target.value) })),
                },
                React.createElement('option', { value: '0' }, '随口提过'),
                React.createElement('option', { value: '0.5' }, '比较重要'),
                React.createElement('option', { value: '1' }, '非常重要（会变成「一直」记得）'),
              ),
              React.createElement('span', { style: Object.assign({}, S.dim, { flex: 1, fontSize: 12 }) }, '改之前会自动备份 ✓'),
              React.createElement(
                'button',
                {
                  style: S.btn,
                  disabled: !String(edit.text || '').trim(),
                  onClick: () =>
                    post('/edit', { session: open, id: m.id, text: edit.text, importance: edit.importance }).then(() => {
                      setEdit(null)
                      load()
                    }),
                },
                '保存修改',
              ),
              React.createElement('button', { style: S.btn, onClick: () => setEdit(null) }, '算了'),
            ),
          )

        const 一条记忆 = (m) =>
          React.createElement(
            'div',
            { key: m.id },
            React.createElement(
              'div',
              { style: S.row },
              // ⭐ 2026-09-22（她要的批量删除）：行首一个勾选框
              React.createElement('input', {
                type: 'checkbox',
                checked: !!选中[m.id],
                title: '勾上它，再点上面的「批量删」',
                onChange: () => set选中(Object.assign({}, 选中, { [m.id]: !选中[m.id] })),
              }),
              React.createElement('div', { style: Object.assign({}, S.dim, { width: 96, flex: 'none' }) }, rel(m.at, now)),
              React.createElement('div', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' } }, m.text),
              React.createElement(
                'div',
                { style: Object.assign({}, S.dim, { width: 58, flex: 'none', fontSize: 12 }), title: '鲜活度：越近就越鲜活，只影响排序。长期事实本来就不淡；没记时间的不知道是什么时候的事' },
                // ⭐⭐ 2026-09-22（反馈：「没标时间的还是鲜活 100%」）：
                //   光显示百分比会骗人 —— 长期事实本来就不淡，写「100%」像在说「刚发生」✗
                //   → 长期事实写「**不淡**」✓
                //   ⭐ 2026-09-22 再改（发现流水账来问）：**没记时间的也会淡了**
                //     （从「记下来的那天」开始算）→ 它们照常显示百分比 ✓
                //     （原来显示「没记时间」，那是我上一版判错了 —— 它们并不是不淡）
                m.freshKind === 'fact' ? '不淡'
                  : typeof m.activation === 'number' && isFinite(m.activation) ? '鲜活 ' + Math.round(m.activation * 100) + '%' : '—',
              ),
              React.createElement('div', { style: Object.assign({}, S.dim, { width: 62, flex: 'none' }) }, impName(m.importance)),
              m.textBefore
                ? React.createElement(
                    'div',
                    {
                      style: Object.assign({}, S.link, { flex: 'none', fontSize: 12, marginRight: 10 }),
                      title: '看看提炼之前长什么样',
                      onClick: () => set看原文(Object.assign({}, 看原文, { [m.id]: !看原文[m.id] })),
                    },
                    看原文[m.id] ? '收起' : '原文',
                  )
                : null,
              m.textBefore
                ? React.createElement(
                    'div',
                    {
                      style: Object.assign({}, S.link, { flex: 'none', fontSize: 12, marginRight: 10, color: '#e0b070' }),
                      title: '把这条退回提炼前的原文（退回后可以再提炼一遍）',
                      onClick: () => setConfirm({ id: m.id, kind: 'refineundo' }),
                    },
                    '退回',
                  )
                : null,
              React.createElement(
                'div',
                { style: Object.assign({}, S.link, { flex: 'none', fontSize: 12, marginRight: 10 }), onClick: () => setEdit({ id: m.id, text: m.text, importance: typeof m.importance === 'number' ? m.importance : 0.5 }) },
                '改',
              ),
              React.createElement('div', { style: Object.assign({}, S.link, { flex: 'none', fontSize: 12 }), onClick: () => setConfirm({ id: m.id, kind: 'delete' }) }, '删'),
            ),
            edit && edit.id === m.id ? 改一条(m) : null,
            confirm && confirm.id === m.id && confirm.kind === 'refineundo'
              ? React.createElement(
                  'div',
                  { style: S.confirm },
                  React.createElement('span', { style: { flex: 1 } }, '把这条退回提炼前的原文？退回后它会变回「还没提炼」。'),
                  React.createElement('button', { style: S.btn, onClick: () => 退原文(m.id) }, '退回'),
                  React.createElement('button', { style: S.btn, onClick: () => setConfirm(null) }, '算了'),
                )
              : null,
            m.textBefore && 看原文[m.id]
              ? React.createElement(
                  'div',
                  {
                    style: Object.assign({}, S.dim, {
                      margin: '0 0 6px 104px',
                      fontSize: 12,
                      whiteSpace: 'pre-wrap',
                      // ⚠ pre-wrap 只在空格/换行处断，长串（网址、长英文）照样横向撑破面板 —— 得补这两条
                      overflowWrap: 'anywhere',
                      wordBreak: 'break-word',
                      borderLeft: '2px solid rgba(224,176,112,.5)',
                      paddingLeft: 8,
                    }),
                  },
                  '提炼前：' + m.textBefore,
                )
              : null,
            m.related && m.related.length
              ? React.createElement(
                  'div',
                  { style: Object.assign({}, S.dim, { margin: '0 0 6px 104px', fontSize: 11, overflowWrap: 'anywhere', wordBreak: 'break-word' }) },
                  '能搜到它的词：' + m.related.join(' '),
                )
              : null,
            confirm && confirm.id === m.id && confirm.kind === 'delete'
              ? 确认条('把这条收起来？它会进「已删掉的」，还能找回来。', '收起来', 'delete', m.id)
              : null,
          )

        const 已删 = s.deleted || []

        // ---- 记忆列表的检索（几百条的时候靠翻是翻不到的）----
        // 正文、提炼前的原文、检索词、来源、id 都能搜 ✓
        const 关键字 = 搜词.trim().toLowerCase()
        const 搜过 = 关键字
          ? (s.memories || []).filter((m) => {
              const 包 = (x) => String(x || '').toLowerCase().indexOf(关键字) >= 0
              return (
                包(m.text) ||
                包(m.textBefore) ||
                包(m.source) ||
                包(m.id) ||
                (Array.isArray(m.related) && 包(m.related.join(' ')))
              )
            })
          : s.memories || []

        // ⭐ 2026-09-24（反馈）：**把「记了时间的」和「没记时间的」分开** ✓
        //   上一版它们混在一个列表里 —— 188 条有日期的排在上面，下面 662 条没日期的
        //   挤成「中间一坨」，看着就像排序坏了。原话：
        //   「还有中间没有记日期的，全卡在中间一坨了……不然的话记和没记的就全混在一起了，
        //     这个排序就没办法用了」
        //   她要**自己切** → 三种视图轮着切 ✓
        const 有时间 = (m) => !!m.at
        // ⭐⭐ 2026-09-22（她要的）：**「永远不淡」单独收成一栏** ✓
        //   原话：「改了就会归纳到那个永远不会淡的那一行里去了，就是那一行，
        //              我们是**单独做一个收理的文件夹一样**的，不然的话那些就不需要露在外面」
        //   ⭐ 又说：「**外面都是会淡的，里面才是不会淡的**，就不用管里面了」
        //   ⚠⚠ 2026-09-22 再改（发现两条流水账被误标）：
        //     **「不会淡」的只有一类：长期事实** ✓
        //     上一版我拿「鲜活度是不是钉住的」当判据 —— 那是**算分的副作用**，不是语义 ✗
        //     结果把 394 条**没抠到日期的流水账**错收进「不会淡的」里 ✗✗
        //     （一眼就看出不对）
        //     没记时间的现在**也会淡**（从「记下来的那天」开始算）→ 算「会淡的」✓
        const 不会淡 = (m) => m.category === 'stable_profile'
        const 过滤后 =
          看哪边 === '有时间'
            ? 搜过.filter(有时间)
            : 看哪边 === '没时间'
              ? 搜过.filter((m) => !有时间(m))
              : 看哪边 === '长期事实'
                ? 搜过.filter(不会淡)
                : 看哪边 === '会淡的'
                  ? 搜过.filter((m) => !不会淡(m))
                  : 搜过

        // ⭐ 排好序再画 —— 按**最左边那一列的日期**排 ✗✗
        //   上一版写的是 过滤后.slice().reverse()，那是把数组倒过来（谁先记谁在前翻个个儿），
        //   **根本没看日期**。所以补完日期顺序一点没变 —— 她一眼就看出来了 ✗
        // 这一版：有日期的按日期排，**没日期的排最后**（没日期 = 不知道啥时候的事，
        //   搁在中间会把有日期的顶散）✓
        // ⚠ 「没时间」那个视图里全是没日期的 → 保留类里原来的相对次序（谁先记谁在前），
        //   这样「旧的在前 / 新的在前」切一下还能看出入库先后来 ✓
        const 排序 = (m) => {
          const t = m.at ? new Date(m.at).getTime() : NaN
          return isFinite(t) ? t : null
        }
        const 排好 = 过滤后.slice().sort((a, b) => {
          const ta = 排序(a)
          const tb = 排序(b)
          if (ta === null && tb === null) return 0 // 都没日期：保持原来的相对次序
          if (ta === null) return 1 // 没日期的沉到最后
          if (tb === null) return -1
          return 顺序 === '旧' ? ta - tb : tb - ta
        })
        // 「没时间」那个视图里没有日期可比 —— 想按入库先后翻的时候还得能用 ✓
        const 画这个 = 看哪边 === '没时间' && 顺序 === '新' ? 排好.slice().reverse() : 排好
        const 有时间数 = (s.memories || []).filter(有时间).length
        const 没时间数 = (s.memories || []).length - 有时间数
        // ⭐ 2026-09-22：**不会淡的**单独收一栏（「全部」视图里才拆）
        //   ⭐ 判据 = 鲜活度钉住的那批（长期事实 + 没时间的）——
        //     原话：「外面都是会淡的，里面才是不会淡的」
        const 事实总数 = (s.memories || []).filter(不会淡).length
        const 会淡总数 = (s.memories || []).length - 事实总数

        // ⭐ 2026-09-21 晚：补日期 —— 正文里写着日期、当时却没抠出来的
        //   （老版本 抠日期 必须要四位数年份，而档案里写的是「09-17」「8月26日」）
        const 没日期的 = (s.memories || []).filter((m) => !m.at).length
        const 补日期 = () => {
          setConfirm(null)
          setBusy(true)
          post('/backfill-dates', { session: s.id })
            .then((r) => {
              setBusy(false)
              setNotes([
                r && r.补了
                  ? '补了 ' + r.补了 + ' 条日期' + (r.猜的 ? '（其中 ' + r.猜的 + ' 条年份是按最近的算的）' : '') + '，还有 ' + r.还是没 + ' 条正文里真没写日期'
                  : '没有能补的 —— 正文里找不到日期',
              ])
              load()
            })
            .catch((e) => {
              setBusy(false)
              setNotes(['补日期失败：' + ((e && e.message) || e)])
            })
        }

        // ⭐⭐ 2026-09-22（反馈）：**补标「永远不淡」** ——
        //   提炼原来只改重要度、不碰分类（0.7.6 才修好），
        //   所以实测库里 135 条该「永远不淡」的被标成了会淡的（重要的日子就在里面）。
        //   修好提炼只影响以后的，已经记下的那些得**单独补一遍** ✓
        //   一条条问模型太慢 → 一批一批来，界面循环调（照「补日期」的样子）
        //   ⭐⭐ 2026-09-22 晚（反馈：「有好多那种就不该是长期事实的」）：
        //     现在判**所有没判过的**（不只「会淡的」）—— 该升的升、**该降的降** ✓
        const 没判过的 = (s.memories || []).filter((m) => !m.stableChecked).length
        // ⭐ 2026-09-22（她要的批量删除）：勾了几条
        const 已选几条 = Object.keys(选中).filter((k) => 选中[k]).length
        // ⭐ 2026-09-22：判过几条（用来显示「重判一遍」）
        const 判过的 = (s.memories || []).filter((m) => m.stableChecked).length
        // ⭐ 2026-09-22（回收站的批量清掉）：勾了几条
        const 已选清几条 = Object.keys(选中清).filter((k) => 选中清[k]).length
        const 补不淡 = (重判) => {
          setConfirm(null)
          setBusy(true)
          let 累计判 = 0
          let 累计升 = 0
          let 累计降 = 0
          let 连着失败 = 0
          let 连着空 = 0
          let 头一趟 = true
          补标进度.在跑 = true
          补标进度.重判 = !!重判
          补标进度.已 = 0
          补标进度.总 = (s.memories || []).length
          补标进度.等 = 0
          const 跑 = () => {
            // ⚠ 重判：只在**第一趟**带这个参数（服务端会把所有「判过」标记清掉再从头判）
            const 体 = { session: s.id, 每批: 20 }
            if (重判 && 头一趟) 体.重判 = true
            头一趟 = false
            post('/backfill-stable', 体)
              .then((r) => {
                if (!r || !r.ok) {
                  // ⚠⚠ 2026-09-22（反馈：跑到一半「模型报错：429 status code (no body)」）：
                  //   限流是**暂时的**，不该直接放弃 —— 等一等再试同一批 ✓
                  //   指数退避：5s → 10s → 20s → 40s → 60s，最多 6 次
                  const 是限流 = /429|rate.?limit|too many|限流|超限/i.test(String((r && r.message) || ''))
                  if (是限流 && 连着失败 < 6) {
                    连着失败++
                    const 等 = Math.min(60000, 5000 * Math.pow(2, 连着失败 - 1))
                    补标进度.等 = Math.round(等 / 1000)
                    setNotes([
                      '⚠ 模型那边限流了（429），等 ' + Math.round(等 / 1000) + ' 秒再试…（第 ' + 连着失败 + ' 次）',
                      '已经判好的**都存下来了**，不用重头来 ✓',
                    ])
                    setTimeout(跑, 等)
                    return
                  }
                  补标进度.在跑 = false
                  setBusy(false)
                  setNotes([
                    '补标失败：' + ((r && r.message) || '？'),
                    '已经判好的**都存下来了** —— 再点一次会接着跑，不会重头来 ✓',
                  ])
                  return
                }
                连着失败 = 0
                补标进度.等 = 0
                累计判 += r.判了 || 0
                累计升 += r.改成不淡 || 0
                累计降 += r.降成会淡 || 0
                补标进度.已 = 累计判
                if (r.共) 补标进度.总 = r.共
                // ⚠⚠ 2026-09-22 修（反馈「他就卡着判着呢」）：
                //   原来这里判「完了没」用的是 `判了 > 0` ——
                //   **一批回 0 条（模型没回东西）就被当成「判完了」直接停** ✗
                //   日志实锤：07:09:21「判了 0 条，还剩 665」之后就没动静了
                //   → 改成看**服务端的 done**；一批回 0 就**接着试下一批** ✓
                //     连着 3 批都空才停（说明模型那边真出问题了），并说清楚
                连着空 = (r.判了 || 0) === 0 ? 连着空 + 1 : 0
                setNotes([
                  '正在判… 已判 ' + 累计判 + ' 条：' + 累计升 + ' 条标成「永远不淡」、' +
                    累计降 + ' 条改成会淡' + (r.done ? '' : '，还剩 ' + r.剩 + ' 条') +
                    (r.判了 === 0 && !r.done ? '　（这批模型没回东西，再试一批）' : ''),
                ])
                // ⚠ 每批之间**慢一点** —— 300ms 太急，容易撞限流（反馈就是 429 挂的）
                if (!r.done) {
                  if (连着空 >= 3) {
                    补标进度.在跑 = false
                    setBusy(false)
                    setNotes([
                      '⚠ 连着 3 批模型都没回东西，先停了（还剩 ' + r.剩 + ' 条）。',
                      '已经判好的**都存下来了** —— 再点一次会接着跑，不会重头来 ✓',
                    ])
                    return
                  }
                  setTimeout(跑, 1500)
                } else {
                  补标进度.在跑 = false
                  setBusy(false)
                  setNotes([
                    '✓ 判完了：看了 ' + 累计判 + ' 条 —— ' + 累计升 + ' 条标成「永远不淡」，' +
                      累计降 + ' 条从「永远不淡」改成会淡',
                    '（这一趟把**所有还没判过的**都过了一遍：该升的升、该降的降）',
                  ])
                  load()
                }
              })
              .catch((e) => {
                补标进度.在跑 = false
                setBusy(false)
                setNotes(['补标失败：' + ((e && e.message) || e), '已经判好的都存下来了 —— 再点一次会接着跑 ✓'])
              })
          }
          跑()
        }

        // ⭐ 2026-09-22（反馈「回收站还没有批量删除，就批量清空」）：
        //   「已删掉的」那一栏补一个**批量清掉** ✓
        //   ⚠ 这个是**真销毁**（不是收起来）→ 界面必须问两遍 ✓
        const 批清 = (会话) => {
          const ids = Object.keys(选中清).filter((k) => 选中清[k])
          if (!ids.length) {
            set批清问(false)
            return
          }
          setBusy(true)
          post('/delete', { session: 会话.id, action: 'purgebatch', ids: ids })
            .then((r) => {
              setBusy(false)
              set批清问(false)
              if (!r || !r.ok) {
                setNotes(['批量清掉失败：' + ((r && r.message) || '？')])
                return
              }
              set选中清({})
              setNotes(['✓ ' + r.message + '（「已删」里还剩 ' + r.剩 + ' 条）'])
              load()
            })
            .catch((e) => {
              setBusy(false)
              setNotes(['批量清掉失败：' + ((e && e.message) || e)])
            })
        }

        // ⭐⭐ 2026-09-22（反馈：「查重我们是不是还没做啊？我怎么没有找到按钮」）：
        //   去重一直有，但都是**自动**的 —— 召回时（注入前只留一条）、导入时。
        //   **库里已经存着的重复没人管** ✗
        //   ⚠ 不能一键全合：「汇总+明细」那种一长一短，合了会丢信息
        //     → 真重复给「一键合」，汇总+明细只列出来让她自己挑 ✓
        const 去查重 = (会话) => {
          setBusy(true)
          // ⚠⚠ 面板在**记忆列表那一块里**（跟「补标不淡」的确认框一样），
          //   列表默认是折叠的 —— 不展开就看不见面板 ✗
          //   → 点查重时**顺手把列表展开** ✓（按钮本身在标题行，永远看得见）
          set看记忆(true)
          post('/duplicates', { session: 会话.id })
            .then((r) => {
              setBusy(false)
              if (!r || !r.ok) {
                setNotes(['查重失败：' + ((r && r.message) || '？')])
                return
              }
              const 选 = {}
              ;(r.组 || []).forEach((g, i) => {
                // 默认留**最长**的那条 —— 「汇总+明细」时长的信息更全，别默认留短的 ✗
                选[i] = g.条们.reduce((a, b) => (b.长 > a.长 ? b : a), g.条们[0]).id
              })
              set查重(r)
              set查重选(选)
              set查重开(true)
              if (!(r.组 || []).length) setNotes(['✓ 查过了：没有「几乎一样」的记忆'])
            })
            .catch((e) => {
              setBusy(false)
              setNotes(['查重失败：' + ((e && e.message) || e)])
            })
        }
        // 合掉：每组留一条，其余交给**服务端再验一遍**（不像的会被保住）✓
        //   ⚠⚠ 2026-09-22 修（反馈：「把一些别的对的事实给删了」）：
        //     原来客户端自己算好「删哪些」就发过去，服务端不验 ✗
        //     现在发的是「组」（留哪条、删哪些），**服务端自己再算一遍相似度** ✓
        const 合重复 = (会话, 只合真重复) => {
          if (!查重) return
          const 组们 = []
          ;(查重.组 || []).forEach((g, i) => {
            if (只合真重复 && g.类型 !== '真重复') return
            const 留 = 查重选[i] || g.条们[0].id
            const 删 = g.条们.filter((t) => t.id !== 留).map((t) => t.id)
            if (删.length) 组们.push({ 留: 留, 删: 删 })
          })
          if (!组们.length) {
            setNotes(['这一批里没有要合的（每组都只留了一条）'])
            return
          }
          setBusy(true)
          post('/duplicates/merge', { session: 会话.id, 组: 组们 })
            .then((r) => {
              setBusy(false)
              if (!r || !r.ok) {
                setNotes(['合并：' + ((r && r.message) || '？')])
                return
              }
              const 行 = ['✓ ' + r.message + '（剩下的：' + r.剩 + ' 条）', '合掉的都收在「已删」里，点开能找回来']
              if (r.保住) {
                行.push('⚠ 有 ' + r.保住 + ' 条**不够像、没敢合**（保住了）：')
                ;(r.保住明细 || []).forEach((x) => 行.push('　　' + x.像度 + '  ' + x.text))
              }
              setNotes(行)
              set查重(null)
              set查重开(false)
              load()
            })
            .catch((e) => {
              setBusy(false)
              setNotes(['合并失败：' + ((e && e.message) || e)])
            })
        }

        // ⭐⭐ 2026-09-22（她要的）：**批量删** —— 收进「已删」，不是销毁 ✓
        //   「还是需要 2 次确认的」→ 点按钮只出确认条，确认条上再点才删 ✓
        const 批删 = (会话) => {
          const ids = Object.keys(选中).filter((k) => 选中[k])
          if (!ids.length) {
            set批删问(false)
            return
          }
          setBusy(true)
          post('/delete', { session: 会话.id, action: 'batchdelete', ids: ids })
            .then((r) => {
              setBusy(false)
              set批删问(false)
              if (!r || !r.ok) {
                setNotes(['批量删失败：' + ((r && r.message) || '？')])
                return
              }
              set选中({})
              setNotes(['✓ ' + r.message + '（剩下的：' + r.剩 + ' 条）', '删掉的都收在「已删」里，点开能找回来'])
              load()
            })
            .catch((e) => {
              setBusy(false)
              setNotes(['批量删失败：' + ((e && e.message) || e)])
            })
        }

        // ---- 用 DSH 自己的模型给记忆扩词 ----
        // 「直接用我们 deepseek 的可不可以」→ 可以 ✓ 插件能调宿主模型，不用外部 key
        const 没扩的 = (s.memories || []).filter((m) => !m.related || !m.related.length).length
        // 要提炼的：档案导入进来的、还没提炼过的 ✓
        const 没提炼的 = (s.memories || []).filter((m) => String(m.source || '').indexOf('档案导入') === 0 && !m.refined).length
        const 扩词区 = () => {
          const 小件 = []
          小件.push(React.createElement('div', { key: 'h', style: S.h }, '提炼 / 扩词（用 DSH 自己的模型）'))
          小件.push(
            React.createElement(
              'div',
              { key: 'd', style: S.dim },
              React.createElement('div', null, '两件事不一样，分开的：'),
              React.createElement(
                'div',
                { style: { margin: '4px 0 0 8px' } },
                React.createElement('b', null, '① 扩词'),
                '：给每条记忆**加一批「以后可能搜到它的词」**，比如「她的衣服是蓝色的」加上「颜色 蓝色 衣着 穿搭」。' +
                  '这样问「她喜欢什么颜色」也能捞到它。**不改记忆本身**，只是加索引。',
              ),
              React.createElement(
                'div',
                { style: { margin: '4px 0 0 8px' } },
                React.createElement('b', null, '② 提炼'),
                '：把**导入进来的档案原文**改写成「一条第一人称的记忆」。' +
                  '比如「- **极致温柔**：他会第一时间接住她的情绪」→「我会第一时间接住她的情绪」。' +
                  '**会改记忆本身**（原文留在底里，能对照）。',
              ),
              React.createElement(
                'div',
                { style: { margin: '4px 0 0 8px' } },
                '两个都在后台跑一次就行；跑完之后每轮对话**不再调用模型**，所以不卡、不额外花钱。',
              ),
            ),
          )

          // ---- 选模型 ----
          const 当前 = mdl && mdl.选中的 ? mdl.选中的 : (mdl && mdl.默认) || null
          const 当前串 = 当前 ? 当前.provider + ' / ' + 当前.model : '（还没读到）'
          小件.push(
            React.createElement(
              'div',
              { key: 'pick', style: S.nameBox },
              React.createElement('div', { style: { flex: 'none', width: 100 } }, '用哪个模型'),
              mdl
                ? React.createElement(
                    'select',
                    {
                      style: Object.assign({}, S.inp, { width: 300 }),
                      value: 当前 ? 当前.provider + '|' + 当前.model : '',
                      onChange: (e) => {
                        const v = String(e.target.value || '')
                        const i = v.indexOf('|')
                        const 选 = i > 0 ? { provider: v.slice(0, i), model: v.slice(i + 1) } : null
                        post('/names', { llmModel: 选 }).then(() => {
                          setMdl(Object.assign({}, mdl, { 选中的: 选 }))
                          setExpNote(选 ? '以后就用 ' + 选.provider + ' / ' + 选.model + ' ✓' : '改回用会话自己的模型 ✓')
                        })
                      },
                    },
                    React.createElement('option', { value: '' }, '（用会话自己的：' + (mdl.默认 ? mdl.默认.provider + '/' + mdl.默认.model : '？') + '）'),
                    (mdl.providers || []).map((p) =>
                      React.createElement(
                        'optgroup',
                        { key: p.id, label: p.name + '（' + (p.models || []).length + ' 个）' },
                        (p.models || []).map((m) =>
                          React.createElement('option', { key: p.id + '|' + m.id, value: p.id + '|' + m.id }, m.name + '　（' + p.id + '）'),
                        ),
                      ),
                    ),
                  )
                : React.createElement('span', { style: S.dim }, '点右边「读一下有哪些模型」'),
              React.createElement(
                'button',
                {
                  style: S.btn,
                  onClick: () => {
                    setExpNote('读着呢…')
                    post('/models', { session: open })
                      .then((r) => {
                        setMdl(r)
                        setExpNote(
                          r && r.ok
                            ? 'DSH 里有 ' + (r.providers || []).length + ' 个 provider，共 ' +
                              (r.providers || []).reduce((a, p) => a + (p.models || []).length, 0) + ' 个模型。现在用：' + 当前串
                            : '✗ ' + ((r && r.message) || '？'),
                        )
                      })
                      .catch((e) => setExpNote('✗ ' + String((e && e.message) || e)))
                  },
                },
                '读一下有哪些模型',
              ),
            ),
          )

          // ⚠⚠⚠ 2026-09-22（她的反馈，原话）：
          //   「他那个就是重判的进度条跟那个提炼的是在一起呀。我发现我得往下翻
          //     才能看到进度条，那就不对呀。重判应该有个单独的进度条吧？如果你
          //     点了的话，它就会弹出来；如果没点，它就没有。」
          //   她说得对 —— 补标/重判的进度条原来**跟「模型与扩词」「提炼」挤在
          //   同一张卡里**，点了重判得往上翻才看得见，没点的人还会以为那条是
          //   自己点出来的 ✗
          //   → 搬走：谁点的，进度条就跟在谁的按钮旁边（下面那个按钮行里）✓
          // ---- 进度条 ----
          if (exp && exp.总) {
            const 已 = Math.max(0, exp.总 - exp.剩)
            const 百 = exp.总 ? Math.round((已 / exp.总) * 100) : 0
            小件.push(
              React.createElement(
                'div',
                { key: 'bar', style: { margin: '8px 0' } },
                React.createElement(
                  'div',
                  { style: S.barOut },
                  React.createElement('div', { style: Object.assign({}, S.barIn, { width: 百 + '%' }) }),
                ),
                React.createElement(
                  'div',
                  { style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 4 }) },
                  (exp.模式 || '扩词') + '：' + 已 + ' / ' + exp.总 + ' 条（' + 百 + '%）' + (exp.剩 ? '　还剩 ' + exp.剩 + ' 条' : '　✓ 完事了'),
                ),
              ),
            )
          }
          // 提炼的进度条（跟扩词各一条，不互相盖）✓
          if (rf && rf.总) {
            const 已 = Math.max(0, rf.总 - rf.剩)
            const 百 = rf.总 ? Math.round((已 / rf.总) * 100) : 0
            小件.push(
              React.createElement(
                'div',
                { key: 'rfbar', style: { margin: '8px 0' } },
                React.createElement(
                  'div',
                  { style: S.barOut },
                  React.createElement('div', { style: Object.assign({}, S.barIn, { width: 百 + '%' }) }),
                ),
                React.createElement(
                  'div',
                  { style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 4 }) },
                  '提炼：' + 已 + ' / ' + rf.总 + ' 条（' + 百 + '%）' + (rf.剩 ? '　还剩 ' + rf.剩 + ' 条' : '　✓ 完事了'),
                ),
              ),
            )
          }

          小件.push(
            React.createElement(
              'div',
              { key: 'b', style: { display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' } },
              React.createElement(
                'button',
                {
                  style: S.btn,
                  disabled: !!(exp && exp.running),
                  onClick: () => {
                    setExpNote('测着呢…')
                    post('/llm-check', { session: open })
                      .then((r) => {
                        setExpNote(
                          r && r.ok
                            ? '✓ 模型通了（' + r.provider + ' / ' + r.model + '，' + r.ms + 'ms）→ 它回了「' + String(r.text || '').slice(0, 20) + '」'
                            : '✗ 不通：' + ((r && r.message) || '？'),
                        )
                      })
                      .catch((e) => setExpNote('✗ ' + String((e && e.message) || e)))
                  },
                },
                '先测一下模型',
              ),
              React.createElement(
                'button',
                {
                  style: S.btnDanger,
                  disabled: !!(exp && exp.running) || 没扩的 === 0,
                  onClick: () => {
                    let 累计 = 0
                    let 空批 = 0 // 连着几批一条词都没扩出来
                    let 每批 = 6 // 空批就把批量减半 —— 输入越少、思考越少，越不容易被截断 ✓
                    const 跑 = () => {
                      post('/expand', { session: open, 每批: 每批 })
                        .then((r) => {
                          if (!r || !r.ok) {
                            setExp({ running: false, 累计: 累计, 总: s.memories.length, 剩: r ? r.剩 : 0 })
                            setExpNote('✗ ' + ((r && r.message) || '？'))
                            load()
                            return
                          }
                          累计 += r.改了
                          setExp({ running: !r.done, 累计: 累计, 总: r.总数, 剩: r.剩, 模型: r.provider + '/' + r.model })
                          // ⚠ 一批没扩出词就收手的话，模型偶发抽风会让它看起来「自己取消」✗
                          //   空批就把**批量减半**（输入少 → 思考少 → 不容易被截断），
                          //   连着空三批才停，并说清楚原因
                          if (r.改了 > 0) {
                            空批 = 0
                            每批 = 6
                          } else {
                            空批++
                            每批 = Math.max(1, Math.floor(每批 / 2))
                          }
                          setExpNote(
                            r.改了
                              ? '这批扩了 ' + r.改了 + ' 条，还剩 ' + r.剩 + ' 条（' + r.ms + 'ms/批，' + r.provider + '/' + r.model + '）'
                              : '模型这批没回可用的词（可能思考吃光了预算）—— 下一批缩到 ' + 每批 + ' 条再试（还剩 ' + r.剩 + ' 条）',
                          )
                          if (!r.done && (r.改了 > 0 || 空批 < 3)) setTimeout(跑, 400)
                          else {
                            setExp({ running: false, 累计: 累计, 总: r.总数, 剩: r.剩 })
                            if (空批 >= 3) {
                              setExpNote('连着 ' + 空批 + ' 批模型没回可用的词（缩到 ' + 每批 + ' 条也不行），先停了 —— 过会儿再点一次「开始扩词」')
                            }
                            load()
                          }
                        })
                        .catch((e) => {
                          setExp({ running: false, 累计: 累计, 总: s.memories.length, 剩: 没扩的 })
                          setExpNote('✗ ' + String((e && e.message) || e))
                        })
                    }
                    setExp({ running: true, 累计: 0, 总: s.memories.length, 剩: 没扩的 })
                    setExpNote('开始…')
                    跑()
                  },
                },
                exp && exp.running ? '扩着呢…' : '开始扩词',
              ),
              React.createElement('span', { style: S.dim }, '② 扩词：还没扩的 ' + 没扩的 + ' / ' + (s.memories || []).length + ' 条'),
            ),
          )

          // ---- 提炼（导入进来的档案原文 → 真正的记忆）----
          小件.push(
            React.createElement(
              'div',
              { key: 'rf', style: { display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 8px', flexWrap: 'wrap' } },
              React.createElement(
                'button',
                {
                  style: S.btnDanger,
                  disabled: !!(rf && rf.running) || 没提炼的 === 0,
                  onClick: () => {
                    let 累计 = 0
                    let 跳 = 0
                    let 词 = 0
                    let 日 = 0
                    let 重 = 0
                    let 没解 = 0
                    const 跑 = () => {
                      post('/refine', { session: open, 每批: 6 })
                        .then((r) => {
                          if (!r || !r.ok) {
                            setRf({ running: false, 累计: 累计, 总: s.memories.length, 剩: r ? r.剩 : 0, 模式: '提炼' })
                            setRfNote('✗ ' + ((r && r.message) || '？'))
                            load()
                            return
                          }
                          累计 += r.改了
                          跳 += r.跳过 || 0
                          词 += r.出了词的 || 0
                          日 += r.出了日期的 || 0
                          重 += r.出了重要度 || 0
                          没解 += r.没解析出来 || 0
                          setRf({ running: !r.done, 累计: 累计, 总: 累计 + r.剩, 剩: r.剩, 模式: '提炼' })
                          setRfNote(
                            '这批改写 ' + r.改了 + ' 条、跳过 ' + (r.跳过 || 0) + ' 条，还剩 ' + r.剩 + ' 条（' +
                              r.ms + 'ms/批，' + r.provider + '/' + r.model + '）',
                          )
                          if (!r.done) setTimeout(跑, 400)
                          else {
                            setRf({ running: false, 累计: 累计, 总: 累计, 剩: 0, 模式: '提炼' })
                            // 检索词是提炼顺手出的，所以跑完这趟通常不用再单独跑扩词 ✓
                            setRfNote(
                              '✓ 提炼完了：改写 ' + 累计 + ' 条，跳过 ' + 跳 + ' 条' +
                                (词 ? '；其中 ' + 词 + ' 条顺手出了检索词，不用再跑扩词了' : '（这批没出检索词，可以再点「② 扩词」补）') +
                                (日 ? '；' + 日 + ' 条顺手出了日期' : '') +
                                (重 ? '；' + 重 + ' 条顺手判了重要度' : '') +
                                (没解 ? '；有 ' + 没解 + ' 条模型没回出东西，点「重跑跳过的」再试一次' : ''),
                            )
                            load()
                          }
                        })
                        .catch((e) => {
                          setRf({ running: false, 累计: 累计, 总: s.memories.length, 剩: 没提炼的, 模式: '提炼' })
                          setRfNote('✗ ' + String((e && e.message) || e))
                        })
                    }
                    setRf({ running: true, 累计: 0, 总: 没提炼的, 剩: 没提炼的, 模式: '提炼' })
                    setRfNote('开始提炼…')
                    跑()
                  },
                },
                rf && rf.running ? '提炼着呢…' : '开始提炼',
              ),
              React.createElement('span', { style: S.dim }, '① 提炼：还没提炼的 ' + 没提炼的 + ' 条'),
            ),
          )
          // 提炼改坏了能退回 —— 单条的在下面每条记忆上，这里是整批 ✓
          {
            const 提炼过的 = (s.memories || []).filter((m) => m.textBefore).length
            if (提炼过的 > 0) {
              小件.push(
                React.createElement(
                  'div',
                  { key: 'undo', style: { margin: '2px 0 6px' } },
                  confirm && confirm.kind === 'refineundoall'
                    ? React.createElement(
                        'div',
                        { style: S.confirm },
                        React.createElement('span', { style: { flex: 1 } }, '把提炼过的 ' + 提炼过的 + ' 条全退回原文？退回后它们会变回「还没提炼」。'),
                        React.createElement('button', { style: S.btn, onClick: () => 退原文('*') }, '全退回'),
                        React.createElement('button', { style: S.btn, onClick: () => setConfirm(null) }, '算了'),
                      )
                    : React.createElement(
                        'button',
                        {
                          style: S.btn,
                          disabled: !!(rf && rf.running),
                          title: '把提炼过的记忆全部退回提炼前的原文',
                          onClick: () => setConfirm({ id: '*', kind: 'refineundoall' }),
                        },
                        '退回全部原文（' + 提炼过的 + ' 条）',
                      ),
                ),
              )
            }
          }
          // 被「跳过」的（没改写过的）能放回队列重跑 ——
          // 模型偶尔整批回不出东西，那种不该永远躺着 ✓
          {
            const 跳过的 = (s.memories || []).filter((m) => m.refinedSkip && !m.textBefore).length
            if (跳过的 > 0) {
              小件.push(
                React.createElement(
                  'div',
                  { key: 'retry', style: { margin: '0 0 6px', fontSize: 12 } },
                  React.createElement(
                    'button',
                    {
                      style: S.btn,
                      disabled: !!(rf && rf.running),
                      title: '把「跳过」的那些放回队列，再提炼一遍（模型偶尔会整批回不出东西）',
                      onClick: () =>
                        post('/refine/retry', { session: open })
                          .then((r) => {
                            setRfNote('✓ 放回了 ' + ((r && r.放回) || 0) + ' 条，可以再点「开始提炼」')
                            load()
                          })
                          .catch((e) => setRfNote('放不回：' + String((e && e.message) || e))),
                    },
                    '重跑跳过的（' + 跳过的 + ' 条）',
                  ),
                ),
              )
            }
          }
          if (expNote) 小件.push(React.createElement('div', { key: 'n', style: Object.assign({}, S.ok, { fontSize: 12, margin: '4px 0' }) }, expNote))
          if (rfNote) 小件.push(React.createElement('div', { key: 'n2', style: Object.assign({}, S.ok, { fontSize: 12, margin: '4px 0' }) }, rfNote))

          // ---- 复制记忆到别的会话 ----
          // 新开一个空对话把记忆复制过去 —— 那边一点历史都没有，测起来最干净 ✓
          {
            const 别的 = (d.sessions || []).filter((x) => x.id !== open)
            if (别的.length) {
              小件.push(
                React.createElement(
                  'div',
                  { key: 'copy', style: { marginTop: 14 } },
                  React.createElement(
                    'div',
                    { style: Object.assign({}, S.h, { cursor: 'pointer' }), onClick: () => set复制开(!复制开) },
                    (复制开 ? '▾ ' : '▸ ') + '复制记忆到别的会话',
                  ),
                  复制开
                    ? React.createElement(
                        'div',
                        null,
                        React.createElement(
                          'div',
                          { style: S.nameBox },
                          React.createElement('div', { style: { flex: 'none', width: 76 } }, '复制到'),
                          React.createElement(
                            'select',
                            { style: Object.assign({}, S.inp, { flex: 1, width: 'auto', minWidth: 150 }), value: 复制到, onChange: (e) => set复制到(e.target.value) },
                            React.createElement('option', { value: '' }, '（选一个会话）'),
                            别的.map((x) =>
                              React.createElement('option', { key: x.id, value: x.id }, (x.title || x.id.slice(0, 18)) + '（' + x.count + ' 条）'),
                            ),
                          ),
                          React.createElement(
                            'button',
                            {
                              style: S.btnDanger,
                              disabled: !复制到 || !!(exp && exp.running) || !!(rf && rf.running),
                              onClick: () => setConfirm({ id: '*', kind: 'copyto' }),
                            },
                            '复制过去（' + (s.memories || []).length + ' 条）',
                          ),
                        ),
                        confirm && confirm.kind === 'copyto'
                          ? React.createElement(
                              'div',
                              { style: S.confirm },
                              React.createElement('span', { style: { flex: 1 } }, '把这一份 ' + (s.memories || []).length + ' 条**覆盖**到那个会话？那边原来的记忆会被换掉（覆盖前会自动备份一份 .bak）。'),
                              React.createElement('button', { style: S.btnDanger, onClick: 复制过去 }, '确认覆盖'),
                              React.createElement('button', { style: S.btn, onClick: () => setConfirm(null) }, '算了'),
                            )
                          : null,
                        React.createElement(
                          'div',
                          { style: Object.assign({}, S.dim, { fontSize: 12 }) },
                          '做法：新开一个空对话 → 回来这里把它选中 → 复制过去。那边一点历史都没有，**她答得上来就一定是插件给的** ✓（复制过去会自动把那个会话的开关打开）',
                        ),
                      )
                    : null,
                ),
              )
            }
          }
          return 小件
        }

        // ---- 从旧档案导入 ----
        // 原则（照 AAAAGENT 的「导入旧聊天」）：
        //   ① 先扫出候选，挑完再落库 —— 不直接写进库
        //   ② 已遗忘的内容不能因为再导一次就复活
        //   ③ 猜不到日期就 null，绝不编
        const 扫描 = () => {
          setImpBusy(true)
          setImpNote(null)
          post('/import/scan', { session: open })
            .then((r) => {
              setImpBusy(false)
              if (!r || !r.ok) {
                setImpNote('扫不了：' + ((r && r.message) || '？'))
                return
              }
              // 默认只勾「记忆卡 / 总档案」这种明显是记忆的 ——
              // 同一个文件夹里还有我自己的工程笔记，那个不能导 ✗
              //
              // ⚠⚠ 2026-09-24 修（反馈：「别人导入会踩什么坑」时发现的）：
              //   原来**只认「记忆卡 / 总档案」两个词** —— 别人的档案叫
              //   `my_memories.md`、`关于我.md`、`profile.txt` → **一个都不勾**，
              //   扫完看着一片空白，很容易以为没扫到 ✗
              //   → 分三层：先认像记忆的名字；一个都没认出来就**勾上有内容的**（排除明显的笔记/说明）；
              //     实在拿不准就全勾上（她还能自己取消）✓
              const 像记忆 = /记忆卡|总档案|记忆|档案|回忆|自传|memory|memoir|profile|about|diary|journal/i
              const 像笔记 = /笔记|notes?|log|readme|说明|索引|目录|index|changelog|todo|草稿|draft|脚本|script/i
              const 文件们 = r.files || []
              const files = {}
              const 第一批 = 文件们.filter((f) => 像记忆.test(f.name))
              if (第一批.length) {
                for (const f of 文件们) files[f.name] = 像记忆.test(f.name)
              } else {
                const 第二批 = 文件们.filter((f) => f.候选 > 0 && !像笔记.test(f.name))
                if (第二批.length) {
                  for (const f of 文件们) files[f.name] = f.候选 > 0 && !像笔记.test(f.name)
                } else {
                  // 实在认不出来 → 有内容的都勾上，让她自己取消（总比一个都不勾好）
                  for (const f of 文件们) files[f.name] = f.候选 > 0
                }
              }
              setImp({ data: r, files: files, off: {}, open: {} })
              setImpOpen(true)
              // ⭐ 扫到 0 条时把**原因**显示出来 —— 静默的「0 条」最坑人 ✗
              if (r.提示) setImpNote(r.提示)
            })
            .catch((e) => {
              setImpBusy(false)
              setImpNote('扫不了：' + String((e && e.message) || e))
            })
        }

        const 选中条目 = () => {
          if (!imp) return []
          return (imp.data.items || []).filter((it) => imp.files[it.file] && imp.off[it.key] !== true)
        }

        const 导入 = () => {
          const 要导 = 选中条目()
          if (!要导.length) return
          setImpBusy(true)
          setImpNote(null)
          post('/import/apply', { session: open, items: 要导 })
            .then((r) => {
              setImpBusy(false)
              setImpNote(
                r && r.ok
                  ? '导进去了 ' + r.added + ' 条' + (r.重复 ? '（跳过重复 ' + r.重复 + ' 条）' : '') + (r.近似 ? '（跳过跟已有的几乎一样的 ' + r.近似 + ' 条）' : '') + (r.删过 ? '（跳过你删过的 ' + r.删过 + ' 条）' : '')
                  : '导不了：' + ((r && r.message) || '？'),
              )
              setImp(null)
              load()
            })
            .catch((e) => {
              setImpBusy(false)
              setImpNote('导不了：' + String((e && e.message) || e))
            })
        }

        const 导入区 = () => {
          const 小件 = []
          小件.push(React.createElement('div', { key: 'h', style: S.h }, '从旧档案导入'))
          小件.push(
            React.createElement(
              'div',
              { key: 'd', style: S.dim },
              '记忆插件只管「往后」—— 装上之后它才开始自己记。你**以前**那些日子，得你先归纳一下：' +
                '把旧对话、日记、设定、备忘，整理成几个文本文件（.md / .txt）放进一个文件夹，这里再把它们拆成一条条记忆。',
            ),
          )
          小件.push(
            React.createElement(
              'div',
              {
                key: 'how',
                style: Object.assign({}, S.dim, {
                  margin: '6px 0 8px',
                  padding: '6px 10px',
                  borderRadius: 6,
                  background: 'rgba(128,128,128,.08)',
                  borderLeft: '2px solid rgba(128,128,128,.35)',
                }),
              },
              React.createElement('div', { style: { fontWeight: 600 } }, '怎么归纳（一句话：一个文件一个主题，一行一件事）'),
              React.createElement('div', null, '· 分几份写：「我是谁」「重要的人和事」「约定」「时间线」……'),
              React.createElement('div', null, '· 一行写清一件事，别写成一大段流水账 —— 拆起来才准'),
              React.createElement('div', null, '· 有日期就写上；没日期不写也行，它不会瞎猜'),
              React.createElement('div', null, '· 拆完先给你过目，挑中的才进库；导错了能整批撤销'),
              React.createElement('div', null, '· 想更干净，拆完再点「② 提炼」，让模型改写成第一人称'),
            ),
          )
          小件.push(
            React.createElement(
              'div',
              { key: 'b', style: { display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' } },
              React.createElement('button', { style: S.btn, disabled: impBusy, onClick: 扫描 }, impBusy ? '扫着呢…' : '扫描档案'),
              imp ? React.createElement('span', { style: S.dim }, '目录：' + imp.data.dir) : null,
              imp && imp.data.selfName
                ? React.createElement('span', { style: S.dim }, '（人称：「' + imp.data.selfName + '」→「我」）')
                : React.createElement('span', { style: S.warn, fontSize: 12 }, '（这个会话还没设「她自己叫什么」，导进去的人称不会自动换 —— 建议先在上面填好）'),
            ),
          )
          // 只导哪些文件 —— 同一个文件夹里常常还堆着别的文档，得能挑 ✓
          if (imp && imp.data && (imp.data.files || []).length) {
            小件.push(
              React.createElement(
                'div',
                {
                  key: 'files',
                  style: {
                    margin: '0 0 8px',
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: 'rgba(128,128,128,.08)',
                    border: '1px solid rgba(128,128,128,.2)',
                    fontSize: 12,
                  },
                },
                React.createElement('div', { style: S.dim }, '只导这些文件（默认只勾了「记忆卡／总档案」—— 别的文档别导进来）：'),
                React.createElement(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 4 } },
                  (imp.data.files || []).map((f) =>
                    React.createElement(
                      'label',
                      {
                        key: f.name,
                        style: { cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center', opacity: imp.files[f.name] ? 1 : 0.5 },
                      },
                      React.createElement('input', {
                        type: 'checkbox',
                        checked: !!imp.files[f.name],
                        onChange: (e) =>
                          setImp(Object.assign({}, imp, { files: Object.assign({}, imp.files, { [f.name]: e.target.checked }) })),
                      }),
                      f.name + '（' + f.候选 + ' 条）',
                    ),
                  ),
                ),
              ),
            )
          }
          if (impNote) 小件.push(React.createElement('div', { key: 'n', style: Object.assign({}, S.ok, { margin: '6px 0' }) }, impNote))

          // 导过几批 + 撤销 —— ⚠ 必须在 `if (!imp)` **之前**：
          // 导入完 imp 就清空了，放后面的话撤销按钮根本看不到 ✗
          const 批次 = s.importBatches || []
          if (批次.length) {
            小件.push(
              React.createElement(
                'div',
                { key: 'bt', style: { marginTop: 4 } },
                React.createElement('div', { style: { fontWeight: 600, margin: '8px 0 2px' } }, '导过 ' + 批次.length + ' 批'),
                批次.map((b) =>
                  React.createElement(
                    'div',
                    { key: b.id, style: S.row },
                    React.createElement('div', { style: { flex: 1 } }, (b.at ? rel(b.at, Date.now()) : '（不知道什么时候）') + '　' + b.n + ' 条'),
                    React.createElement(
                      'div',
                      {
                        style: Object.assign({}, S.drop, { flex: 'none', fontSize: 12, cursor: 'pointer' }),
                        onClick: () => {
                          setImpBusy(true)
                          post('/import/undo', { session: open, batch: b.id }).then((r) => {
                            setImpBusy(false)
                            setImpNote(
                              r && r.ok
                                ? '撤销了：收起了 ' + r.撤了 + ' 条（在「已删掉的」里，能一条条找回来）'
                                : '撤不了：' + ((r && r.message) || '？'),
                            )
                            load()
                          })
                        },
                      },
                      '撤销这次导入',
                    ),
                  ),
                ),
              ),
            )
          }

          if (!imp) return 小件

          // 档案目录（能选也能打）+ 档案里指她的名字
          const 现在目录 = impDir !== null ? impDir : imp.data.dir
          const 列目录 = (p) => {
            post('/dirs', { path: p || '' })
              .then((r) => {
                setImpDirs(r)
                if (r && r.ok && r.path) setImpDir(r.path)
              })
              .catch((e) => setExpNote('列不了目录：' + String((e && e.message) || e)))
          }
          // ⚠ 拆成两行、输入框用弹性宽度 ——
          //   原来四个控件挤一行，加起来 880px 撑破了 780px 的容器（放大之后更糟）✗
          小件.push(
            React.createElement(
              'div',
              { key: 'cfg', style: S.nameBox },
              React.createElement('div', { style: { flex: 'none', width: 92 } }, '档案目录'),
              React.createElement('input', {
                style: Object.assign({}, S.inp, { flex: 1, width: 'auto', minWidth: 130 }),
                value: 现在目录,
                onChange: (e) => setImpDir(e.target.value),
              }),
              React.createElement('button', { style: S.btn, onClick: () => 列目录(现在目录) }, '选文件夹'),
            ),
          )
          小件.push(
            React.createElement(
              'div',
              { key: 'cfg2', style: Object.assign({}, S.nameBox, { marginTop: -4 }) },
              React.createElement('div', { style: { flex: 'none', width: 92 } }, '指她的名字'),
              React.createElement('input', {
                style: Object.assign({}, S.inp, { flex: 1, width: 'auto', minWidth: 130 }),
                placeholder: '可以不填 —— 或者点右边「自动找」',
                value: 名字串(),
                onChange: (e) => setImpNames(e.target.value),
              }),
              React.createElement(
                'button',
                {
                  style: S.btn,
                  onClick: () =>
                    post('/names/scan', { session: open, dir: 现在目录 })
                      .then((r) => set找名字(r))
                      .catch((e) => setExpNote('自动找名字失败：' + String((e && e.message) || e))),
                },
                '自动找',
              ),
              React.createElement(
                'button',
                {
                  style: S.btn,
                  onClick: () =>
                    post('/names', {
                      archiveDir: 现在目录,
                      userNames: 名字们(),
                    }).then(() => {
                      setImpDir(null)
                      setImpNames(null)
                      扫描()
                    }),
                },
                '存了重扫',
              ),
            ),
          )
          // 自动找出来的候选 —— 点一下加进上面那格，再点一下减掉 ✓
          if (找名字) {
            小件.push(
              React.createElement(
                'div',
                { key: 'names', style: { margin: '0 0 8px', padding: '6px 10px', borderRadius: 6, background: 'rgba(128,128,128,.10)', border: '1px solid rgba(128,128,128,.22)', fontSize: 12 } },
                找名字.ok === false
                  ? React.createElement('div', { style: S.drop }, '✗ ' + (找名字.message || '找不了'))
                  : React.createElement(
                      'div',
                      null,
                      React.createElement('div', null, '只喊她的 —— 点一下加进去：'),
                      React.createElement(
                        'div',
                        { style: { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0' } },
                        (找名字.候选 || []).map((x) => 一个名字块(x)),
                      ),
                      (找名字.互称 || []).length
                        ? React.createElement(
                            'div',
                            null,
                            React.createElement('div', { style: Object.assign({}, S.dim, { marginTop: 4 }) }, '互相都叫的 —— 加了会把「' + 找名字.互称[0].name + '」全换成称呼，一般别加：'),
                            React.createElement(
                              'div',
                              { style: { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0' } },
                              (找名字.互称 || []).map((x) => 一个名字块(x, true)),
                            ),
                          )
                        : null,
                      React.createElement(
                        'div',
                        { style: Object.assign({}, S.dim, { fontSize: 11 }) },
                        '数字是出现次数。底下混着界面词没关系，不点就行。填不填都不影响导入。',
                      ),
                    ),
              ),
            )
          }
          // 现在扫的是哪个目录 —— 用文字再写一遍，不靠输入框 ✓
          小件.push(
            React.createElement(
              'div',
              { key: 'nowdir', style: Object.assign({}, S.dim, { fontSize: 12, margin: '2px 0 6px' }) },
              '现在扫的是：' + imp.data.dir + '　（' + (imp.data.files || []).length + ' 个文件，' + (imp.data.items || []).length + ' 条候选）',
            ),
          )
          // 文件夹选择器
          if (impDirs) {
            小件.push(
              React.createElement(
                'div',
                { key: 'dirs', style: { margin: '0 0 8px', padding: '6px 10px', borderRadius: 6, background: 'rgba(128,128,128,.10)', border: '1px solid rgba(128,128,128,.22)', fontSize: 12 } },
                impDirs.ok === false
                  ? React.createElement('div', { style: S.drop }, '✗ ' + (impDirs.message || '列不了'))
                  : React.createElement(
                      'div',
                      null,
                      React.createElement(
                        'div',
                        { style: Object.assign({}, S.dim, { marginBottom: 4 }) },
                        impDirs.path ? '「' + impDirs.path + '」下的文件夹（点一下就进去）：' : '选一个盘：',
                      ),
                      React.createElement(
                        'div',
                        { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
                        impDirs.parent
                          ? React.createElement('span', { style: S.link, onClick: () => 列目录(impDirs.parent) }, '↑ 上一级')
                          : null,
                        (impDirs.dirs || []).map((d) =>
                          React.createElement('span', { key: d.path, style: S.link, onClick: () => 列目录(d.path) }, '📁 ' + d.name),
                        ),
                        (impDirs.dirs || []).length === 0 && !impDirs.parent
                          ? React.createElement('span', { style: S.dim }, '（这里没有子文件夹）')
                          : null,
                      ),
                      React.createElement(
                        'div',
                        { style: Object.assign({}, S.dim, { marginTop: 4 }) },
                        '看好了就点「存了重扫」✓',
                      ),
                    ),
              ),
            )
          }

          // 文件勾选
          小件.push(
            React.createElement(
              'div',
              { key: 'files', style: S.nameBox },
              React.createElement('div', { style: { flex: 'none', width: 100 } }, '扫到这些文件'),
              React.createElement(
                'div',
                { style: { flex: 1 } },
                (imp.data.files || []).map((f) =>
                  React.createElement(
                    'label',
                    { key: f.name, style: { display: 'block', cursor: 'pointer' } },
                    React.createElement('input', {
                      type: 'checkbox',
                      checked: !!imp.files[f.name],
                      onChange: (e) => setImp(Object.assign({}, imp, { files: Object.assign({}, imp.files, { [f.name]: e.target.checked }) })),
                    }),
                    ' ' + f.name + '　' + f.候选 + ' 条',
                    /记忆卡|总档案/.test(f.name) ? null : React.createElement('span', { style: S.dim }, '　（不是她的记忆？自己看着勾）'),
                  ),
                ),
              ),
            ),
          )

          // 按小节分组（只列勾了的文件）
          const 组 = {}
          for (const it of imp.data.items || []) {
            if (!imp.files[it.file]) continue
            const k = it.file + '｜' + (it.section || '（没有小节）')
            if (!组[k]) 组[k] = { file: it.file, section: it.section || '（没有小节）', items: [] }
            组[k].items.push(it)
          }
          const 组们 = Object.keys(组)
          const 选中 = 选中条目()
          const 字数 = 选中.reduce((a, it) => a + String(it.改后 || it.text).length, 0)

          小件.push(
            React.createElement(
              'div',
              { key: 'secbar', style: { display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0 4px' } },
              React.createElement('span', { style: { fontWeight: 600 } }, '按小节挑'),
              React.createElement('button', { style: S.btn, onClick: () => setImp(Object.assign({}, imp, { off: {} })) }, '全选'),
              React.createElement(
                'button',
                {
                  style: S.btn,
                  onClick: () => {
                    const off = {}
                    for (const it of imp.data.items || []) if (imp.files[it.file] && it.importance < 1) off[it.key] = true
                    setImp(Object.assign({}, imp, { off: off }))
                  },
                },
                '只留「一直」记得的',
              ),
              React.createElement(
                'button',
                {
                  style: S.btn,
                  onClick: () => {
                    const off = {}
                    for (const it of imp.data.items || []) if (imp.files[it.file]) off[it.key] = true
                    setImp(Object.assign({}, imp, { off: off }))
                  },
                },
                '全不选',
              ),
            ),
          )

          for (const k of 组们) {
            const g = 组[k]
            const 开 = !!imp.open[k]
            const 选了几条 = g.items.filter((it) => imp.off[it.key] !== true).length
            小件.push(
              React.createElement(
                'div',
                { key: 'sec' + k, style: { margin: '2px 0' } },
                React.createElement(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                  React.createElement(
                    'div',
                    { style: Object.assign({}, S.link, { flex: 1 }), onClick: () => setImp(Object.assign({}, imp, { open: Object.assign({}, imp.open, { [k]: !开 }) })) },
                    (开 ? '▾ ' : '▸ ') + g.section,
                  ),
                  React.createElement('div', { style: Object.assign({}, S.dim, { width: 90, flex: 'none' }) }, 选了几条 + ' / ' + g.items.length + ' 条'),
                  React.createElement(
                    'div',
                    {
                      style: Object.assign({}, S.link, { flex: 'none', fontSize: 12 }),
                      onClick: () => {
                        const 全选这节 = 选了几条 < g.items.length
                        const off = Object.assign({}, imp.off)
                        for (const it of g.items) if (全选这节) delete off[it.key]
                        else off[it.key] = true
                        setImp(Object.assign({}, imp, { off: off }))
                      },
                    },
                    '全选这节',
                  ),
                ),
                开
                  ? g.items.map((it) =>
                      React.createElement(
                        'div',
                        { key: it.key, style: { margin: '2px 0 6px 18px', fontSize: 12 } },
                        React.createElement(
                          'label',
                          { style: { cursor: 'pointer' } },
                          React.createElement('input', {
                            type: 'checkbox',
                            checked: imp.off[it.key] !== true,
                            onChange: (e) => setImp(Object.assign({}, imp, { off: Object.assign({}, imp.off, { [it.key]: !e.target.checked }) })),
                          }),
                          ' ',
                          React.createElement('span', { style: Object.assign({}, S.dim, { fontSize: 11 }) }, it.file + ' 第 ' + it.line + ' 行　'),
                          String(it.改后 || it.text),
                          it.at ? React.createElement('span', { style: Object.assign({}, S.ok, { fontSize: 11 }) }, '　[' + it.at.slice(0, 10) + ']') : null,
                          it.改后 && it.改后 !== it.text
                            ? React.createElement('div', { style: Object.assign({}, S.dim, { marginLeft: 18, fontSize: 11 }) }, '原文：' + it.text)
                            : null,
                        ),
                      ),
                    )
                  : null,
              ),
            )
          }

          小件.push(
            React.createElement(
              'div',
              { key: 'go', style: Object.assign({}, S.askBox, { marginTop: 10 }) },
              React.createElement('div', { style: { flex: 1 } }, '已选 ' + 选中.length + ' 条，共约 ' + 字数 + ' 字' + (选中.length ? '（一次只注入 6 条，其余在库里等着）' : '')),
              React.createElement('button', { style: S.btnDanger, disabled: impBusy || !选中.length, onClick: 导入 }, impBusy ? '导着呢…' : '导入选中的'),
            ),
          )
          return 小件
        }

        return React.createElement(
          'div',
          { style: S.wrap },
          React.createElement('div', { style: S.link, onClick: () => setOpen(null) }, '← 所有会话'),
          React.createElement('div', { style: S.h }, s.title || s.id),
          React.createElement('div', { style: S.dim }, s.id + '　' + s.memories.length + ' 条记忆' + (已删.length ? '　（另外还收着 ' + 已删.length + ' 条）' : '')),
          React.createElement(
            'div',
            { style: S.nameBox },
            React.createElement('div', { style: { flex: 'none', width: 132 } }, '她自己叫什么'),
            React.createElement('input', {
              style: Object.assign({}, S.inp, { width: 130 }),
              placeholder: '比如 小明',
              value: selfDraft[open] !== undefined ? selfDraft[open] : s.selfName || s.titleName || '',
              onChange: (e) => setSelfDraft(Object.assign({}, selfDraft, { [open]: e.target.value })),
            }),
            React.createElement(
              'button',
              {
                style: S.btn,
                onClick: () =>
                  post('/names', { session: open, selfName: (selfDraft[open] !== undefined ? selfDraft[open] : s.selfName) || '' }).then(() => {
                    setSelfDraft({})
                    load()
                  }),
              },
              '存',
            ),
            React.createElement('span', { style: Object.assign({}, S.dim, { fontSize: 12, flex: 1 }) }, '记的时候写到这个名字，会自动换成「我」—— 已有的记忆也会顺手洗一遍。' + (s.selfName ? '' : s.titleName ? '（先填的是会话标题，确认没问题点「存」）' : '')),
          ),
          // ---- 2026-09-21 新加：她自己后台手动加一条 ----
          // 跟模型自己记是两回事：它记受上面那个开关管，**手动加不受管** ✓
          // （开关管的是「他自己记不记、注不注入」，管不到她手动写）
          React.createElement(
            'div',
            { style: Object.assign({}, S.h, { cursor: 'pointer', marginTop: 16 }), onClick: () => set加展开(!加展开) },
            (加展开 ? '▾ ' : '▸ ') + '＋ 自己加一条（开关关着也能加）',
          ),
          加展开
            ? React.createElement(
                'div',
                { style: S.editBox },
                React.createElement('textarea', {
                  style: Object.assign({}, S.area, { minHeight: 54 }),
                  placeholder: '一句话说清。人称：你自己是「我」，她是「她」——写「小明」会自动换成「我」。',
                  value: 加内容,
                  onChange: (e) => set加内容(e.target.value),
                }),
                React.createElement(
                  'div',
                  { style: Object.assign({}, S.nameBox, { margin: '8px 0 0' }) },
                  React.createElement('div', { style: { flex: 'none', width: 44 } }, '时间'),
                  React.createElement('input', {
                    style: Object.assign({}, S.inp, { flex: 1, width: 'auto', minWidth: 150 }),
                    placeholder: '这件事什么时候发生的（留空＝现在）',
                    value: 加时间,
                    onChange: (e) => set加时间(e.target.value),
                  }),
                  React.createElement('span', { style: Object.assign({}, S.dim, { fontSize: 12 }) }, '比如 2026-09-19 或 2026-09-19 14:30'),
                ),
                React.createElement(
                  'div',
                  { style: Object.assign({}, S.nameBox, { margin: '6px 0 0' }) },
                  React.createElement('div', { style: { flex: 'none', width: 44 } }, '重要'),
                  ['0', '0.5', '1'].map((v) =>
                    React.createElement(
                      'button',
                      {
                        key: v,
                        style: Object.assign({}, S.btn, String(加重要) === v ? { borderColor: '#5b8fd6', color: '#8fb8f0' } : null),
                        onClick: () => set加重要(v),
                      },
                      v === '0' ? '0 随口提过' : v === '0.5' ? '0.5 比较重要' : '1 非常重要',
                    ),
                  ),
                  React.createElement('input', {
                    style: Object.assign({}, S.inp, { width: 58 }),
                    value: 加重要,
                    onChange: (e) => set加重要(e.target.value),
                  }),
                  React.createElement('span', { style: Object.assign({}, S.dim, { fontSize: 12 }) }, '也能自己填 0~1'),
                ),
                React.createElement(
                  'div',
                  { style: Object.assign({}, S.nameBox, { margin: '6px 0 0' }) },
                  React.createElement('div', { style: { flex: 'none', width: 44 } }, '关键词'),
                  React.createElement('input', {
                    style: Object.assign({}, S.inp, { flex: 1, width: 'auto', minWidth: 150 }),
                    placeholder: '空格分开，方便以后被想起来（可留空）',
                    value: 加词,
                    onChange: (e) => set加词(e.target.value),
                  }),
                ),
                React.createElement(
                  'div',
                  { style: Object.assign({}, S.askBox, { margin: '8px 0 0' }) },
                  React.createElement('button', { style: S.btn, onClick: 提交一条 }, '加进这个会话'),
                  React.createElement(
                    'span',
                    { style: Object.assign({}, 加结果 && 加结果.ok ? S.ok : S.drop, { fontSize: 12 }) },
                    (加结果 && 加结果.文字) || '',
                  ),
                ),
                React.createElement(
                  'div',
                  { style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 4 }) },
                  '加完记得点一下「开始扩词」—— 不然这条只有正文能搜到，检索词还是空的。',
                ),
              )
            : null,
          // ⚠ 记忆列表**默认折叠** —— 库里几百条的时候，它压在中间会把
          //   「提炼 / 扩词」那些按钮顶到很下面，她得一直翻才够得着 ✗
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 } },
            React.createElement(
              'div',
              { style: Object.assign({}, S.h, { cursor: 'pointer', margin: 0, flex: 1 }), onClick: () => set看记忆(!看记忆) },
              (看记忆 ? '▾ ' : '▸ ') + '记忆列表（' + s.memories.length + ' 条）',
            ),
            // ⭐⭐ 2026-09-22（反馈：「查重我们是不是还没做啊？我怎么没有找到按钮」）：
            //   ⚠⚠ 第一次我把它放进了**折叠起来的**记忆列表块里 ——
            //     不点开列表就看不见，那就等于没有按钮 ✗
            //     → 挪到**标题这一行**（这一行永远看得见）✓
            React.createElement(
              'button',
              {
                style: S.btn,
                title:
                  '找出库里「几乎一样」的记忆。自动去重只管召回和导入，管不到已经存着的。' +
                  '真重复能一键合；「汇总+明细」会列出来让你自己挑；合之前自动备份',
                onClick: () => 去查重(s),
              },
              '查重',
            ),
            // ⭐⭐ 2026-09-22（她要的）：**批量删除** —— 勾了几条就显示几条
            //   ⚠ 二次确认：点这里**不删**，只出确认条；确认条上再点「确定删」才真删 ✓
            已选几条 > 0
              ? React.createElement(
                  'button',
                  {
                    style: S.btnDanger,
                    title: '把勾上的这几条收进「已删」（不是销毁，能找回来）。点它不会直接删，会先问一遍',
                    onClick: () => set批删问(true),
                  },
                  '批量删（' + 已选几条 + '）',
                )
              : null,
            已选几条 > 0
              ? React.createElement(
                  'button',
                  { style: S.btn, onClick: () => { set选中({}); set批删问(false) } },
                  '取消勾选',
                )
              : null,
          ),
          // ⭐ 2026-09-24：折叠着也能一眼看出「记了时间的」有多少 ——
          //   反馈那个「中间一坨」的根源就是 850 条里只有 188 条有日期，
          //   这个数字摆在标题下面，心里有底 ✓
          React.createElement(
            'div',
            { style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 2 }) },
            '记了时间的 ' + 有时间数 + ' 条 · 没记时间的 ' + 没时间数 + ' 条' +
              (看哪边 === '全部' ? '' : '（现在只看' + (看哪边 === '有时间' ? '记了时间的' : '没记时间的') + '）'),
          ),
          看记忆
            ? React.createElement(
                'div',
                null,
                // ---- 检索框：几百条的时候，靠翻是翻不到的 ----
                React.createElement(
                  'div',
                  { style: S.nameBox },
                  React.createElement('div', { style: { flex: 'none', width: 44 } }, '找'),
                  React.createElement('input', {
                    style: Object.assign({}, S.inp, { flex: 1, width: 'auto', minWidth: 140 }),
                    placeholder: '打几个字，只留含它的（正文、原文、检索词、来源都能搜）',
                    value: 搜词,
                    onChange: (e) => set搜词(e.target.value),
                  }),
                  搜词
                    ? React.createElement('button', { style: S.btn, onClick: () => set搜词('') }, '清掉')
                    : null,
                  // ⭐ 2026-09-24（她要的）：**记了时间的 / 没记时间的分开看** ✓
                  // ⭐ 2026-09-22 又加两档：**长期事实 / 会淡的** ✓
                  //   点一下就轮到下一种：
                  //   全部 → 只记了时间的 → 只有没记时间的 → 不会淡的 → 会淡的 → 全部…
                  React.createElement(
                    'button',
                    {
                      style: S.btn,
                      title:
                        '点一下换个看法：全部 → 只记了时间的 → 只有没记时间的 → ' +
                        '不会淡的 → 会淡的 → 全部。' +
                        '「全部」那个视图里，**不会淡的**收在一个折叠的分组里（外面只剩会淡的）',
                      onClick: () =>
                        set看哪边(
                          看哪边 === '全部'
                            ? '有时间'
                            : 看哪边 === '有时间'
                              ? '没时间'
                              : 看哪边 === '没时间'
                                ? '长期事实'
                                : 看哪边 === '长期事实'
                                  ? '会淡的'
                                  : '全部',
                        ),
                    },
                    '看：' +
                      (看哪边 === '全部'
                        ? '全部'
                        : 看哪边 === '有时间'
                          ? '只记了时间的（' + 有时间数 + '）'
                          : 看哪边 === '没时间'
                            ? '只有没记时间的（' + 没时间数 + '）'
                            : 看哪边 === '长期事实'
                              ? '不会淡的（' + 事实总数 + '）'
                              : '会淡的（' + 会淡总数 + '）'),
                  ),
                  // ⭐ 顺序开关：按日期排，默认「日期新的在前」
                  //   （851 条里只画前 200 条，不排的话看到的永远是最老的）
                  React.createElement(
                    'button',
                    {
                      style: S.btn,
                      title: '按最左边的日期排。没写日期的排在最后 —— 它们不知道是什么时候的事',
                      onClick: () => set顺序(顺序 === '新' ? '旧' : '新'),
                    },
                    '日期：' + (顺序 === '新' ? '新的在前' : '老的在前'),
                  ),
                  // ⭐ 补日期：从正文里认出日期，只补没日期的（补之前自动备份）
                  没日期的 > 0
                    ? React.createElement(
                        'button',
                        {
                          style: S.btn,
                          title: '从正文里认出日期（09-17、8月26日…）。只补没日期的，已有的不动；补之前会自动备份',
                          onClick: () => setConfirm({ id: '*', kind: 'backfill' }),
                        },
                        '补日期（' + 没日期的 + '）',
                      )
                    : null,
                  // ⭐⭐ 2026-09-22：补标「永远不淡」——
                  //   提炼原来只改重要度、不碰分类，所以老记忆该不淡的没标上
                  没判过的 > 0
                    ? React.createElement(
                        'button',
                        {
                          style: S.btn,
                          title:
                            '拿模型一条条判「该不该一直记得」，判成要记一辈子的就标成「永远不淡」' +
                            '（会收进「长期事实」那一栏）。判过的不会重复问；动之前自动备份',
                          onClick: () => setConfirm({ id: '*', kind: 'stable' }),
                        },
                        '补标不淡（' + 没判过的 + '）',
                      )
                    : null,
                  // ⭐ 2026-09-22（反馈「判定太松了就得改」）：判据改严之后，
                  //   **已经判过的那批得用新判据重来一遍** —— 否则老结果一直留着 ✗
                  判过的 > 0
                    ? React.createElement(
                        'button',
                        {
                          style: S.btn,
                          title:
                            '把所有「判过」的标记清掉，用**现在的判据**从头判一遍。' +
                            '判据改过之后要用这个 —— 不然老结果一直留着。会重新调模型，动之前自动备份',
                          onClick: () => setConfirm({ id: '*', kind: 'restable' }),
                        },
                        '重判一遍（' + 判过的 + '）',
                      )
                    : null,
                ),
                confirm && confirm.kind === 'stable'
                  ? React.createElement(
                      'div',
                      { style: S.askBox },
                      React.createElement(
                        'div',
                        { style: { flex: 1 } },
                        '拿模型判一遍这 ' + 没判过的 + ' 条该不该「永远不淡」？',
                        React.createElement(
                          'div',
                          { style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 2 }) },
                          '会**调用模型**（走你 DSH 里那个），一批 20 条慢慢跑。判过的不会重复问。',
                        ),
                      ),
                      React.createElement('button', { style: S.btnDanger, disabled: busy, onClick: () => 补不淡(false) }, busy ? '判着呢…' : '开始'),
                      React.createElement('button', { style: S.btn, onClick: () => setConfirm(null) }, '算了'),
                    )
                  : null,
                // ⭐ 重判：判据改过之后，把老结果清掉重来 ✓
                confirm && confirm.kind === 'restable'
                  ? React.createElement(
                      'div',
                      { style: S.askBox },
                      React.createElement(
                        'div',
                        { style: { flex: 1 } },
                        '把 ' + 判过的 + ' 条的「判过」标记全清掉，用**现在的判据**重判一遍？',
                        React.createElement(
                          'div',
                          { style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 2 }) },
                          '判据改过之后要用这个 —— 不然老结果一直留着。会**重新调模型**（全库 ' +
                            (s.memories || []).length + ' 条，一批 20 条），动之前自动备份。',
                        ),
                      ),
                      React.createElement('button', { style: S.btnDanger, disabled: busy, onClick: () => 补不淡(true) }, busy ? '判着呢…' : '重判'),
                      React.createElement('button', { style: S.btn, onClick: () => setConfirm(null) }, '算了'),
                    )
                  : null,
                // ⭐⭐ 2026-09-22（她要的）：**补标/重判的进度条，就贴在按钮这一行下面** ✓
                //   点了才出现，没点就没有 —— 不跟提炼/扩词那条挤在一起 ✓
                补标进度.在跑 && 补标进度.总 > 0
                  ? (() => {
                      const 百 = Math.round((补标进度.已 / 补标进度.总) * 100)
                      return React.createElement(
                        'div',
                        { style: Object.assign({}, S.editBox, { marginTop: 8 }) },
                        React.createElement(
                          'div',
                          { style: { fontSize: 13, marginBottom: 4 } },
                          '⭐ ' + (补标进度.重判 ? '重判一遍' : '补标不淡') + '　跑着呢',
                        ),
                        React.createElement(
                          'div',
                          { style: S.barOut },
                          React.createElement('div', { style: Object.assign({}, S.barIn, { width: 百 + '%' }) }),
                        ),
                        React.createElement(
                          'div',
                          { style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 4 }) },
                          '已判 ' + 补标进度.已 + ' / ' + 补标进度.总 + ' 条（' + 百 + '%）' +
                            '　还剩 ' + Math.max(0, 补标进度.总 - 补标进度.已) + ' 条' +
                            (补标进度.等 ? '　⚠ 撞限流了，正在等 ' + 补标进度.等 + ' 秒' : '　（每批 20 条，跑着就动）'),
                        ),
                      )
                    })()
                  : null,
                // ⭐⭐ 2026-09-22（她要的）：**批量删的二次确认条** ✓
                //   第一次点是「批量删（N）」，出这条；第二次点「确定删」才真删 ✓
                批删问 && 已选几条 > 0
                  ? React.createElement(
                      'div',
                      { style: S.confirm },
                      React.createElement(
                        'div',
                        { style: { flex: 1 } },
                        '要删掉这 ' + 已选几条 + ' 条吗？',
                        React.createElement(
                          'div',
                          { style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 2 }) },
                          '不是销毁 —— 收进「已删」里，点开还能找回来。动之前也会自动备份。',
                        ),
                      ),
                      React.createElement('button', { style: S.btnDanger, disabled: busy, onClick: () => 批删(s) }, busy ? '删着…' : '确定删（' + 已选几条 + ' 条）'),
                      React.createElement('button', { style: S.btn, onClick: () => set批删问(false) }, '算了'),
                    )
                  : null,
                // ⚠⚠ 2026-09-22（我发现的）：`notes` 原来**只在第一级**渲染 ——
                //   而会话详情是 `if (open) return …` **提前返回**的，
                //   所以在详情页里 setNotes 的东西**一个字都看不到** ✗
                //   「补日期」「补标不淡」「查重」的结果提示全落在这儿 → 补一份 ✓
                notes && notes.length
                  ? React.createElement(
                      'div',
                      { style: Object.assign({}, S.warn, { margin: '8px 0', fontSize: 12, whiteSpace: 'pre-line' }) },
                      '　· ' + notes.join('\n　· '),
                    )
                  : null,
                查重 && 查重开
                  ? React.createElement(
                      'div',
                      { style: Object.assign({}, S.editBox, { marginTop: 8 }) },
                      [
                        React.createElement(
                          'div',
                          { key: '头', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                          React.createElement('b', null, '查重：'),
                          React.createElement('span', null, (查重.组 || []).length + ' 组、能少 ' + 查重.能少 + ' 条'),
                          React.createElement(
                            'span',
                            { style: S.dim },
                            '（真重复 ' + 查重.真重复组数 + ' 组 / 汇总+明细 ' + 查重.汇总组数 + ' 组）',
                          ),
                          React.createElement(
                            'button',
                            { style: S.btn, disabled: busy || !查重.真重复组数, onClick: () => 合重复(s, true) },
                            '一键合真重复（' + 查重.真重复组数 + ' 组）',
                          ),
                          React.createElement('button', { style: S.btn, disabled: busy, onClick: () => 合重复(s, false) }, '按我选的合'),
                          React.createElement('button', { style: S.btn, onClick: () => { set查重(null); set查重开(false) } }, '收起'),
                        ),
                        React.createElement(
                          'div',
                          { key: '说明', style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 4 }) },
                          '「真重复」= 两条长度差不多，合了安全；「汇总+明细」= 一长一短（长的把短的包住了）——' +
                            '合之前看清楚，长的那条未必真的包含了短的每个细节。每组点一下留哪条。合掉的不销毁，收在「已删」里。',
                        ),
                      ]
                        .concat(
                          (查重.组 || []).slice(0, 60).map((g, i) =>
                            React.createElement(
                              'div',
                              {
                                key: 'g' + i,
                                style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(128,128,128,.18)' },
                              },
                              [
                                React.createElement(
                                  'div',
                                  { key: 'h', style: { fontSize: 12, marginBottom: 4 } },
                                  '第 ' + (i + 1) + ' 组 · ' + g.条们.length + ' 条 · ',
                                  React.createElement('b', { style: g.类型 === '真重复' ? S.ok : S.warn }, g.类型),
                                ),
                              ].concat(
                                g.条们.map((t) =>
                                  React.createElement(
                                    'label',
                                    {
                                      key: t.id,
                                      style: { display: 'flex', gap: 6, alignItems: 'flex-start', padding: '3px 0', cursor: 'pointer' },
                                    },
                                    [
                                      React.createElement('input', {
                                        key: 'r',
                                        type: 'radio',
                                        name: '查重组' + i,
                                        checked: 查重选[i] === t.id,
                                        onChange: () => set查重选(Object.assign({}, 查重选, { [i]: t.id })),
                                      }),
                                      React.createElement(
                                        'span',
                                        { key: 't', style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } },
                                        t.text,
                                      ),
                                      React.createElement(
                                        'span',
                                        { key: 'n', style: Object.assign({}, S.dim, { fontSize: 11, whiteSpace: 'nowrap' }) },
                                        t.长 + ' 字',
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ),
                        )
                        .concat(
                          (查重.组 || []).length > 60
                            ? [
                                React.createElement(
                                  'div',
                                  { key: '更多', style: Object.assign({}, S.dim, { marginTop: 8 }) },
                                  '（只画了前 60 组，先合这些再点一次查重）',
                                ),
                              ]
                            : [],
                        ),
                    )
                  : null,
                confirm && confirm.kind === 'backfill'
                  ? React.createElement(
                      'div',
                      { style: S.confirm },
                      React.createElement('span', { style: { flex: 1 } }, '从正文里补日期？只补那 ' + 没日期的 + ' 条没日期的，已有的不动（补之前会自动备份）。'),
                      React.createElement('button', { style: S.btn, onClick: 补日期 }, '补'),
                      React.createElement('button', { style: S.btn, onClick: () => setConfirm(null) }, '算了'),
                    )
                  : null,
                搜词 || 看哪边 !== '全部'
                  ? React.createElement(
                      'div',
                      { style: Object.assign({}, S.dim, { fontSize: 12, margin: '0 0 6px' }) },
                      '这里 ' + 过滤后.length + ' 条 / 共 ' + s.memories.length + ' 条' +
                        (看哪边 === '有时间' ? '（只看记了时间的）' : 看哪边 === '没时间' ? '（只看没记时间的）' : '') +
                        (过滤后.length === 0 ? ' —— 换几个字试试，或者点上面的「看」换个范围' : ''),
                    )
                  : null,
                React.createElement(
                  'div',
                  { style: { marginTop: 10 } },
                  过滤后.length === 0
                    ? React.createElement(
                        'div',
                        { style: S.dim },
                        搜词 ? '（没有含「' + 搜词 + '」的）' : '（这个范围里没有记忆）',
                      )
                    : (() => {
                        // ⭐⭐ 2026-09-22（她要的）：**「全部」视图里，不会淡的收进一个折叠的分组** ✓
                        //   原话：「那一行，我们是单独做一个收理的文件夹一样的，
                        //              不然的话那些就不需要露在外面」
                        //   ⭐ 又说：「**外面都是会淡的，里面才是不会淡的**，就不用管里面了」
                        //   → 外面只列**会淡的**；不会淡的（长期事实 + 没时间的）
                        //     塞进「▸ 不会淡的（N 条）」里，点开才看 ✓
                        const 上 = 画这个.slice(0, 画全部 ? 画这个.length : 一次最多画)
                        // ⚠ 搜的时候**不许折叠** —— 不然搜到了却看不见 ✗
                        //   （自检逮到的：搜「衣服」时匹配的那条是长期事实，被收进分组里了）
                        if (看哪边 !== '全部' || 搜词) return 上.map(一条记忆)
                        const 会淡的 = 上.filter((m) => !不会淡(m))
                        const 不淡的 = 上.filter(不会淡)
                        return [
                          ...会淡的.map(一条记忆),
                          不淡的.length
                            ? React.createElement(
                                'div',
                                { key: '事实组' },
                                React.createElement(
                                  'div',
                                  {
                                    style: Object.assign({}, S.h, { cursor: 'pointer', marginTop: 14 }),
                                    onClick: () => set看事实(!看事实),
                                  },
                                  (看事实 ? '▾ ' : '▸ ') + '不会淡的（' + 不淡的.length + ' 条）',
                                ),
                                React.createElement(
                                  'div',
                                  { style: Object.assign({}, S.dim, { fontSize: 12, marginBottom: 4 }) },
                                  '里面这些是**长期事实**（要记一辈子的事，**不会淡**）。' +
                                    '外面那些都会淡 —— 包括**没记时间的**（它们从「记下来的那天」开始淡）。',
                                ),
                                看事实 ? 不淡的.map(一条记忆) : null,
                              )
                            : null,
                        ]
                      })(),
                ),
                过滤后.length > 一次最多画
                  ? React.createElement(
                      'div',
                      { style: { margin: '6px 0 0', fontSize: 12 } },
                      画全部
                        ? React.createElement('span', { style: S.link, onClick: () => set画全部(false) }, '↑ 收起来（只画前 ' + 一次最多画 + ' 条）')
                        : React.createElement(
                            'span',
                            { style: S.link, onClick: () => set画全部(true) },
                            '还有 ' + (过滤后.length - 一次最多画) + ' 条' +
                              (看哪边 === '没时间' ? '（更早记的）' : 顺序 === '新' ? '（更早的）' : '（更新的）') +
                              '没画出来 —— 点这里全部显示（多了会卡）',
                          ),
                    )
                  : null,
              )
            : null,
          React.createElement(
            'div',
            null,
            React.createElement('div', { style: Object.assign({}, S.h, { cursor: 'pointer' }), onClick: () => setShowDeleted(!showDeleted) }, (showDeleted ? '▾ ' : '▸ ') + '已删掉的（' + 已删.length + '）'),
            React.createElement('div', { style: S.dim }, '收起来的记忆不会被注入给她，但还留着，随时能找回来。'),
            showDeleted
              ? React.createElement(
                  'div',
                  { style: { marginTop: 6 } },
                  // ⭐⭐ 2026-09-22（反馈「你放在最下面的呀，你改到最上面去，
                  //     谁那么多条？如果有100条，我得翻到最下面才能全选吗？」）：
                  //   工具条原来在**列表最下面** —— 68 条就得翻到底才能点「全选」✗
                  //   → 挪到**最上面**，跟标题挨着 ✓
                  已删.length > 0 && (!confirm || confirm.kind !== 'purgeall')
                    ? React.createElement(
                        'div',
                        { style: { margin: '8px 0', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                        // ⭐ 一键全选 ✓
                        React.createElement(
                          'button',
                          {
                            style: S.btn,
                            title: '把这一栏里的全勾上（再点一下取消）',
                            onClick: () => {
                              if (已选清几条 === 已删.length) {
                                set选中清({})
                                set批清问(false)
                                return
                              }
                              const 全 = {}
                              for (const m of 已删) 全[m.id] = true
                              set选中清(全)
                            },
                          },
                          已选清几条 === 已删.length && 已删.length > 0 ? '取消全选' : '全选（' + 已删.length + '）',
                        ),
                        // ⭐ 批量清掉（勾了几条就显示几条）—— 点了**不直接清**，先问一遍 ✓
                        已选清几条 > 0
                          ? React.createElement(
                              'button',
                              { style: S.btnDanger, onClick: () => set批清问(true) },
                              '批量清掉（' + 已选清几条 + '）',
                            )
                          : null,
                        已选清几条 > 0
                          ? React.createElement(
                              'button',
                              { style: S.btn, onClick: () => { set选中清({}); set批清问(false) } },
                              '取消勾选',
                            )
                          : null,
                        React.createElement('button', { style: S.btn, onClick: () => setConfirm({ id: '*', kind: 'purgeall' }) }, '把「已删掉的」清空'),
                      )
                    : null,
                  已删.length === 0
                    ? React.createElement('div', { style: S.dim }, '（空的）')
                    : 已删.map((m) =>
                        React.createElement(
                          'div',
                          { key: m.id },
                          React.createElement(
                            'div',
                            { style: S.row },
                            // ⭐ 批量清掉：行首一个勾选框（跟上面那栏一样）
                            React.createElement('input', {
                              type: 'checkbox',
                              checked: !!选中清[m.id],
                              title: '勾上它，再点上面的「批量清掉」',
                              onChange: () => set选中清(Object.assign({}, 选中清, { [m.id]: !选中清[m.id] })),
                            }),
                            React.createElement('div', { style: Object.assign({}, S.dim, { width: 108, flex: 'none' }) }, '收于 ' + rel(m.deletedAt, now)),
                            React.createElement('div', { style: Object.assign({}, S.dim, { flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }) }, m.text),
                            React.createElement('div', { style: Object.assign({}, S.link, { flex: 'none', fontSize: 12, marginRight: 10 }), onClick: () => 删(m.id, 'restore') }, '找回来'),
                            React.createElement('div', { style: Object.assign({}, S.drop, { flex: 'none', fontSize: 12, cursor: 'pointer' }), onClick: () => setConfirm({ id: m.id, kind: 'purge' }) }, '彻底清掉'),
                          ),
                          confirm && confirm.id === m.id && confirm.kind === 'purge'
                            ? 确认条('彻底清掉就找不回来了（备份里可能还有）。', '确认清掉', 'purge', m.id)
                            : null,
                        ),
                      ),
                  // ⚠ 工具条已经挪到**上面**了（见前面那段）—— 这里不再重复 ✓
                  // ⭐ 批量清掉的二次确认（真销毁，所以要问第二遍）✓
                  批清问 && 已选清几条 > 0
                    ? React.createElement(
                        'div',
                        { style: S.confirm },
                        React.createElement(
                          'div',
                          { style: { flex: 1 } },
                          '要**彻底清掉**这 ' + 已选清几条 + ' 条吗？',
                          React.createElement(
                            'div',
                            { style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 2 }) },
                            '清掉就**找不回来了**（备份目录里可能还有一份）。想留就用「找回来」。',
                          ),
                        ),
                        React.createElement('button', { style: S.btnDanger, disabled: busy, onClick: () => 批清(s) }, busy ? '清着…' : '确定清掉（' + 已选清几条 + ' 条）'),
                        React.createElement('button', { style: S.btn, onClick: () => set批清问(false) }, '算了'),
                      )
                    : null,
                  confirm && confirm.kind === 'purgeall' ? 确认条('把收着的 ' + 已删.length + ' 条全清掉？找不回来了。', '全清掉', 'purgeall', '*') : null,
                )
              : null,
          ),
          // ⚠ 2026-09-22：**「备份」原来插在这里**（在「扩词」「导入」前面），
          //   可它后面跟的却是那两个区块 —— 看着像它俩的标题，其实只是句说明 ✗
          //   （「设置页面会不会有点乱」）
          //   → 挪到**末尾**，跟「这一页到底会怎么变」那些说明放一起 ✓
          React.createElement('div', null, 扩词区()),
          React.createElement(
            'div',
            { style: Object.assign({}, S.h, { cursor: 'pointer' }), onClick: () => setImpOpen(!impOpen) },
            (impOpen ? '▾ ' : '▸ ') + '从旧档案导入',
          ),
          React.createElement('div', { style: S.dim }, '把一个文件夹里的档案拆成一条条记忆，你挑完再导。文件夹在下面选。'),
          impOpen ? React.createElement('div', null, 导入区()) : null,
          tr
            ? React.createElement(
                'div',
                null,
                React.createElement('div', { style: S.h }, '最近一次召回'),
                React.createElement('div', { style: S.dim }, '线索：「' + String(tr.query || '').slice(0, 50) + '」'),
                (() => {
                  // ⚠ 按分数排再显示 —— 老记录是按**入库顺序**存的，
                  //   直接取前 12 条全是 0 分的老条目，看不出到底挑中了什么 ✗
                  //   （反馈：「这里为什么只有这些，该显示最近标中的」）
                  const 排好 = (tr.rows || []).slice().sort((a, b) => (b.P || 0) - (a.P || 0) || (b.C || 0) - (a.C || 0))
                  const 进去的 = 排好.filter((r) => !r.omission)
                  return React.createElement(
                    'div',
                    null,
                    React.createElement(
                      'div',
                      { style: Object.assign({}, S.dim, { fontSize: 12, margin: '2px 0 4px' }) },
                      进去的.length
                        ? '✓ 挑中并塞进去了 ' + 进去的.length + ' 条（排在最前面）'
                        : '这次一条都没挑中（线索跟记忆对不上）',
                    ),
                    排好.slice(0, 20).map((r, i) => {
                      const mm = s.memories.find((x) => x.id === r.id) || (s.deleted || []).find((x) => x.id === r.id)
                      const why = r.omission
                        ? { hard_gate: '没命中线索', below_threshold: '分数不够', limit: '超过条数上限', budget: '超过字数上限', duplicate: '跟另一条重复', fact_cap: '长期事实占满了名额' }[r.omission] || r.omission
                        : { assembled: '进去了', consumed: '像是用上了', invalidated: '已失效' }[r.status] || '进去了'
                      const 色 = r.omission
                        ? S.drop
                        : r.status === 'consumed'
                          ? S.ok
                          : S.dim
                      return React.createElement(
                        'div',
                        { key: i, style: S.row },
                        React.createElement(
                          'div',
                          { style: { flex: 1 } },
                          (r.omission ? '　' : '✓ ') + String((mm && mm.text) || r.id).slice(0, 60),
                        ),
                        React.createElement('div', { style: Object.assign({}, S.dim, { width: 54 }) }, 'C ' + r.C),
                        React.createElement('div', { style: Object.assign({}, S.dim, { width: 54 }) }, 'P ' + r.P),
                        React.createElement('div', { style: Object.assign({}, 色, { width: 96 }) }, why + (r.timeHit ? ' ⭐' : '')),
                      )
                    }),
                  )
                })(),
                React.createElement(
                  'div',
                  { style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 6 }) },
                  '「进去了」= 这一轮塞进提示词了；「像是用上了」= 她回复里的实词跟这条重合得多（**这是猜的**）；「已失效」= 这条后来被删了或改过。',
                ),
              )
            : null,
          // ⭐ 2026-09-22：说明都放末尾（原来「备份」插在中间，看着像别的区块的标题）
          React.createElement('div', { style: S.h }, '备份'),
          React.createElement(
            'div',
            { style: S.dim },
            '记忆一变就会自动备份：上一版存在同目录的 .bak，另外每天存一份，留 14 天。' +
              '「补日期」「补标不淡」「改」「删」之前也都会先备一份。',
          ),
        )
      }

      // ---- 第一级：会话列表 + 参数 ----
      const spec = (d.spec || []).slice()
      const byKey = {}
      for (const s of spec) byKey[s.key] = s
      const WK = spec.filter((s) => s.group === 'weight').map((s) => s.key)

      const setOne = (k, native) => {
        // 函数式更新 —— 连着改两格不会互相覆盖 ✓
        setParams((prev) => Object.assign({}, prev, { [k]: native }))
        if (WK.indexOf(k) >= 0) setPin(k)
        setNotes(null)
      }

      const wSum = WK.length ? Math.round(WK.reduce((a, k) => a + toPct(params[k] || 0), 0) * 10) / 10 : 0

      // 2026-09-21 修版式：原来五个东西挤在一行里（标签写死 110px ＋ 一整句长提示），
      // flexWrap 一装不下就拆散成「一行一个」；而 9 个字的标签在 110px 盒子里还会自己折行
      // —— 她看到那个孤零零的「活」就是「没写时间的算多鲜活」的尾巴。
      // 现在拆两行：① 标签＋数字＋单位＋范围（短，不会挤）② 提示独占一行，自己换行。
      // 单位没写就不占位（原来会留一个空的 20px 盒子）。
      const oneRow = (s) => {
        const isW = s.group === 'weight'
        const lo = isW ? toPct(s.min) : s.min
        const hi = isW ? toPct(s.max) : s.max
        const cur = isW ? toPct(params[s.key]) : params[s.key]
        const typing = editing && editing.key === s.key
        const unit = isW ? '%' : s.unit || ''
        const head = [
          React.createElement('span', { key: 'lbl', style: { flex: '0 0 auto' } }, s.label),
          React.createElement('input', {
            key: 'inp',
            type: 'number',
            style: S.inp,
            min: lo,
            max: hi,
            step: isW ? 0.1 : s.step,
            value: typing ? editing.text : String(cur),
            onChange: (e) => {
              const t = e.target.value
              setEditing({ key: s.key, text: t })
              const n = Number(t)
              if (t !== '' && isFinite(n)) setOne(s.key, isW ? fromPct(n) : n)
            },
            onBlur: () => setEditing(null),
          }),
        ]
        if (unit) head.push(React.createElement('span', { key: 'unit', style: S.dim }, unit))
        head.push(React.createElement('span', { key: 'rng', style: Object.assign({}, S.dim, { fontSize: 11, opacity: 0.75 }) }, '（' + lo + ' ~ ' + hi + '）'))
        return React.createElement(
          'div',
          { key: s.key, style: { margin: '7px 0' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' } }, head),
          s.tip
            ? React.createElement('div', { style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 2, lineHeight: 1.5 }) }, s.tip)
            : null,
        )
      }

      const save = (body) => {
        setBusy(true)
        setNotes(null)
        post('/policy', body)
          .then((r) => {
            if (r && r.policy) setParams(Object.assign({}, r.policy))
            setNotes((r && r.notes) || [])
            setBusy(false)
            load()
          })
          .catch((e) => {
            setBusy(false)
            setNotes(['保存失败：' + ((e && e.message) || e)])
          })
      }

      const blocks = []
      for (const [gid, gname, gtip] of GROUPS) {
        const rows = spec.filter((s) => s.group === gid)
        if (!rows.length) continue
        blocks.push(React.createElement('div', { key: gid, style: S.h }, gname))
        blocks.push(React.createElement('div', { key: gid + '-tip', style: S.dim }, gtip))
        if (gid === 'weight') {
          blocks.push(
            React.createElement(
              'div',
              { key: 'wsum', style: { margin: '8px 0 2px' } },
              React.createElement('span', { style: { display: 'inline-block', width: 110 } }, '合计'),
              React.createElement('span', { style: wSum === 100 ? S.ok : S.warn, fontWeight: 600 }, wSum + '%'),
              wSum === 100
                ? React.createElement('span', { style: Object.assign({}, S.dim, { marginLeft: 10, fontSize: 12 }) }, '正好 ✓')
                : React.createElement('span', { style: Object.assign({}, S.dim, { marginLeft: 10, fontSize: 12 }) }, '不是 100% —— 保存时会自动调平'),
            ),
          )
        }
        for (const s of rows) blocks.push(oneRow(s))
      }

      return React.createElement(
        'div',
        { style: S.wrap },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 } },
          React.createElement('span', { style: { fontSize: 15, fontWeight: 600 } }, '鱼的记忆'),
          React.createElement('span', { style: Object.assign({}, S.dim, { fontSize: 12 }) }, 'v' + (d.version || '?')),
        ),
        React.createElement('div', { style: Object.assign({}, S.h, { marginTop: 0 }) }, '哪些会话用记忆'),
        React.createElement(
          'div',
          { style: S.dim },
          '默认全是关的 —— 你点「开」的那个会话才会记、才会读。每个会话一份记忆，淡了只是不容易被想起来，不会删。',
        ),
        React.createElement(
          'div',
          { style: S.nameBox },
          React.createElement('div', { style: { flex: 'none', width: 132 } }, '用户的称呼'),
          React.createElement('input', {
            style: Object.assign({}, S.inp, { width: 90 }),
            placeholder: 'ta / 她 / 他',
            value: pronounDraft !== null ? pronounDraft : d.userPronoun || 'ta',
            onChange: (e) => setPronounDraft(e.target.value),
          }),
          React.createElement(
            'button',
            {
              style: S.btn,
              onClick: () => {
                const p = pronounDraft !== null ? pronounDraft : d.userPronoun || 'ta'
                post('/names', { userPronoun: p }).then((r) => {
                  setPronounDraft(null)
                  // 影响到了旧记忆就先问一句，不偷偷改 ✓
                  if (r && r.称呼影响几条 > 0 && !r.称呼已改) setPronounAsk({ n: r.称呼影响几条, to: p, 例子: r.称呼例子 || [] })
                  else setPronounAsk(null)
                  load()
                })
              },
            },
            '存',
          ),
          React.createElement('span', { style: Object.assign({}, S.dim, { fontSize: 12, flex: 1 }) }, '记忆里提到你时用哪个字。默认「ta」；设成「她」或「他」就按你设的记。'),
        ),
        pronounAsk
          ? React.createElement(
              'div',
              { style: S.askBox },
              React.createElement(
                'div',
                { style: { flex: 1 } },
                React.createElement('div', null, '已有 ' + pronounAsk.n + ' 条旧记忆里还写着旧的字。要一起改成「' + pronounAsk.to + '」吗？'),
                (pronounAsk.例子 || []).slice(0, 2).map((e, i) =>
                  React.createElement('div', { key: i, style: Object.assign({}, S.dim, { fontSize: 12, marginTop: 2 }) }, '　「' + e.旧 + '」→「' + e.新 + '」'),
                ),
              ),
              React.createElement(
                'button',
                {
                  style: S.btn,
                  onClick: () =>
                    post('/names', { userPronoun: pronounAsk.to, applyToExisting: true }).then(() => {
                      setPronounAsk(null)
                      load()
                    }),
                },
                '一起改',
              ),
              React.createElement('button', { style: S.btn, onClick: () => setPronounAsk(null) }, '以后再说'),
            )
          : null,
        (d.sessions || []).map((s) =>
          React.createElement(
            'div',
            { key: s.id, style: S.row },
            React.createElement(
              'button',
              {
                style: Object.assign({}, S.btn, {
                  flex: 'none',
                  width: 56,
                  color: s.enabled ? '#8fd0a0' : 'inherit',
                  borderColor: s.enabled ? 'rgba(143,208,160,.6)' : 'rgba(128,128,128,.35)',
                }),
                disabled: busy,
                onClick: () => {
                  setBusy(true)
                  post('/toggle', { session: s.id, on: !s.enabled })
                    .then(() => {
                      setBusy(false)
                      load()
                    })
                    .catch(() => setBusy(false))
                },
              },
              s.enabled ? '● 开' : '○ 关',
            ),
            React.createElement('div', { style: Object.assign({}, S.link, { flex: 1, minWidth: 0, overflowWrap: 'anywhere' }), onClick: () => setOpen(s.id) }, s.title || s.id.slice(0, 24)),
            s.live ? null : React.createElement('div', { style: Object.assign({}, S.dim, { width: 48, fontSize: 12 }) }, '不在线'),
            React.createElement('div', { style: Object.assign({}, S.dim, { width: 60 }) }, s.count + ' 条'),
            React.createElement('div', { style: Object.assign({}, S.dim, { width: 90 }) }, s.lastTrace ? rel(s.lastTrace, now) : '—'),
          ),
        ),
        // ⭐ 2026-09-22（「设置页面会不会有点乱」）：**参数默认收起来** ✓
        //   那是**调一次就不动**的东西，原来直接铺在会话列表下面，占了大半屏，
        //   把常用的（会话列表）挤到上面去了。收成一行，想看再点开 ✓
        React.createElement(
          'div',
          { style: Object.assign({}, S.h, { cursor: 'pointer' }), onClick: () => set看参数(!看参数) },
          (看参数 ? '▾ ' : '▸ ') + '参数（调一次就不动的东西，点开调）',
        ),
        看参数
          ? React.createElement(
              'div',
              null,
              React.createElement('div', { style: S.dim }, '这些是所有会话共用的。每项都有范围，超出会被收到范围内。'),
              blocks,
              React.createElement(
                'div',
                { style: { marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' } },
                React.createElement(
                  'button',
                  { style: S.btn, disabled: busy, onClick: () => save(Object.assign({}, params, { pin })) },
                  busy ? '保存中…' : '保存参数',
                ),
                React.createElement('button', { style: S.btn, disabled: busy, onClick: () => save({ reset: true }) }, '恢复默认'),
                React.createElement('button', { style: S.btn, disabled: busy, onClick: () => load() }, '刷新'),
              ),
            )
          : null,
        notes && notes.length
          ? React.createElement(
              'div',
              { style: Object.assign({}, S.warn, { marginTop: 8, fontSize: 12, whiteSpace: 'pre-line' }) },
              '　· ' + notes.join('\n　· '),
            )
          : null,
        React.createElement('div', { style: S.h }, '看某个会话'),
        React.createElement('div', { style: S.dim }, '点上面的会话名字'),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'memory',
            order: 51,
            label: () => '鱼的记忆',
          },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
