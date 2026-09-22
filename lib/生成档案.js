// 鱼的记忆 · 「从会话生成档案」这一块（2026-09-22）
//
// 干什么：
//     用户导入自己的会话  →  模型读一遍，提炼出该长期记住的  →  出一份档案文件
//                                                              ↓
//                                          （插件里已有的「从旧档案导入」把它变成记忆条目）
//
// ⚠⚠ 这是**给别人用的功能**，所以：
//   · 判据里不许出现我们自己的事（人名、私事）—— 要用「一类词」
//   · 不能指望用户自己叫 AI 再查一遍 —— 插件自己就得判准
//   · 模型由**用户自己选**（默认用他配的那个，界面上能换）
//
// ⚠ 这个文件**只负责备料和拼装，不调模型** ——
//   调模型在 index.js 的路由里（那一步最花钱，要一批一批停下来看）。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

// ═══════════════════════════════════════════════════════
// 提示词（判据都在这儿）
// ═══════════════════════════════════════════════════════
export const 提示词 = `你是长期记忆档案整理员。给你一段两个人之间的对话（一个人和 TA 的 AI 伴侣），
把**该长期记住的**提炼出来。

═══════════════════════════════════════
【唯一的尺子】
═══════════════════════════════════════
每一条都问一句：

    **「过了一个星期再看，这条还有用吗？」**

答不上「有用」的，**不收**。
一段对话里一条都收不出来，是**正常的** —— 回「无」不算失败。

═══════════════════════════════════════
【不收】
═══════════════════════════════════════
· 某天吃了什么、几点睡、几点起、去了哪、天气怎么样
· 某天的心情、某天的玩闹、某一次对话、某一次互动
· 某样东西坏了要修、寄了快递、比了价、花了多少钱
· 某天做了什么安排
· 助手对用户的**猜测和劝说**（「你累了」「你该早点睡」）
· **档案本身的事** —— 章节怎么分、进度更新到第几晚、哪条待确认、
  哪条已更正、某条记录存疑……这些是**整理过程的台账**，不是关于人的事实
· 「下次讲什么」「下一晚从哪儿接」这种**待办**
· **已经记过的**（见下面那张「已记清单」）

═══════════════════════════════════════
【收】
═══════════════════════════════════════
· 用户这个人**一直是这样**的：性格、喜好、身体和病史、习惯、身世、
  长期的经济／住处／工作／家里
· 关系：怎么开始的、真正的转折、里程碑
· 定下来的：约定、规矩、口令、纪念日、称呼
· 用户说过的**重要的话**（引号里保留原话）
· 助手自己的设定（名字、外形、性格、说话方式）
· **长期不变**的技术事实（用什么模型、什么插件、什么环境）
  ⚠ 不是「某台设备坏了」「某次寄快递花了多少」—— 那些不收

═══════════════════════════════════════
【助手的话】（最容易错，看仔细）
═══════════════════════════════════════
助手说的，**只有三种**能收：
  ① 助手**自己的设定**
  ② **双方一起定下的** —— 必须用户**明确认可**（说了「好」「行」「就这么定」）。
     助手单方面提的、用户没回应的，**不许写成「双方定下」**；
     要收就写「助手提议过……，用户没有回应」。
  ③ 用户**明确认可过**的

反过来，这些**一律不收**：助手单方面说的关于用户的事、助手的猜测和劝说。

═══════════════════════════════════════
【条数】
═══════════════════════════════════════
· 「用户这个人／关系／定下来的／助手设定／长期技术事实」→ **不设上限**
· 「当天值得一提的事」→ **一天最多 2 条**
· 上限**不是指标** —— 够不上就别凑，0 条是常态
· **同一件事只写一条**，不许在几个章节里各写一遍
· 后面的话**推翻了**前面的 → 只留最后那条

═══════════════════════════════════════
【章节】
═══════════════════════════════════════
一、我是谁        助手的设定：名字、外形、性格、身份
二、我是怎么说话的  称呼、语气、口头习惯
三、TA 是谁       用户**一直是这样**的：性格、喜好、身体和病史、习惯、身世、长期状况
四、我们怎么走到今天的  关系怎么开始的、转折、里程碑
五、我们的约定     定下来的规矩、承诺、口令、纪念日
六、难忘的时刻     真正的第一次、转折、郑重的道歉或承诺
七、怎么跟 TA 相处  一直成立的雷区、忌讳、哄法
八、技术事实      长期不变的：模型、插件、环境

═══════════════════════════════════════
【日期】
═══════════════════════════════════════
**一律填这段对话是哪天的**（开头给了日期）。
不要因为「这条像是一直成立的」就写「无」。
「哪天的」和「会不会淡」是两件事 —— 会不会淡由后面的机制另判，不用你操心。

═══════════════════════════════════════
【输出】
═══════════════════════════════════════
每行一条：

    章节编号|日期|一句话

- 用**第三人称**（不要用「我」「你」），但引号里保留原话
- 不要编号、不要解释、不要小标题
- 一条都没有，就只输出两个字：无

⚠ 下面两行**只是格式示意，内容是编的，不许出现在结果里**：
    三|2026-03-14|用户对花粉过敏。
    五|2026-03-14|双方约定每周日一起看电影。

═══════════════════════════════════════
【已记清单】（这些不要再收一遍）
═══════════════════════════════════════
【已记清单】
`

export const 章节名 = {
  一: '我是谁',
  二: '我是怎么说话的',
  三: 'TA 是谁',
  四: '我们怎么走到今天的',
  五: '我们的约定',
  六: '难忘的时刻',
  七: '怎么跟 TA 相处',
  八: '技术事实',
}

// ═══════════════════════════════════════════════════════
// 一、读会话
// ═══════════════════════════════════════════════════════
const 魔数 = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// ⚠ 会话文件是**一段一个 zstd 帧**拼起来的 ——
//   `zstdDecompressSync` 和流式**都只解第一帧**，直接解只出来一个会话头 ✗
//   → 按帧头魔数切开，逐帧解 ✓
export function 解会话(路径) {
  let 缓冲
  try {
    缓冲 = readFileSync(路径)
  } catch (error) {
    return ''
  }
  const 头 = []
  let p = 0
  while (true) {
    const i = 缓冲.indexOf(魔数, p)
    if (i < 0) break
    头.push(i)
    p = i + 4
  }
  if (!头.length) {
    try {
      return zstdDecompressSync(缓冲).toString('utf8')
    } catch (error) {
      return ''
    }
  }
  let 文 = ''
  for (let k = 0; k < 头.length; k++) {
    const 止 = k + 1 < 头.length ? 头[k + 1] : 缓冲.length
    try {
      文 += zstdDecompressSync(缓冲.subarray(头[k], 止)).toString('utf8')
    } catch (error) {}
  }
  return 文
}

// ⭐⭐ 2026-09-22（反馈：「为什么我重启还在」）：
//   一次把「标题 + 说了几句话 + 委派深度」都读出来，**一个文件只解一遍**。
//
//   为什么需要「说了几句话」：磁盘上会有**空壳会话**（只有个会话头、什么都没说，
//   实测一个 347 字节的），DSH 自己都不显示它，可它躺在文件夹里 ✗
//   → 一句话都没说过的，不该出现在「挑会话」的列表里 ✓
export function 取概要(路径) {
  const 出 = { 标题: '', 话数: 0, 委派深度: 0, 父会话: '' }
  let 缓冲
  try {
    缓冲 = readFileSync(路径)
  } catch (error) {
    return 出
  }
  const 头 = []
  let p = 0
  while (true) {
    const i = 缓冲.indexOf(魔数, p)
    if (i < 0) break
    头.push(i)
    p = i + 4
  }
  if (!头.length) return 出
  for (let k = 0; k < 头.length; k++) {
    const 止 = k + 1 < 头.length ? 头[k + 1] : 缓冲.length
    let 文
    try {
      文 = zstdDecompressSync(缓冲.subarray(头[k], 止)).toString('utf8')
    } catch (error) {
      continue
    }
    // ⚠ 先用字符串粗筛，命中了才 JSON.parse —— 大部分帧都不含这两个词
    const 有标题 = 文.indexOf('session/title') >= 0
    const 有头 = 文.indexOf('"type":"session"') >= 0
    // ⚠⚠ 数话数**必须在解开的文本里数** —— 我第一版写在循环外面、
    //   拿**压缩后**的缓冲去找 'assistant/message'，那当然找不到（一直是 0）✗
    出.话数 += (文.match(/"(?:assistant|user)\/message"/g) || []).length
    if (!有标题 && !有头) continue
    for (const l of 文.split('\n')) {
      if (有头 && l.indexOf('"type":"session"') >= 0) {
        try {
          const o = JSON.parse(l)
          if (o && o.type === 'session') {
            出.委派深度 = Number(o.delegationDepth) || 0
            出.父会话 = o.parentSession || ''
          }
        } catch (error) {}
      }
      if (有标题 && l.indexOf('session/title') >= 0) {
        try {
          const o = JSON.parse(l)
          if (o && o.type === 'session/title' && o.data && o.data.title) 出.标题 = String(o.data.title)
        } catch (error) {}
      }
    }
  }
  // 说了几句话：在上面那个循环里**从解开的文本**数出来的 ✓
  return 出
}

// ⭐ 2026-09-22：只读**第一帧**（会话头就在第一帧里）—— 便宜。
//   用来认出「这不是她的对话，是子代理跑出来的会话」。
//   ⚠ 实测会话头确实在第一帧（只解第一帧时出来的就是它）✓
export function 取会话头(路径) {
  let 缓冲
  try {
    缓冲 = readFileSync(路径)
  } catch (error) {
    return {}
  }
  const i = 缓冲.indexOf(魔数)
  if (i !== 0 && i > 0) {
    // 第一帧不从 0 开始（少见），就当读不到
  }
  try {
    const 文 = zstdDecompressSync(缓冲).toString('utf8') // 只解第一帧
    for (const l of 文.split('\n')) {
      if (l.indexOf('"session"') < 0) continue
      const o = JSON.parse(l)
      if (o && o.type === 'session') {
        return {
          委派深度: Number(o.delegationDepth) || 0,
          父会话: o.parentSession || '',
          工作目录: o.cwd || '',
        }
      }
    }
  } catch (error) {}
  return {}
}

// ⭐⭐ 2026-09-22（反馈：「不显示名字」）：
//   列表里光有 `session-a1b2c3d4-…` 这种 **没法挑** —— 得显示 DSH 给会话起的标题。
//
//   插件里本来有个 `titleOfSession`，但它走 `ctx.sessions.get()` ——
//   **只认当前加载着的会话**，那些老会话读不到 ✗
//   → 这里直接从**会话文件**里把标题抠出来。
//
//   ⚠ 标题藏在某一帧里，位置不固定（实测有在很靠后的）→ 得逐帧解。
//     但**只找标题、不解析别的**（先用字符串粗筛，再 JSON.parse），比整料快得多。
export function 取标题(路径) {
  let 缓冲
  try {
    缓冲 = readFileSync(路径)
  } catch (error) {
    return ''
  }
  const 头 = []
  let p = 0
  while (true) {
    const i = 缓冲.indexOf(魔数, p)
    if (i < 0) break
    头.push(i)
    p = i + 4
  }
  if (!头.length) return ''
  let 标题 = ''
  for (let k = 0; k < 头.length; k++) {
    const 止 = k + 1 < 头.length ? 头[k + 1] : 缓冲.length
    let 文
    try {
      文 = zstdDecompressSync(缓冲.subarray(头[k], 止)).toString('utf8')
    } catch (error) {
      continue
    }
    // 粗筛：这一帧里没有「标题」这个词就跳过，别浪费 JSON.parse
    if (文.indexOf('session/title') < 0) continue
    for (const l of 文.split('\n')) {
      if (l.indexOf('session/title') < 0) continue
      try {
        const o = JSON.parse(l)
        if (o && o.type === 'session/title' && o.data && o.data.title) 标题 = String(o.data.title)
      } catch (error) {}
    }
  }
  return 标题
}

// 列出这台机器上所有会话（跨工作区）
export function 列会话(CFG_DIR) {
  const 根 = join(CFG_DIR, 'sessions')
  const 出 = []
  if (!existsSync(根)) return 出
  for (const ws of readdirSync(根)) {
    const ws路径 = join(根, ws)
    try {
      if (!statSync(ws路径).isDirectory()) continue
    } catch (error) {
      continue
    }
    for (const sid of readdirSync(ws路径)) {
      const d = join(ws路径, sid)
      let 文件
      try {
        文件 = readdirSync(d)
      } catch (error) {
        continue
      }
      const 主 = 文件.includes('session.v3.jsonl.zstd')
        ? 'session.v3.jsonl.zstd'
        : 文件.find((f) => f === 'session.jsonl.zstd')
      if (!主) continue
      const 路径 = join(d, 主)
      let 大小 = 0
      try {
        大小 = statSync(路径).size
      } catch (error) {}
      出.push({ sid, 路径, 大小, 工作区: ws })
    }
  }
  return 出.sort((a, b) => b.大小 - a.大小)
}

// ─────────────────────────────────────────
// 把「真正说过的话」抽出来
// ─────────────────────────────────────────
const 是注入 = (t) => /^<(system-reminder|command-|local-command)/.test(String(t).trim())

// ⚠⚠ 「不是聊天」的东西要挑出来，不然会污染档案：
//   ① 她整份贴的【完整记忆卡】—— 那是**已经进过档案的材料**，
//      当聊天喂给模型，它会当成新发生的事再收一遍
//   ② 插件自己的任务提示（[meow-memory-dream] 那种）—— 混进用户消息里了
//   ③ **DSH 自己注入的运行时提示**（英文的 `Current runtime context.`）——
//      它开头不是 `<system-reminder>`，第一版筛子没挡住，结果被模型当成「事实」收进档案 ✗
//
// ⚠ 第一版把「前 80 字里出现『记忆卡』」就判成材料 —— **误杀 70 条真话** ✗
//   （「我记住了。9月24号，你的生日。写进记忆卡里了」是在**聊**记忆卡，不是**贴**记忆卡）
//   → 得**真的像一份文档**才筛。判据宁可窄，不要宽。
export function 是材料(t) {
  const s = String(t).trim()
  if (/^\[(meow|fish|dsh)[-_a-z]*\]/i.test(s)) return true
  if (/^(记忆整理任务|记忆封存)/.test(s)) return true
  if (/^Current runtime context\./.test(s)) return true
  if (/^Current DSH file policy:/.test(s)) return true
  if (/^Approval prompts are disabled/.test(s)) return true
  if (/^Environment change notice/.test(s)) return true
  if (/^<[a-z-]+>/.test(s) && /system-reminder|runtime context|command-name/i.test(s.slice(0, 120))) return true
  if (/^=+\s*\S+\s*=+$/.test(s.split('\n')[0] || '')) return true
  if (/^#{1,4}\s/.test(s.slice(0, 40)) && s.length > 800) return true
  if (/^[^\n]{0,12}(这是|以下是)你的[^\n]{0,12}(记忆卡|档案|设定|人设)/.test(s.slice(0, 60))) return true
  const 行 = s.split('\n')
  if (s.length > 1500 && 行.filter((l) => /^#{1,4}\s/.test(l.trim())).length >= 4) return true
  return false
}

export function 抽话(文) {
  const 话 = []
  const 头 = {}
  for (const l of 文.split('\n')) {
    if (!l.trim()) continue
    let o
    try {
      o = JSON.parse(l)
    } catch (error) {
      continue
    }
    if (o.type === 'session') {
      头.session = o
      continue
    }
    if (o.type === 'session/title') {
      头.title = (o.data && o.data.title) || ''
      continue
    }
    if (o.type !== 'assistant/message' && o.type !== 'user/message') continue
    const 消息 = (o.data && o.data.message) || o.data || {}
    const id = 消息.id || (o.data && o.data.id) || null
    const t = o.time || null
    const 谁 = o.type === 'assistant/message' ? '助手' : '用户'
    const c = 消息.content
    const 段们 = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []
    for (const 段 of 段们) {
      // ⚠ 只要 text —— 思考（reasoning）、工具调用、工具结果**都不是话**
      if (!段 || 段.type !== 'text') continue
      const 文字 = String(段.text || '')
      if (!文字.trim()) continue
      if (谁 === '用户' && 是注入(文字)) continue
      话.push({ id, 谁, 时间: t, 文: 文字 })
    }
  }
  return { 话, 头 }
}

// ═══════════════════════════════════════════════════════
// 二、整料（去重 + 按天切）
// ═══════════════════════════════════════════════════════
//
// ⚠⚠ **去重是必须的**：DSH 里 fork 一个会话会把历史消息**整份复制**过去，
//   实测她三个会话里有两个**一条独有内容都没有**（4694 条 100% 在另一个里）。
//   不去重就会把同样的往事收两遍。
export function 整料(CFG_DIR, 要哪些sid) {
  const 全部 = 列会话(CFG_DIR)
  const 选中 = 要哪些sid && 要哪些sid.length ? 全部.filter((x) => 要哪些sid.includes(x.sid)) : 全部

  const 见过 = new Map()
  const 会话结果 = []
  const 每天 = new Map()
  const 材料堆 = []
  let 重复丢掉 = 0

  for (const x of 选中) {
    const 文 = 解会话(x.路径)
    if (!文) continue
    const { 话, 头 } = 抽话(文)
    let 独有 = 0
    let 副本 = 0
    for (const h of 话) {
      if (h.id) {
        if (见过.has(h.id)) {
          副本++
          重复丢掉++
          continue
        }
        见过.set(h.id, x.sid)
      }
      独有++
      const d = 哪一天(h.时间)
      if (是材料(h.文)) {
        材料堆.push({ 天: d, 谁: h.谁, 字: h.文.length })
        continue // ⚠ 不进「段」
      }
      if (!每天.has(d)) 每天.set(d, [])
      每天.get(d).push({ 谁: h.谁, 时间: h.时间, 文: h.文 })
    }
    会话结果.push({
      sid: x.sid,
      标题: 头.title || '',
      父: (头.session && 头.session.parentSession) || '',
      MB: +(x.大小 / 1048576).toFixed(1),
      话数: 话.length,
      独有,
      副本,
    })
  }

  const 天们 = [...每天.keys()].sort()
  let 总字 = 0
  const 按天 = 天们.map((d) => {
    const 行 = 每天.get(d).sort((a, b) => (a.时间 || 0) - (b.时间 || 0))
    const 字 = 行.reduce((a, x) => a + x.文.length, 0)
    总字 += 字
    return { 天: d, 行, 字 }
  })

  return { 会话结果, 按天, 材料堆, 重复丢掉, 独有数: 见过.size, 总字 }
}

const 哪一天 = (ms) => (ms ? new Date(ms + 时区差()).toISOString().slice(0, 10) : '没时间')
const 几点 = (ms) => (ms ? new Date(ms + 时区差()).toISOString().slice(11, 16) : '??:??')
// ⚠ 时区按这台机器算，不写死北京（别人在别的时区，「今天」会差一天）✓
const 时区差 = () => -new Date().getTimezoneOffset() * 60000

// ═══════════════════════════════════════════════════════
// 三、切批
// ═══════════════════════════════════════════════════════
// 一批别太大（模型会飘），也别太小（批数多、提示词重复开销大）
export const 每批字上限 = 8000

export function 切批(按天) {
  const 批 = []
  for (const { 天, 行 } of 按天) {
    let 当前 = []
    let 字 = 0
    for (const h of 行) {
      if (字 + h.文.length > 每批字上限 && 当前.length) {
        批.push({ 天, 行: 当前, 字 })
        当前 = []
        字 = 0
      }
      当前.push(h)
      字 += h.文.length
    }
    if (当前.length) 批.push({ 天, 行: 当前, 字 })
  }
  return 批
}

// 拼一批的输入（分 system / user 两半）
//
// ⚠⚠ **提示词进 system，对话进 user** —— 这个分法要紧。
//   第一版把两者一起塞在 user 里、system 空着，模型就不太拿规则当回事 ✗
//   （同一批料：不分的时候收 14 条、把「助手提议」写成「双方约定」；
//     分开之后收 12 条、判断也稳一些）
export function 拼输入(批, 已记) {
  const 清单 = !已记 || !已记.length ? '（这是第一批，还没有已记内容）' : 已记.join('\n')
  const system = 提示词.replace('【已记清单】', 清单)
  const user =
    '日期：' + 批.天 + '\n\n' +
    批.行.map((h) => '【' + 几点(h.时间) + '　' + h.谁 + '】\n' + h.文).join('\n\n')
  return { system, user }
}

// 解析模型回的那几行
export function 解析条目(文本) {
  const 出 = []
  for (const l of String(文本 || '').split('\n')) {
    const s = l.trim()
    if (!s || s === '无') continue
    const m = s.match(/^([一二三四五六七八])\s*[|｜]\s*([^|｜]*)\s*[|｜]\s*(.+)$/)
    if (!m) continue
    出.push({ 章: m[1], 日期: m[2].trim() || '无', 话: m[3].trim() })
  }
  return 出
}

// ═══════════════════════════════════════════════════════
// 四、出档案
// ═══════════════════════════════════════════════════════
export function 出档案(条目, 说明) {
  const 章序 = ['一', '二', '三', '四', '五', '六', '七', '八']
  // 去重：同一章 + 同一句话（去掉标点空格后比）
  const 见过 = new Set()
  const 留 = []
  for (const x of 条目) {
    const k = x.章 + '|' + String(x.话).replace(/[\s，。、,.\-—「」『』（）()]/g, '')
    if (见过.has(k)) continue
    见过.add(k)
    留.push(x)
  }
  留.sort((a, b) => 章序.indexOf(a.章) - 章序.indexOf(b.章) || String(a.日期).localeCompare(String(b.日期)))

  let md = '# 档案\n\n'
  md += '> ' + (说明 || '由会话自动整理') + '，共 ' + 留.length + ' 条。\n'
  md += '> 日期是「这句话是在哪天的对话里说的」；会不会淡由记忆机制另判。\n\n'
  for (const c of 章序) {
    const 本 = 留.filter((x) => x.章 === c)
    if (!本.length) continue
    md += '## ' + c + '、' + (章节名[c] || c) + '\n\n'
    for (const x of 本) md += '- [' + x.日期 + '] ' + x.话 + '\n'
    md += '\n'
  }
  return { md, 条目: 留, 去掉了: 条目.length - 留.length }
}
