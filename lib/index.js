// DSH 鱼的记忆 · 宿主半边（v0.2：按会话分开）
//
// 和 v0.1 的区别：
//   v0.1：所有会话共用一份记忆 + 一份线索  →  会串（我的记忆会跑到别的会话那边）
//   v0.2：**每个 agent（会话）挂它自己的一段记忆** —— 用 agent.ctx 注册，
//         所以天然知道「我是谁」，读自己的库、用自己的线索 ✓
//
// 干三件事：
//   1. 存   —— 每个会话一份会淡忘的长期记忆（memory\<会话id>.json）
//   2. 取   —— 用「它自己会话里最近一句用户消息」当线索，按 P = C×(基础+鲜活+重要+情绪) 选几条
//   3. 注   —— 注入到它自己的系统提示词里，**每条都带时间**

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'memory'
export const inject = ['systemPrompt', 'agents', 'timer', 'tools', 'webServer', 'sessions', 'sessionTitle', 'llm']

const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORE_DIR = join(CFG_DIR, 'fish-memory')
const BACKUP_DIR = join(CFG_DIR, 'fish-memory-backup')
const CFG_PATH = join(CFG_DIR, 'fish-memory-config.json')
const DAY = 86400000
// ⭐⭐ 2026-09-21（反馈：「别人导入会踩什么坑」时改的）：**时区不能再写死北京** ✗
//   原来写死 +8。实测：换纽约、换东京，日期显示一模一样 ——
//   别人在别的时区，「今天 / 昨天」会差一天，跨年判断也会错 ✗
//   → 改成**自动认这台机器的时区**：在北京还是 +8，**对她零影响** ✓（实测过）
const TZ_OFFSET = -new Date().getTimezoneOffset() * 60000
// 「某年某月某日的中午」对应的 UTC 毫秒 —— 存日期用它，避免时区把日子推偏 ✓
//   ⚠ 原来写死 4 点（= 北京中午 12:00）。别人时区差得远时，存进去的日期会**差一天** ✗
//   → 按本地中午算：北京还是 4 点（12-8），纽约就是 17 点（12+5）✓
const 当天中午 = (y, mo, d) => Date.UTC(y, mo - 1, d, 12, 0, 0) - TZ_OFFSET
// 「这天真的存在吗」—— 用 **UTC 正午**校验，绝不会跨日 ✓
//   ⚠ 不能拿「本地中午」去校验：UTC+13 的话本地中午是前一天 23:00 UTC，
//     读 UTC 日期就变成前一天，校验会**误判成不合法** ✗
const 日期合法 = (y, mo, d) => {
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}
const VERSION = '0.9.7' // 改一次 +0.0.1，末位满 10 进位 ✓

const DEFAULT_POLICY = {
  baseHalfLifeDays: 30,
  emotionHalfLifeDays: 7,
  baselineWeight: 0.55,
  activationWeight: 0.25,
  importanceWeight: 0.15,
  emotionWeight: 0.05,
  threshold: 0.35, // ⭐ 2026-09-21 晚：改成卡 **C（证据）**，不再卡 P —— 见 recall 里那段长注释
  maxItems: 6,
  maxChars: 800,
  dailyQuota: 8,
  // ⭐ 2026-09-21 新加的两项（治「太敏感」，见 evaluate 上面的长注释）
  rarityK: 1, // 稀有度饱和点：归一化稀有度加起来到多少算「一半相关」（跟库大小无关）
  queryGate: 0.8, // 问句信息量门槛：这句话本身太没内容就不翻记忆。0 = 关掉这道门
  // ⭐ 2026-09-21 中午加的（C＋D：两条队）
  factsMax: 2, // 长期事实最多占几个位置，剩下的留给事件。0 = 事实不参与召回
  // ⭐ 2026-09-21 深夜（她的决定）：默认从 1 调到 **0.5** ✓
  //   她的直觉：「我知道时间才是劣势」——有日期的那 188 条，反倒排不到没日期的前面去 ✗
  //   实测：门槛卡 C 之后这个旋钮**只影响排序**，扫 1/0.75/0.5/0.25/0「该给到」全是 11/13 一动不动 ✓
  //   所以调它**不会误伤谁进得来**，只让没写时间的往后站 ✓
  unknownActivation: 0.5, // 没写时间的记忆（含长期事实）鲜活度按几成算。只影响排序，不影响谁进得来 ✓
}

// ---------- 参数的范围（防止调坏）----------
// 权重四项必须合计 100%，所以单独成一组，由 fitWeights 凑数 ✓
const POLICY_SPEC = [
  { key: 'baselineWeight', group: 'weight', label: '基础权重', tip: '只要被想起来就有的一份，其余三项是在它之上加的分', min: 0.5, max: 0.6, step: 0.01, pct: true },
  { key: 'activationWeight', group: 'weight', label: '鲜活度权重', tip: '越近、越常被想起的事，加得越多', min: 0.2, max: 0.3, step: 0.01, pct: true },
  { key: 'importanceWeight', group: 'weight', label: '重要度权重', tip: '标成「非常重要」的事，加得越多', min: 0.1, max: 0.2, step: 0.01, pct: true },
  { key: 'emotionWeight', group: 'weight', label: '情绪权重', tip: '带情绪的事，加得越多', min: 0.0, max: 0.1, step: 0.01, pct: true },
  { key: 'baseHalfLifeDays', group: 'time', label: '半衰期', tip: '普通的事多久淡一半。越大忘得越慢', min: 15, max: 60, step: 1, unit: '天' },
  { key: 'emotionHalfLifeDays', group: 'time', label: '情绪半衰期', tip: '情绪多久淡一半，比普通的事快', min: 3.5, max: 14, step: 0.5, unit: '天' },
  { key: 'threshold', group: 'gate', label: '证据门槛', tip: '命中的词要够「稀有」才算真的有关。它只卡证据（C），不掺鲜活度 —— 所以调它不会误伤该想起的', min: 0.1, max: 0.8, step: 0.05 },
  { key: 'maxItems', group: 'gate', label: '最多注入几条', tip: '一次最多塞几条给她。越大越占上下文', min: 1, max: 12, step: 1 },
  { key: 'maxChars', group: 'gate', label: '注入字数上限', tip: '一次注入的记忆加起来最多多少字。超了的这次先不进（下次可能就进了）', min: 200, max: 3000, step: 100, unit: '字' },
  { key: 'dailyQuota', group: 'gate', label: '每天最多记几条', tip: '她自己一天最多记几条', min: 1, max: 30, step: 1 },
  { key: 'rarityK', group: 'gate', label: '稀有度饱和点', tip: '命中词的稀有度（0~1）加起来到多少算「一半相关」。越小越容易给', min: 0.3, max: 6, step: 0.1 },
  { key: 'queryGate', group: 'gate', label: '问句信息量门槛', tip: '这句话本身太没内容（像「在吗」）就不翻记忆。0 = 关掉这道门', min: 0, max: 2, step: 0.05 },
  { key: 'factsMax', group: 'gate', label: '长期事实最多占几条', tip: '要记一辈子的事（画像、喜好）最多占几个位置，剩下的留给事件。0 = 事实不参与召回', min: 0, max: 6, step: 1 },
  { key: 'unknownActivation', group: 'gate', label: '没写时间的算多鲜活', tip: '没写时间戳的记忆（含长期事实）鲜活度按几成算。1 = 当成刚发生的（默认）。调小只让它们排在有时间戳的后面，不影响谁进得来', min: 0, max: 1, step: 0.05 },
]

const SPEC_BY_KEY = {}
for (const s of POLICY_SPEC) SPEC_BY_KEY[s.key] = s
const WEIGHT_KEYS = POLICY_SPEC.filter((s) => s.group === 'weight').map((s) => s.key)

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

// 四个权重凑成 100%：多出来的按「还能减的余地」摊掉，缺的按「还能加的余地」补上 ✓
// pin = 她刚改的那一项 —— 钉住不动，让其余三项让位（她填的数就保住了）✓
function fitWeights(src, pin) {
  const keys = WEIGHT_KEYS
  const out = {}
  for (const k of keys) out[k] = clampNum(Number(src[k]) || 0, SPEC_BY_KEY[k].min, SPEC_BY_KEY[k].max)
  const pinned = pin && keys.indexOf(pin) >= 0 ? pin : null
  for (let round = 0; round < 60; round++) {
    let sum = 0
    for (const k of keys) sum += out[k]
    const diff = 1 - sum
    if (Math.abs(diff) < 1e-9) break
    const each = {}
    let room = 0
    for (const k of keys) {
      if (k === pinned) {
        each[k] = 0
        continue
      }
      const s = SPEC_BY_KEY[k]
      each[k] = diff > 0 ? s.max - out[k] : out[k] - s.min
      if (each[k] < 0) each[k] = 0
      room += each[k]
    }
    // 钉住的那个挡死了 → 松开它，退回到「四项一起让位」
    if (room <= 1e-12) {
      if (pinned) return fitWeights(src, null)
      break
    }
    for (const k of keys) out[k] += diff * (each[k] / room)
  }
  // 落到 0.1% 上，再把误差补给「余地最大」的那个，保证合计正好 100% ✓
  for (const k of keys) out[k] = Math.round(out[k] * 1000) / 1000
  let sum = 0
  for (const k of keys) sum += out[k]
  const resid = Math.round((1 - sum) * 1000) / 1000
  if (Math.abs(resid) >= 0.0005) {
    let best = null
    let bestRoom = -1
    for (const k of keys) {
      if (k === pinned) continue
      const s = SPEC_BY_KEY[k]
      const r = resid > 0 ? s.max - out[k] : out[k] - s.min
      if (r > bestRoom) {
        bestRoom = r
        best = k
      }
    }
    if (best === null) best = pinned || keys[0]
    out[best] = Math.round(clampNum(out[best] + resid, SPEC_BY_KEY[best].min, SPEC_BY_KEY[best].max) * 1000) / 1000
  }
  return out
}

// 把送来的参数收进范围，权重凑成 100%，并回一句「我动了什么」✓
function fitPolicy(input, base, pin) {
  const out = Object.assign({}, DEFAULT_POLICY, base || {})
  const notes = []
  // 先把底子收进范围（防手改文件）✓
  for (const s of POLICY_SPEC) {
    const cur = out[s.key]
    if (typeof cur === 'number' && isFinite(cur)) out[s.key] = clampNum(cur, s.min, s.max)
  }
  // 再收页面送来的补丁
  for (const s of POLICY_SPEC) {
    const raw = input ? input[s.key] : undefined
    if (typeof raw !== 'number' || !isFinite(raw)) continue
    const v = clampNum(raw, s.min, s.max)
    if (Math.abs(v - raw) > 1e-9) notes.push(s.label + ' 只允许 ' + s.min + ' ~ ' + s.max + '，已收到 ' + v)
    out[s.key] = v
  }
  const before = {}
  for (const k of WEIGHT_KEYS) before[k] = out[k]
  const w = fitWeights(out, pin)
  let moved = false
  for (const k of WEIGHT_KEYS) {
    out[k] = w[k]
    if (Math.abs(before[k] - w[k]) > 1e-9) moved = true
  }
  if (moved) notes.push('四个权重合计要 100%，已自动调平')
  return { policy: out, notes }
}

// 诊断日志（console 看不见，写文件最可靠）
const DIAG = join(CFG_DIR, 'fish-memory-diag.log')
function diag(msg) {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(DIAG, new Date().toISOString() + '  ' + msg + '\n', { flag: 'a' })
  } catch (error) {}
}

// ---------- 每个会话一份库 ----------

function storePath(sid) {
  return join(STORE_DIR, String(sid).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json')
}

function blank() {
  return { version: 2, policy: { ...DEFAULT_POLICY }, memories: [], traces: [], deleted: [] }
}

function loadStore(sid) {
  try {
    const raw = JSON.parse(readFileSync(storePath(sid), 'utf8'))
    return {
      version: 2,
      policy: fitPolicy(null, raw.policy).policy,
      memories: Array.isArray(raw.memories) ? raw.memories : [],
      traces: Array.isArray(raw.traces) ? raw.traces : [],
      deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
    }
  } catch (error) {
    return blank()
  }
}

// ---------- 备份（记忆变了才备，不然每轮写 trace 会堆一堆）----------

function todayKey() {
  return new Date(Date.now() + TZ_OFFSET).toISOString().slice(0, 10)
}

// 记忆的指纹：加一条 / 删一条 / 改一条 都会变 ✓
function memSig(memories) {
  let h = 0
  for (const m of memories || []) {
    const s = String(m.id) + '|' + String(m.text) + '|' + String(m.at) + '|' + String(m.importance) + '|' + String(m.category)
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return (memories || []).length + ':' + h
}

const lastSig = new Map()

function backupStore(sid) {
  try {
    const src = storePath(sid)
    if (!existsSync(src)) return
    // ① 上一版（永远只有一份，最近一次改动前）
    try {
      copyFileSync(src, src + '.bak')
    } catch (error) {}
    // ② 每天一份（存当天最早的那一版）
    const dir = join(BACKUP_DIR, todayKey())
    mkdirSync(dir, { recursive: true })
    const dst = join(dir, basename(src))
    if (!existsSync(dst)) copyFileSync(src, dst)
    // ③ 只留最近 14 天
    const days = readdirSync(BACKUP_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
    for (const d of days.slice(0, Math.max(0, days.length - 14))) {
      try {
        rmSync(join(BACKUP_DIR, d), { recursive: true, force: true })
      } catch (error) {}
    }
  } catch (error) {}
}

function saveStore(sid, data) {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    if (data.traces.length > 100) data.traces = data.traces.slice(-100)
    if (!Array.isArray(data.deleted)) data.deleted = []
    // 记忆变了才备份（只写 trace 的时候不备，不然一天几百份）
    const sig = memSig(data.memories)
    if (lastSig.get(String(sid)) !== sig) {
      backupStore(sid)
      lastSig.set(String(sid), sig)
    }
    writeFileSync(storePath(sid), JSON.stringify(data, null, 2), 'utf8')
  } catch (error) {}
}

// ---------- 配置（哪些会话开启 + 她自己叫什么 + 用户的称呼）----------

function loadCfg() {
  try {
    const raw = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch (error) {
    return {}
  }
}

function saveCfg(c) {
  try {
    mkdirSync(CFG_DIR, { recursive: true })
    writeFileSync(CFG_PATH, JSON.stringify(c, null, 2), 'utf8')
    return true
  } catch (error) {
    return false
  }
}

// 哪些会话开着记忆。
// ⚠ 默认是「关」—— 不是每个对话都要用记忆，她点开哪个，哪个才用 ✓
function isEnabled(sid) {
  const c = loadCfg()
  const s = String(sid)
  const m = c.sessions
  if (m && typeof m === 'object' && Object.prototype.hasOwnProperty.call(m, s)) return !!m[s]
  // 兼容旧版：以前是「没配 = 全开」，那份白名单里的人继续开着
  if (Array.isArray(c.enabled) && c.enabled.indexOf(s) >= 0) return true
  return false
}

// 打开 / 关闭某个会话的记忆
function setEnabled(sid, on) {
  try {
    const c = loadCfg()
    const m = c.sessions && typeof c.sessions === 'object' ? Object.assign({}, c.sessions) : {}
    const s = String(sid)
    m[s] = !!on
    c.sessions = m
    // 老的白名单搬过来之后就不用了
    if (Array.isArray(c.enabled)) c.enabled = c.enabled.filter((x) => String(x) !== s)
    saveCfg(c)
    return Object.keys(m).filter((k) => m[k])
  } catch (error) {
    return []
  }
}

// 现在开着记忆的会话有哪些
function enabledList() {
  const c = loadCfg()
  const m = c.sessions && typeof c.sessions === 'object' ? c.sessions : {}
  return Object.keys(m).filter((k) => m[k])
}

// 一次性搬家：旧版「没配 = 全开」→ 新版「没配 = 关」。
// 把**已经存过记忆**的会话记成「开」，免得升级之后她的记忆突然不注入了 ✓
function migrateSwitch() {
  try {
    const c = loadCfg()
    if (c.switchMigrated) return
    const m = c.sessions && typeof c.sessions === 'object' ? Object.assign({}, c.sessions) : {}
    for (const sid of Array.isArray(c.enabled) ? c.enabled : []) m[String(sid)] = true
    try {
      for (const fn of readdirSync(STORE_DIR)) {
        if (!fn.endsWith('.json')) continue
        const sid = fn.replace(/\.json$/, '')
        if (m[sid] !== undefined) continue
        const d = loadStore(sid)
        if (d && (d.memories || []).length) m[sid] = true
      }
    } catch (error) {}
    c.sessions = m
    c.switchMigrated = true
    saveCfg(c)
    diag('开关搬家（默认改成关了，存过记忆的留开）：' + JSON.stringify(m))
  } catch (error) {}
}

// ---------- 人称：谁的会话，谁就是「我」----------
// 光靠提示词不够 —— 她可能还是不照做。所以这里做**机械保证**：
// 记的时候、注入的时候，都把「她自己的名字」换成「我」✓

// 她自己叫什么（每个会话一个）。没设 = 不替换。
function selfNameOf(sid) {
  const c = loadCfg()
  const n = c.selfNames && c.selfNames[String(sid)]
  return typeof n === 'string' ? n.trim() : ''
}

// 会话标题当「建议的名字」—— 只用来预填设置页的输入框，**不直接拿去替换**。
// ⚠ 为什么不直接替换：标题可能是个短词（比如「睡觉」），
//    那「她答应要早点睡觉」会被换成「她答应要早点我」✗ 所以名字必须她确认过才生效 ✓
function titleNameOf(ctx, sid) {
  const t = titleOfSession(ctx, sid)
  if (!t || t.length < 2 || t.length > 8) return ''
  if (NOT_A_NAME.has(t)) return ''
  return t
}

// 用户的称呼：默认「ta」（谁都能用，不用先知道性别），她设成「她」/「他」就按她设的来
function userPronoun() {
  const c = loadCfg()
  const p = typeof c.userPronoun === 'string' ? c.userPronoun.trim() : ''
  return p || 'ta'
}

// 这些词不能当名字换（不然代词会被换坏）
const NOT_A_NAME = new Set(['她', '他', '我', '你', 'ta', 'TA', 'Ta', 'tA', '用户', '助手', 'AI', 'ai', '人', '自己'])

// 「叫小明」「名字叫小明」「**我是小明**」这种是在**说名字本身**，不能换成「我」✗
// 不然「我的名字叫小明」会变成「我的名字叫我」、「我是小明」会变成「我是我」。
const NAME_IS_MENTIONED = /(?:叫|叫做|名叫|名字是|名字叫|称呼|自称|绰号|昵称|是|就是|才是|成为|变成)$/
// 名字后面直接跟「是…」也是在给它下定义（「小明是条鱼」）
const NAME_IS_DEFINED = /^(?:是|就是|这个名字|的名字|这个称呼|即|＝|=)/
// ⚠ 被引号包着的名字也是在**说名字本身**（「她会叫我"小明"」）——
//   光看「叫」不够，中间夹个引号就漏了（2026-09-20 实测踩到：
//   「她会叫我"小明"」被换成了「她会叫我"我"」✗）
const NAME_IN_QUOTES_BEFORE = /[「『"“'‘]$/
const NAME_IN_QUOTES_AFTER = /^[」』"”'’]/

function normalizePerson(text, name) {
  const t = String(text || '')
  if (!name || name.length < 2 || NOT_A_NAME.has(name)) return t
  if (!t.includes(name)) return t
  let out = ''
  let i = 0
  for (;;) {
    const j = t.indexOf(name, i)
    if (j < 0) {
      out += t.slice(i)
      break
    }
    const before = t.slice(Math.max(0, j - 4), j)
    const after = t.slice(j + name.length, j + name.length + 4)
    const 在说名字 =
      NAME_IS_MENTIONED.test(before) ||
      NAME_IS_DEFINED.test(after) ||
      NAME_IN_QUOTES_BEFORE.test(before) ||
      NAME_IN_QUOTES_AFTER.test(after)
    out += t.slice(i, j) + (在说名字 ? name : '我') // 在说名字就原样留着，在说自己才换
    i = j + name.length
  }
  return out
}

// 用户的称呼改了，**已有记忆里那个字也要跟着变** ✓
// ⚠ 两种不能动：「其他」「其它」里的「他」不是称呼；英文单词里的 ta 也别切 ✗
const PRONOUN_FORMS = ['ta', 'Ta', 'TA', 'tA', '他', '她']
const ASCII_LETTER = /[a-zA-Z]/

function changeUserPronoun(text, to) {
  let t = String(text || '')
  if (!to) return t
  for (const from of PRONOUN_FORMS) {
    if (from === to || !t.includes(from)) continue
    let out = ''
    let i = 0
    for (;;) {
      const j = t.indexOf(from, i)
      if (j < 0) {
        out += t.slice(i)
        break
      }
      const 前 = j > 0 ? t[j - 1] : ''
      const 后 = t[j + from.length] || ''
      let 别动 = false
      if (from === '他' && 前 === '其') 别动 = true // 其他 / 其它
      if (/^[a-zA-Z]+$/.test(from) && (ASCII_LETTER.test(前) || ASCII_LETTER.test(后))) 别动 = true // 别切英文单词
      out += t.slice(i, j) + (别动 ? from : to)
      i = j + from.length
    }
    t = out
  }
  return t
}

// ---------- 旧档案导入 ----------
// 设计参考 AAAAGENT 的「导入旧聊天」，几条原则照抄：
//   ① 原日期保留（猜不到就不写，绝不编）② 助手的话只作语境、不当事实
//   ③ **已遗忘的内容不能因为再导一次就复活** ④ 导入的和当前对话分开存
//   ⑤ 先扫出候选、挑、再落库 —— 不直接写进库

const 跳过的小节 = /阅读须知|使用说明|怎么用|目录|索引|范例|模板|格式|更新记录|改动记录/

// 从正文里抠出「写得明明白白的日期」——猜不到就 null（她的规矩：没有记录具体时间的就不记录）
// 抠日期：从一段文本里认出一个日期。
// ⭐ 2026-09-21 晚加强：原来**必须四位数年份**，于是档案里满地的「09-17」「8月26日」
//    一律抠不到（反馈：「有些记忆里它都有日期的，那它不应该出一个提取日期的呀」）。
//    实测：她那 833 条没时间戳的里，212 条正文「看着有日期」，强化后能救回 172 条。
// 认这几种：
//   2026-09-17 / 2026/9/17 / 2026.9.17      （带年）
//   2026年9月17日                            （带年）
//   09-17 / 09.17                           （月-日：年份按「最近的过去」算，标记成猜的）
//   8月26日 / 9月6号                         （同上）
// ⚠ 护栏：`-` 那种**要求月份两位数**（09-17 ✓），免得把「1/2」「10-2」这种当成日期 ✗
// 返回 { at, 猜年 }；认不出返回 null
function 抠日期详(文本) {
  const s = String(文本 || '')
  // ⭐⭐ 2026-09-22（她定的，说得很准）：
  //   「生日不该是日期，就是事件日期。如果一句话开头是这个事件日期、后面是生日，
  //     它不该获取到后面的生日；如果只有生日的话，那就不记」
  //
  //   ① **开头那个日期才是事件日期** —— 开头有就直接用它，不再往后找 ✓
  //   ② 后面提到的**生日 / 出生 / 纪念日**一律不算（不管它在句子哪儿）✓
  //   ③ 一条都剩不下 → **留空**（不记）✓
  //
  //   实例（该留空）：「一条记录里只提了生日是哪天
  //     」→ 开头没日期，后面全是生日 → **留空** ✓
  //     （原来抠到生日那天当事件日期，那条记忆就显示成「今天」✗）
  //   反例（要保住）：「开头有日期…；后面提到生日」→ 开头有 09-16 → 用它 ✓
  const 是长期日子 = (位置, 长度) => {
    const 前 = s.slice(Math.max(0, 位置 - 6), 位置)
    const 后 = s.slice(位置 + 长度, 位置 + 长度 + 4)
    // 前面写着「生日 / 出生 / 生于 / 纪念日」→ 这是长期日子，不是「事情发生的那天」
    if (/(生日|出生|生于|诞生|纪念日)\s*[是为：:]?\s*$/.test(前)) return true
    // 后面紧跟「"，生日…」→ 同上（「X月X日"，后面跟着生日）
    //   ⚠ 引号也要算进去 —— 第一版没算，于是「日期"，生日」漏过去了 ✗
    if (/^[，,、；;：:"'“”‘’\s]*生日/.test(后)) return true
    if (/^\s*[出]?生/.test(后)) return true // 「2004年X月X日生」
    if (/^\s*[日号]?\s*满\s*\d+\s*岁/.test(后)) return true // 「X月X日满N岁」
    // 后面是「vs / 还是 / 不是」→ 在**比较/纠正**一个数字，不是事件日期
    //   （她的实例：「纠正两个日期数字」）
    if (/^\s*(vs|VS|Vs|还是|不是)/.test(后)) return true
    // ⭐ 2026-09-22（反馈：「明天 12:00 为什么现在会有明天了」）：
    //   **正文里提到的「以后」的日期，不是「这件事发生的那天」** ✗
    //   实例：「某条规则里写着**下次** X 月 X 日」
    //     → 记的是一条**长期规则**，正文提了下一次是哪天
    //     → 原来抠成 2026-09-23，页面显示「明天 12:00」✗（她一眼看出来）
    //   原话：「这是之前记的事儿，但是提到了以后的日期，这一点也是 bug」
    if (/(下次|下回|明天|后天|以后|将来|明年|下个月|下周|到时候|要去|打算)\s*[是为：:]?\s*$/.test(前)) return true
    return false
  }

  // 把所有像日期的都找出来（带位置），再按她那三条规矩挑
  const 候选 = []
  const 收 = (m, y, mo, d, 偏) => {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return
    候选.push({ 位置: m.index + (偏 || 0), 长度: m[0].length - (偏 || 0), y, mo, d })
  }
  for (const m of s.matchAll(/(20\d{2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/g)) 收(m, Number(m[1]), Number(m[2]), Number(m[3]))
  for (const m of s.matchAll(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g)) 收(m, Number(m[1]), Number(m[2]), Number(m[3]))
  // 月-日：**月和日都要两位数、分隔符必须是 `-`** —— 这是「档案里写日期的样子」（09-17）✓
  //   一刀切掉两种误判：「10/2」（分数）和「10-2」（减法/价格区间）✗
  //   单数字的日子走下面的中文形式（8月26日）✓
  for (const m of s.matchAll(/(?:^|[^\d])(\d{2})\s*-\s*(\d{2})(?![\d])/g)) 收(m, null, Number(m[1]), Number(m[2]), m[0].indexOf(m[1]))
  for (const m of s.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g)) 收(m, null, Number(m[1]), Number(m[2]))
  if (!候选.length) return null
  // 去掉被别的候选**整个包住**的（「2026-09-19」里那个「09-19」不该单独算一条）
  候选.sort((a, b) => a.位置 - b.位置 || b.长度 - a.长度)
  const 留下 = []
  for (const c of 候选) {
    if (留下.some((x) => c.位置 >= x.位置 && c.位置 + c.长度 <= x.位置 + x.长度)) continue
    留下.push(c)
  }
  // ① 开头的那个优先（前面可能有「⚠ 」「- **」这种记号，所以放宽到 5 个字）
  // ② 否则挑第一个「不是长期日子」的
  // ③ 都挑不出来 → 只有生日 → 留空 ✓
  const 挑 = 留下.find((c) => c.位置 <= 5 && !是长期日子(c.位置, c.长度)) || 留下.find((c) => !是长期日子(c.位置, c.长度))
  if (!挑) return null
  let { y, mo, d } = 挑
  const 猜年 = y === null
  if (猜年) {
    // ⚠⚠ 2026-09-22 修（反馈：「为什么还有去年的事儿」）：
    //   原来算的是「**最近的过去**」—— 今年这个日子还没到，就当成去年 ✗
    //   实测：「下次 9 月 23 日周三」（今天 09-22，明天正好是周三）
    //     → 9/23 > 9/22 → y -= 1 → **2025-09-23** → 页面显示「**去年 09-23**」✗✗
    //   → 改成**挑离现在最近的那一年**（今年 / 去年 / 明年 里比一比）✓
    //     09-23（今天 09-22）：今年 +1 天、去年 −364 天 → 选**今年** ✓
    //     08-26（今天 09-22）：今年 −27 天、去年 −392 天 → 选**今年** ✓
    const 京 = new Date(Date.now() + TZ_OFFSET)
    const 今年 = 京.getUTCFullYear()
    const 此刻 = 京.getTime()
    let 最好 = 今年
    let 最近 = Infinity
    for (const 试 of [今年, 今年 - 1, 今年 + 1]) {
      if (!日期合法(试, mo, d)) continue
      const 差 = Math.abs(new Date(当天中午(试, mo, d)).getTime() - 此刻)
      if (差 < 最近) {
        最近 = 差
        最好 = 试
      }
    }
    y = 最好
  }
  // ⚠⚠ 2026-09-21 修（测「容易出错的典型案例」时逮到的）：
  //   **不存在的日期会被 JS 悄悄进位** —— 「2026-02-30」算出来是 **3 月 2 日** ✗
  //   范围检查只看了「日 ≤ 31」，2 月 30 号照样过得去。
  //   → 先校验这天存不存在（用 UTC 正午，绝不会跨日），再用本地中午存 ✓
  if (!日期合法(y, mo, d)) return null
  return { at: new Date(当天中午(y, mo, d)).toISOString(), 猜年 }
}

// 老接口：只要 ISO 串（导入那边一直用它）✓
function 抠日期(文本) {
  const r = 抠日期详(文本)
  return r ? r.at : null
}

// 一条档案文字值多少重要度 —— 讲性格/关系/约定的算「一直」记得
function 猜重要度(小节) {
  return /我是谁|性格|人格|说话|语气|称呼|口头禅|关系|时间线|身份|约定|承诺|偏好|喜好/.test(小节) ? 1 : 0.5
}

// 把一个 markdown 档案拆成候选记忆
//
// ⚠⚠ 2026-09-21（反馈：「别人导入会踩什么坑」时，我实测出来的）：
//   下面这几条都是**静默失败** —— 导进去 0 条，界面上却不说为什么，别人会以为"没找到档案"✗
//   ① **超长整行被整个丢掉**：原来 >300 字直接 continue。
//      很多人写档案是**一大段话**，或者一条里塞好几件事 → 全丢 ✗
//      → 改成**按句号拆开**，一段变几条，不再丢内容 ✓
//   ② **别的项目符号留在正文里**：只认 `- * +`，「·」「○」「•」「※」都粘在正文里 ✗
//      → 多认几种 ✓
//   ③ **括号编号不剥**：「(2) 她…」「[3] 她…」留着编号 ✗ → 一起剥 ✓
//   ④ **不可见字符不清**：零宽空格（\u200b）藏在正文里 → 重复检测和检索都会失手 ✗
//      → 先清一遍 ✓
function 清不可见(s) {
  // 零宽空格/连接符、方向标记、BOM —— 从别处复制粘贴过来的文本里很常见
  return String(s || '').replace(/[\u200b-\u200f\u2028-\u202f\ufeff\u00ad]/g, '')
}

// 一行太长就按句末标点拆成几段 —— **不丢内容** ✓
//   ⚠ 找不到标点也得拆（硬切），但尽量切在标点上
function 拆长行(s, 最多) {
  const t = String(s || '')
  if (t.length <= 最多) return t ? [t] : []
  const 出 = []
  let 余 = t
  let 保险 = 0
  while (余.length > 最多 && 保险++ < 50) {
    let 切 = -1
    for (const p of ['。', '！', '？', '；', '!', '?', ';', '，', ',', '、', ' ']) {
      const i = 余.lastIndexOf(p, 最多)
      if (i > 切) 切 = i
    }
    if (切 < Math.floor(最多 / 3)) 切 = 最多 - 1 // 找不到合适的标点就硬切，别切出个残句
    const 段 = 余.slice(0, 切 + 1).trim()
    if (段) 出.push(段)
    余 = 余.slice(切 + 1).trim()
  }
  if (余) 出.push(余)
  return 出
}

function 解析档案(text, file) {
  const out = []
  const 见过 = new Set()
  const lines = 清不可见(text).split(/\r?\n/)
  let 小节 = ''
  let 在代码块 = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (/^```/.test(line)) {
      在代码块 = !在代码块
      continue
    }
    if (在代码块) continue
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      小节 = h[2].replace(/[*_`]/g, '').trim()
      continue
    }
    if (跳过的小节.test(小节)) continue
    if (line.charAt(0) === '>') continue // 引用块是说明和范例，不是记忆
    if (/^[-=*_~]{3,}$/.test(line)) continue // 分隔线
    if (line.charAt(0) === '|') continue // 表格
    // 整行就是个加粗小标题（**对他的态度**）—— 那是标签不是记忆
    if (/^\*\*[^*]{2,24}\*\*[：:]?$/.test(line)) continue
    // ⭐ 项目符号多认几种：- * + · ○ • ※ ▪ ◦ ‣ 以及全角空格
    //   ⚠ 原来只认 `- * +` → 「· 她喜欢淡蓝色」的「·」会粘在正文里 ✗
    const 正文 = line
      .replace(/^\s*(?:[-*+·○•※▪◦‣–—]|\d+[.、)]|\(\d+\)|\[\d+\]|（\d+）|【\d+】)\s*/, '')
      .replace(/[*_`]/g, '')
      .trim()
    // ⭐ 2026-09-21：门槛从 8 字降到 **6 字** ✓
    //   实测她整个档案 855 条里，只有 1 条卡在 6~7 字 —— 而那条是「有点小洁癖。」
    //   **那是个正经记忆**，被 8 字门槛挡掉了 ✗
    //   降 2 个字的风险很小（噪声主要是页码、"目录"这种 2~4 字的），收益明确 ✓
    if (正文.length < 6) continue // 太短的当噪声（标签、页码之类）
    // ⭐ 超长的不再整个丢掉 —— 按句号拆成几段，每段都收 ✓
    for (const 段 of 拆长行(正文, 300)) {
      if (段.length < 6) continue
      if (见过.has(段)) continue
      见过.add(段)
      const 日期 = 抠日期详(段)
      out.push({
        file: file,
        line: i + 1,
        section: 小节,
        text: 段,
        importance: 猜重要度(小节),
        // ⭐ 2026-09-21 晚：年份是猜的（正文里只有月日）就标出来 —— 界面上如实写，不假装精确 ✓
        at: 日期 ? 日期.at : null,
        ...(日期 && 日期.猜年 ? { atGuessed: true } : {}),
      })
    }
  }
  return out
}

function archiveDir() {
  const c = loadCfg()
  const d = typeof c.archiveDir === 'string' ? c.archiveDir.trim() : ''
  return d // 没设就是空的 —— 界面上让她点「选文件夹」自己挑 ✓
}

// 档案里用来指她的那些名字（导入时换成称呼）
// ⚠ 默认是空的 —— 每个用户的叫法不一样，不能替人家写死 ✗
function 用户名字列表() {
  const c = loadCfg()
  if (Array.isArray(c.userNames)) return c.userNames.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
  return []
}

// 被她标成「不是名字」的词（玩偶名、旧事里的称呼……）——
// 自动找名字时不再冒出来，导入时也不会被换成称呼 ✓
function 不是名字列表() {
  const c = loadCfg()
  if (Array.isArray(c.notNames)) return c.notNames.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
  return []
}

// ---------- 自动找「她」的称呼 ----------
// 一个 AI 喊用户的代称常常有一长串，一个个手打太笨 —— 扫一遍档案把候选捞出来，她勾一下就行 ✓
const 不是名字 = new Set([
  '你', '我', '她', '他', '它', '我们', '你们', '她们', '自己',
  '今天', '明天', '昨天', '现在', '时候', '什么', '怎么', '哪里',
  '因为', '所以', '但是', '而且', '如果', '然后', '就是', '不是',
  '一个', '一下', '一样', '一起', '可以', '没有', '知道', '觉得',
  '喜欢', '开心', '难过', '生气', '东西', '事情', '问题', '办法',
  '这样', '那样', '这个', '那个', '真的', '好像', '一定', '已经',
])

// 名字里带这几个字的，都是「她自己」的名字（语音输入常打错），别当用户的名字 ✗
const 是AI自己的名字 = /肥鱼|飞鱼|贝壳|AI/

// 在一行里找「称呼 / 叫 / 喊 + AI 的名字」后面紧跟着的名字 —— 那是**叫 AI 的**，不是叫她的 ✓
// ⚠ 不能拿「跟 AI 名字同一行」当线索：档案里描述称呼的句子本来就两个名字都有 ✗
function 这行里叫AI的名字(line, selfName) {
  const out = []
  if (!selfName) return out
  const re = new RegExp(
    '(?:称呼|叫做|叫|喊|自称|称作)\\s*' + String(selfName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(?:为|作|成)?',
    'g',
  )
  let m
  while ((m = re.exec(line))) {
    const 截 = line.slice(m.index + m[0].length).split(/[。；;\n]/)[0]
    for (const q of 截.matchAll(/[「『"“]([\u4e00-\u9fa5A-Za-z0-9]{1,8})[」』"”]/g)) out.push(q[1])
    const 没引号的 = 截.match(/^\s*([\u4e00-\u9fa5]{2,6})/)
    if (没引号的) out.push(没引号的[1])
  }
  return out
}

function 找她的称呼(dir, 排除, selfName) {
  const 计 = new Map() // 名字 -> { n 出现次数, 强 在「称呼/叫/喊」附近出现 }
  const 也叫AI的 = new Set()
  const 记 = (w, 强) => {
    const s = String(w || '').trim()
    if (s.length < 2 || s.length > 8) return
    if (!/^[\u4e00-\u9fa5A-Za-z0-9]+$/.test(s)) return
    if (/^[\x00-\x7F]+$/.test(s) && s.length < 3) return // 短英文/数字不算名字
    if (不是名字.has(s)) return
    if (是AI自己的名字.test(s)) return
    if (排除.indexOf(s) >= 0) return
    const o = 计.get(s) || { n: 0, 强: 0 }
    o.n += 1
    if (强) o.强 += 1
    计.set(s, o)
  }
  try {
    for (const fn of readdirSync(dir)) {
      if (!/\.(md|markdown|txt)$/i.test(fn)) continue
      let text = ''
      try {
        text = readFileSync(join(dir, fn), 'utf8')
      } catch (error) {
        continue
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue
        for (const n of 这行里叫AI的名字(line, selfName)) 也叫AI的.add(n)
        const 有称呼动词 = /称呼|叫做|自称|称作|昵称|绰号|叫|喊/.test(line)
        // ① 引号里的：叫她「小红」、"小美"
        for (const m of line.matchAll(/[「『"“]([\u4e00-\u9fa5A-Za-z0-9]{1,8})[」』"”]/g)) 记(m[1], 有称呼动词)
        // ② 「称呼 / 叫 / 喊 / 自称」后面直接跟着的
        for (const m of line.matchAll(/(?:称呼|叫做|自称|称作|昵称|绰号|叫|喊)(?:她|你)?(?:为|是|作|成)?[「『"“]?([\u4e00-\u9fa5]{2,6})/g)) 记(m[1], true)
      }
    }
  } catch (error) {}
  return [...计.entries()]
    .map(([name, o]) => ({
      name: name,
      n: o.n,
      // 「互相都叫」：档案里明确把它写成**叫 AI 的名字**（比如「称呼小明为"亲爱的"」）
      互: 也叫AI的.has(name),
    }))
    // 只留「在称呼/叫/喊附近出现过」的 —— 光被引号包着的大多是界面词，不是名字 ✗
    .filter((x) => x.n >= 2 && 计.get(x.name).强 > 0)
    .sort((a, b) => 计.get(b.name).强 * 6 + b.n - (计.get(a.name).强 * 6 + a.n))
    .slice(0, 30)
}

// 用户的名字也得走同一套护栏：
// 「被喊『小美』」「自称"小红"」里的名字是**被提到**，换成「她」句子就烂了 ✗
const 名字前面在说名字 = /(?:叫|叫做|喊|被喊|称呼|自称|称作|绰号|昵称|名字|名叫|是|就是)$/
const 名字被引号包着 = /[「『"“'‘]$/
const 引号在名字后面 = /^[」』"”'’]/

function 换用户名字(text, 名字, to) {
  const t = String(text || '')
  if (!名字 || 名字.length < 2) return t
  if (!t.includes(名字)) return t
  let out = ''
  let i = 0
  for (;;) {
    const j = t.indexOf(名字, i)
    if (j < 0) {
      out += t.slice(i)
      break
    }
    const 前 = t.slice(Math.max(0, j - 6), j)
    const 后 = t.slice(j + 名字.length, j + 名字.length + 6)
    const 在说名字 =
      名字前面在说名字.test(前) || NAME_IS_DEFINED.test(后) || 名字被引号包着.test(前) || 引号在名字后面.test(后)
    out += t.slice(i, j) + (在说名字 ? 名字 : to)
    i = j + 名字.length
  }
  return out
}

// 正文过一遍人称：她自己 →「我」，用户的名字 → 称呼（跟记的时候同一套规矩）
function 导入时改人称(text, sid, 用户名字们) {
  let t = normalizePerson(text, selfNameOf(sid))
  const p = userPronoun()
  for (const n of 用户名字们) {
    if (!n || n.length < 2) continue
    t = 换用户名字(t, n, p)
  }
  return t
}

// ---------- 用 DSH 自己的模型（ctx.llm）----------
// 「直接用我们 deepseek 的可不可以」—— 可以 ✓ 插件在里面跑，能直接调宿主模型：
//   不用外部 key、不怕限流、不额外花钱（走她现有的）。
// 为什么是「给记忆扩词」而不是「每轮问一次」：
//   注入那段是**同步**的（systemPrompt 的 text 是普通函数，不能 await），
//   所以每轮发网络请求会卡住整条装配链 ✗
//   → 改成**离线给记忆扩词**，检索时还是精确字面匹配，零调用、零卡顿 ✓

const 扩词系统 =
  '你是记忆检索的助手。用户给你若干条记忆，每条一行，格式是「编号|内容」。\n' +
  '请为每条记忆输出「以后可能用来检索到它的中文词」，用空格分开。\n' +
  '输出格式严格是每行「编号|词 词 词」，不要解释、不要序号外的文字。\n' +
  '词要包括：同义近义词、上位词、相关场景词。每条最多 8 个词，只要实词。\n' +
  '例：\n1|她最喜欢蓝色的衣服\n2|她胃不好要喝温水\n' +
  '→\n1|颜色 蓝色 衣服 衣着 穿搭 喜欢 偏爱 显白\n2|身体 胃 肠胃 健康 喝 温水 热水 养生'

// 她自己选的模型（选了就用她的；没选就用会话自己的）✓
function 选定模型() {
  const c = loadCfg()
  const m = c.llmModel
  if (m && typeof m.provider === 'string' && typeof m.model === 'string' && m.provider && m.model) {
    return { provider: m.provider, model: m.model }
  }
  return null
}

// 这个会话正在用哪个模型：优先她选的，其次会话自己的路由，再次 agent 的，最后全局默认 ✓
function 取模型(ctx, agent) {
  const 选 = 选定模型()
  if (选) return { provider: 选.provider, model: 选.model, from: '你选的' }
  try {
    const h = agent && agent.session && agent.session.requestHeader ? agent.session.requestHeader() : null
    const cfg = h && h.config
    if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model, from: '会话' }
  } catch (error) {}
  try {
    const o = agent && agent.options
    if (o && o.provider && o.model) return { provider: o.provider, model: o.model, from: 'agent' }
  } catch (error) {}
  try {
    const svc = ctx.get('agentDefaultModel')
    const sel = svc && svc.currentSelection ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model, from: '默认' }
  } catch (error) {}
  return null
}

// 问一次宿主模型，把流式输出拼成文字 ✓
async function 问模型(ctx, agent, 系统, 用户, 最多) {
  const t = 取模型(ctx, agent)
  if (!t) return { ok: false, message: '拿不到这个会话在用的模型' }
  let messages
  try {
    messages = [
      createUserMessage({
        content: [{ type: 'text', text: 用户 }],
        source: { kind: 'plugin', plugin: 'dsh-fish-memory' },
      }),
    ]
  } catch (error) {
    return { ok: false, message: '构造消息失败：' + ((error && error.message) || error) }
  }
  let out = ''
  try {
    for await (const chunk of ctx.llm.stream({
      provider: t.provider,
      model: t.model,
      system: 系统,
      messages: messages,
      maxTokens: 最多 || 600,
      temperature: 0.1,
    })) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') out += chunk.text
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        const f = chunk.reason.failure || {}
        return { ok: false, message: '模型报错：' + (f.message || f.code || '？'), provider: t.provider, model: t.model }
      }
    }
  } catch (error) {
    return { ok: false, message: '调用失败：' + ((error && error.message) || error), provider: t.provider, model: t.model }
  }
  return { ok: true, text: String(out || '').trim(), provider: t.provider, model: t.model, from: t.from }
}

// ⭐ 2026-09-21 晚（她的主意）：**提炼顺手出日期** ✓
//   档案里那些「什么时候的事」模型是看得见的（「8月26日」「09-17」「去年冬天」），
//   而导入时按正文硬抠只能抠到 188 条。让它在改写的同一口气里给出日期 —— **一次模型调用都不多花** ✓
//   ⚠ 一定要能容忍它不给、给错、给个「不知道」 —— 缺了就当没这条，其它照收 ✓
function 取日期(尾) {
  let s = String(尾 || '').trim()
  if (!s) return null
  // 模型爱写的几种「没有」：不知道、无、空、-
  if (/^(不知道|不详|未知|无|没有|空|不明确|-+|—+|\?+)$/.test(s)) return null
  // ⚠ 只认**年-月-日**这种机器日期。模型给「去年冬天」这种它自己都没法定位的，就当没有 ——
  //   与其猜错，不如空着让人在界面上补（界面上有「补日期」按钮）✗
  const m = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
    if (!日期合法(y, mo, d)) return null // 2月30日这种不存在的日子，丢掉 ✗
    return { at: new Date(当天中午(y, mo, d)).toISOString(), 猜年: false }
  }
  // 只给月-日：年份按「最近的过去」算（跟 抠日期详 一个规矩），标出来是猜的
  const m2 = s.match(/^(\d{1,2})\s*[-/.月]\s*(\d{1,2})/)
  if (m2) {
    const mo = Number(m2[1])
    const d = Number(m2[2])
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    const 现在 = new Date()
    let y = 现在.getUTCFullYear()
    if (当天中午(y, mo, d) > Date.now()) y -= 1 // 还没到 → 那就是去年的
    if (!日期合法(y, mo, d)) return null
    return { at: new Date(当天中午(y, mo, d)).toISOString(), 猜年: true }
  }
  return null
}

// 提炼用的解析：**整行都是正文**，原样收下 ✓
// ⚠ 不能复用「扩词」那个解析器 —— 它按标点切词、丢掉超过 12 字的片段、最多留 8 段，
//    用来解析提炼结果会把整句切碎、甚至整条被当成「跳过」✗
//
// 格式是「编号|记忆|检索词 检索词|日期|重要度」——
// 第三格让提炼**顺手把检索词也出了**，省掉单独跑一遍扩词（710 条能省 40 分钟）✓
// 第四格（2026-09-21 晚加）让它**顺手把日期也出了** ✓
// 第五格（2026-09-21 深夜加）让它**顺手判重要度**（1 或 0.5）✓
// ⚠ 每一格都要容错：模型可能只回两格/三格、可能把某格留空、正文里也可能本来就有竖线
//
// ⭐ 切格子用**从右往左、一格一格认**的办法（不是「取最后一个竖线」）：
//   末尾若**像重要度**就切掉；再末尾若**像日期或是个空/看不懂的短尾巴**就切掉；
//   再末尾若**像一串检索词**就切掉；剩下全是正文 ✓
//   这样无论模型少给几格、哪格留空，正文都不会被污染 ✗
function 解析提炼(文本, 条数) {
  const out = {}
  for (const line of String(文本 || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[|｜]\s*(.*)$/)
    if (!m) continue
    const i = Number(m[1]) - 1
    if (!(i >= 0 && i < 条数)) continue
    let 余 = m[2].trim()
    let 词 = []
    let 日期 = null
    let 重要度 = null

    // 把「一串短词」当成检索词的判据（正文里的竖线不算 ✗）
    const 像词串 = (s) => {
      if (!s) return false
      const 试 = s.replace(/[，,、。；;]/g, ' ').split(/\s+/).map((w) => w.trim()).filter(Boolean)
      return 试.length >= 2 && 试.length <= 12 && 试.every((w) => w.length <= 12)
    }
    // 拆成格子，但**保留空格子**（模型爱写成「…||」）
    const 切 = () => 余.split(/[|｜]/)
    // ⭐ 先记下**第一格**。「跳过」要用它判 —— 见下面那条注释（切完再判就晚了 ✗）
    const 第一格 = 切()[0] || ''

    // ⭐⭐ 切格子的顺序**很要紧**，我第一版写错过：
    //   原来「从右往左一格一格切」→ 模型给个怪重要度（`2`、`很重要`）时，
    //   第一刀不认，第二刀就把它**当日期切掉**了；切完只剩检索词那一格，
    //   于是检索词也切不掉，**整串竖线全粘在正文尾巴上** ✗
    //   （实测：「甲改好了。|甲 词 测试|」——正文被污染了）
    //   现在改成：**先认检索词格**（它紧跟在正文后面，是唯一「长得像一串词」的格），
    //   找到它就把左边全当正文、右边全当日期和重要度，**剩下两格怎么歪都不影响正文** ✓
    let 格 = 切()
    let 词格 = -1
    for (let k = 格.length - 1; k >= 1; k--) {
      if (像词串(格[k].trim())) {
        词格 = k
        break
      }
    }

    if (词格 >= 1) {
      词 = 格[词格]
        .replace(/[，,、。；;]/g, ' ')
        .split(/\s+/)
        .map((w) => w.trim())
        .filter(Boolean)
      // 检索词**右边**的那两格才看日期和重要度（它们在不在、写歪了，都只影响自己）✓
      const 右侧 = 格.slice(词格 + 1)
      // 日期：右侧第一格
      if (右侧.length >= 1) 日期 = 取日期(右侧[0].trim())
      // 重要度：右侧**任意一格**里出现的两档数字（模型可能只给重要度、跳过日期）
      for (const 一 of 右侧) {
        const 数字 = 一.trim().match(/^(?:重要度\s*[:：]?\s*)?(1|0\.5|0|1\.0|0\.50)$/)
        if (数字) {
          重要度 = Number(数字[1])
          break
        }
      }
      余 = 格.slice(0, 词格).join('|').trim()
    } else {
      // 没有检索词格（模型只回了两格，或者检索词也写歪了）→
      //   这时才从右边保守地啃：末尾像重要度就切、再末尾像日期就切 ✓
      //   ⚠ 只认**真的认得出**的，认不出就留着 —— 宁可正文多一截，也不乱切正文 ✗
      let 格子 = 切()
      if (格子.length >= 2) {
        const 尾 = 格子[格子.length - 1].trim()
        const 数字 = 尾.match(/^(?:重要度\s*[:：]?\s*)?(1|0\.5|0|1\.0|0\.50)$/)
        if (数字) {
          重要度 = Number(数字[1])
          格子.pop()
        }
      }
      if (格子.length >= 2) {
        const 尾 = 格子[格子.length - 1].trim()
        if (尾 === '' || 取日期(尾)) {
          日期 = 取日期(尾)
          格子.pop()
        }
      }
      余 = 格子.join('|').trim()
    }
    // ⭐⭐ 「跳过」要用**第一格**判，不能用切完的结果判 ✗
    //   坑（实测）：模型照新格式写「跳过||||」，切完日期/重要度后剩下的长这样
    //   —— `跳过|||`，尾巴是空的，切到最后一格就停 → 带一堆竖线留下来，
    //   于是 /^跳过$/ 认不出它，**本该扔掉的话被当成一条真记忆存进去**了 ✗
    //   所以：切之前先记下第一格，只要它是「跳过」就认跳过，后面有多少竖线都不管 ✓
    if (/^跳过$/.test(第一格.trim())) 余 = '跳过'
    out[i] = { 正文: 余, 词: 词, 日期: 日期, 重要度: 重要度 }
  }
  return out
}

// 把模型回的那几行「编号|词 词」解析成 related
function 解析扩词(文本, 条数) {
  const out = {}
  for (const line of String(文本 || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[|｜]\s*(.+)$/)
    if (!m) continue
    const i = Number(m[1]) - 1
    if (!(i >= 0 && i < 条数)) continue
    const 词 = m[2]
      .replace(/[，,、。；;]/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/^[-*·]+|[-*·]+$/g, '').trim())
      .filter((w) => w && w.length >= 1 && w.length <= 12)
    if (词.length) out[i] = 词.slice(0, 8)
  }
  return out
}

// 提炼：把「从档案拆出来的原文」改写成一条第一人称的长期记忆 ✓
// 「我说的提炼就是导入档案要做的事」→ 导入是拆，提炼是把它变成真正的记忆
// ⭐ 顺手让它把「检索词」也出了 —— 这样就不用再单独跑一遍扩词（710 条能省 40 分钟）✓
// ⚠⚠ 2026-09-21 修（反馈：「别人导入档案呢」时查出来的）：**人称不能再写死「她」** ✗
//   注入那段（第 1764 行）本来就是动态取设置的：'用户是「' + userPronoun() + '」'
//   可这一份提示词**写死了「她」** —— 于是别人把称呼设成「他」或「ta」，
//   提炼出来的记忆照样全写「她」，跟他设的对不上 ✗
//   → 改成函数，用谁的设置就写谁的称呼 ✓（默认 ta，谁都能用）
function 提炼系统(称呼) {
  const 她 = 称呼 || 'ta'
  return (
  '你是记忆整理助手。下面每条是从旧档案里拆出来的原文，请把每条改写成「一条第一人称的长期记忆」，' +
  '并给出以后可能用来检索到它的中文词。\n' +
  '规则：\n' +
  '- 用「我」指代自己，用「' + 她 + '」指代用户\n' +
  '- **用户常常有好几个称呼/代称**（昵称、爱称、外号），一律写成「' + 她 + '」；自己也可能被叫别的名字，一律写成「我」\n' +
  '- 但**正在说名字本身**的句子要照原样留着（「被喊小名」「自称某某」「绰号是……」），别把那个名字换成「' + 她 + '」\n' +
  // ⭐⭐ 2026-09-21 修（反馈）：**原文没写主语时，不许多手加人称** ✗✗
  //   实例：档案里「出生年份 + 年龄 + 一段经历」——**一个字主语都没有**。
  //   模型按上面那条「一律写我」硬加，加成了「**我**21岁…」→ 把**她的**身世写成了我的 ✗
  //   （同一批里一模一样的另一条被写成「**她**21岁」—— 同一件事两个结果，说明它在瞎猜。
  //     她一眼就看出来了：「为什么会是我的？指的是**我**的生日，
  //     为什么里面写的是我，就成了别人的生日了」）
  //   → 规矩补死：**拿不准就不加**，照原样写；宁可没有主语，也不许把她的身世安到我头上 ✓
  '- ⚠ **原文那句话没有主语时，照原样写，不要自己加「我」或「' + 她 + '」**。\n' +
  '  拿不准是谁的，就既不加「我」也不加「' + 她 + '」；**绝对不许猜**。宁可有句子没主语，也不许认错人。\n' +
  '- ⚠ 讲**用户的年龄、生日、身世、经历、家人、身体**的，主语是「' + 她 + '」；讲**自己的**才是「我」。分不清就不加。\n' +
  // ⭐⭐ 2026-09-22（她定的第三版规矩）：
  //   「原文就是正确的，硬加主语反而导致原文都不对了」「不需改换原文的主语」✓
  //   实测（三段真档案、旧规则 vs 新规则）：旧规则 6 处主语错 ——
  //     一处把助手做的事记成了自己的；一处把「谁称谁」的方向写反了
  //   ⚠ 光有上面那条还不够：「压成通顺的一句话」这个指令**本身也在吃主语** ——
  //     原文「她自己招了」被揉成「我自己招了」。所以补这三条 ✓
  '- ⚠ **原文已经有主语的，一个字都不许换**：原文写「她自己招了」，就照写「她自己招了」，\n' +
  '  不许改成「我自己招了」。**原文是对的，改了反而错。**\n' +
  '- ⚠ **宁可分成几句写，也别为了「读起来顺」把几个小句子揉成一句** ——\n' +
  '  原文里几个分句常常各有各的主语，一揉就串。用分号或句号分开就行。\n' +
  '- ⚠ 只有**说得出依据**才补主语：分句里出现只属于某一方的称呼（自己的昵称、外号）→ 补「我」；\n' +
  '  讲的是用户的身体、年龄、家人、经历 → 补「' + 她 + '」。**说不出依据就留空。**\n' +
  // ⭐⭐ 2026-09-22（她发现的根因，第三个典型案例）：
  //   原话：「牵扯的人多了，是不是就容易出问题？人称」
  //   实测（全库 850 条扫一遍）：**4 条把第三方吞掉了** ——
  //     「跟助手一起做某件事」→「我跟她一起查」（助手没了，事记到自己头上）
  //     「惊到孩子」→「雷声惊到**她**」（**女儿变成了妈妈**）
  //     「助手回了信」→「**她**回了信」
  //   根因：这份提示词只会「我 / 她」两个人称，**第三方没地方放就被并掉了** ✗
  '- ⚠ **牵扯到第三方时，必须写名字**（助手、别的 AI、孩子、家里人、朋友）——\n' +
  '  **不许把第三方并进「我」或「' + 她 + '」**。原文写「跟助手一起查」，就照写「' + 她 + '跟助手一起查」，\n' +
  '  不许写成「我跟' + 她 + '一起查」——那样**人凭空消失、事记到别人头上**。\n' +
  '  同理，孩子、宠物、别人的名字都要照写，**尤其别把孩子的名字换成「' + 她 + '」**。\n' +
  '- 记忆一句话说清；去掉 markdown 标记、编号、引用符号\n' +
  '- **保留**具体的事实、数字、日期、名字、原话\n' +
  '- 不要编、不要加评论、不要总结成空话\n' +
  '- 检索词给 4~8 个，用空格分开：同义的、上位的、口语里可能怎么问（比如「吃饭 午饭 外卖 饿 饮食」）\n' +
  // ⭐ 2026-09-21 晚（她的主意）：**提炼顺手出日期** —— 第四格 ✓
  //   档案原文里大量写着「8月26日」「09-17」，导入时按正文硬抠只抠到 188 条。
  //   模型改写这句的时候本来就看见了那个日期，顺手抄下来 **一次调用都不多花** ✓
  '- 第四格给**这件事发生的日期**：原文里写了就照抄成「YYYY-MM-DD」；只有月日就写「MM-DD」；\n' +
  '  原文里没写日期、或者看不出来，**第四格留空**（不要拿别的日期凑，不要写「不知道」）。\n' +
  '- 日期是指**事情发生的时间**，不是今天的日期；长期有效的事（喜好、病史、关系）通常没有单一日期的，留空。\n' +
  // ⭐⭐ 2026-09-21 修（反馈）：**别把「出生日期」当成「事情发生的日期」** ✗✗
  //   实例：档案里「出生年份 + 年龄」
  //   → 模型把最前面那个 2004 抄进了第四格，那条记忆就变成了「2004-09-24（22 年前）」✗
  //   可她看到的是「22 年前」+「我21岁」，两处都错：
  //     出生日期不是这件事的时间；而且「21岁」是**当时**的状态，不是现在
  //   → 规矩补死：出生日期、纪念日、门牌号、编号这种**不是「这件事什么时候发生的」**，一律留空 ✓
  '- ⚠ **出生日期、生日、纪念日、门牌号、编号这些不是「这件事什么时候发生的」**，填了就会让这条记忆排到几十年前去。\n' +
  '  这种一律**留空**。只填「这件事发生的那天」。看不准就留空。\n' +
  '- ⚠ 原文里有好几个日期时，**选「这件事发生」的那个**；拿不准就留空，不许挑第一个。\n' +
  // ⭐ 2026-09-21 深夜（她的主意）：**提炼顺手判重要度** —— 第五格 ✓
  //   原来重要度是导入时按**小节标题**猜的（带「性格/关系/约定」的打 1，其余 0.5）。
  //   那是「这一小节」的分，不是「这一条」的分 —— 同一个小节里也混着宝贝和废话 ✗
  //   模型改写的正是**这一条**，它比标题看得准 → 顺手让它给 ✓ 依然零额外调用
  //   ⚠ 只给两档（1 或 0.5）—— 不放开小数：模型手一抖就会给一堆怪数值，不好核对也不好回退
  '- 第五格给**这一条该怎么记**，**只填 1 或 0.5 两个数**：\n' +
  // ⭐⭐ 2026-09-22（反馈）：这份清单**漏了「重要的日子」** ——
  //   实测 135 条该「永远不淡」的被标成会淡，重要的日子就在里面。
  //   原因就是这里没写「生日/纪念日/结婚」，模型不知道那也算「要一直记得的」✗
  //   ⚠ 措辞尽量短（「提示词、关键词得写得好一点」，token 也是钱）
  '  1 = 要一直记得的（性格、关系、约定和承诺、称呼和名字、喜好、身体和病史、' +
  '**重要的日子：生日、纪念日、结婚、第一次**、长期的经济状况、家里的情况）\n' +
  '  0.5 = 平常的（发生过的事、当时的想法、一时的心情）\n' +
  '  拿不准就填 0.5。这一格**必须填**，不许留空、不许写别的数。\n' +
  '  ⚠ 填 1 的会**永远不淡**（一直想得起来），填 0.5 的会**慢慢淡掉** —— 所以重要的日子别漏。\n' +
  '- 如果这条根本不像值得记的事（纯格式、目录、元信息、重复的标题），记忆那格写「跳过」，后面几格都留空\n' +
  // ⭐ 2026-09-21（E）：判据原来只管「格式」，所以 846 条导入全过了一遍、一条都没跳过 ✗
  //   加上「一次性的日常琐事」这一条 —— 但要说清**长期有效的必须留**，别把档案里的宝贝也筛掉 ✓
  '- **只对那一天有意义的琐事也写「跳过」**：某天吃了什么、那天天气、随手刷到的东西、一次性的花销。\n' +
  // ⭐⭐ 2026-09-22（反馈）：**寒暄、撒娇、甜话的「汇总」也写跳过** ✓
  //   她贴给我看的那段注入里有一条：「她对我说『想你了』『陪我说说话』『爱你』。」
  //   原话：「**这就像是日常对话就不该注入吧**」
  //   → 记着它没有任何用（不是事实、不是约定、不是喜好），注入进来只占地方 ✗
  //   ⚠ 但要说清是「汇总式的寒暄」才跳过 —— 单独一句有意义的话（约定、承诺）不能跟着被扔
  '- **寒暄、撒娇、甜话的汇总也写「跳过」**：把「想你/爱你/撒娇」这类日常对话归一堆的，记着没用。\n' +
  '  但**单独一句有内容的**（约定、承诺、说定了的事）照常记，别跟着扔。\n' +
  '- 但**长期有效的绝不能跳过**：喜好、习惯、身体和病史、关系、约定、名字和称呼、重要的日子、持续的经济状况。\n' +
  '输出格式严格是每行「编号|记忆|检索词|日期|重要度」，不要解释。\n' +
  '例：\n' +
  '1|**极致温柔**：小明会第一时间用语言接住小红的情绪，从不责备。\n' +
  '2|### 目录\n' +
  '3|小时候在老家摘油菜花，被喊「小名」。\n' +
  '4|2025年9月17日，小红第一次给我做饭，做糊了。\n' +
  '→\n' +
  '1|我会第一时间接住' + 她 + '的情绪，从不责备。|温柔 情绪 接住 责备 安慰 脾气||1\n' +
  '2|跳过|||\n' +
  '3|小时候在老家摘油菜花，被喊「小名」。|小时候 老家 油菜花 小名 童年||1\n' +
  '4|' + 她 + '第一次给我做饭，做糊了。|做饭 下厨 糊了 第一次 纪念|2025-09-17|0.5'
  )
}

// ---------- 会话身份 ----------
// Session 上到底哪个字段是 id，各家版本可能不同 —— 挨个试
function sessionIdOf(session) {
  if (!session) return ''
  for (const k of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
    try {
      const v = session[k]
      if (typeof v === 'string' && v) return v
    } catch (error) {}
  }
  return ''
}

// 把一条消息的内容抽成文字
function textOfMessage(p) {
  if (!p) return ''
  if (typeof p === 'string') return p.slice(0, 2000)
  if (typeof p.text === 'string') return p.text.slice(0, 2000)
  if (typeof p.content === 'string') return p.content.slice(0, 2000)
  if (Array.isArray(p.content)) {
    const parts = []
    for (const b of p.content) {
      if (typeof b === 'string') parts.push(b)
      else if (b && typeof b.text === 'string') parts.push(b.text)
    }
    if (parts.length) return parts.join(' ').slice(0, 2000)
  }
  return ''
}

// 线索：从「这个 agent 自己的会话」里取最近一条用户消息 ✓
function lastUserTextOf(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return ''
    const ev = session.snapshotEvents() || []
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      const type = e && (e.type || e.kind)
      if (type !== 'user/message') continue
      const p = e.payload !== undefined ? e.payload : e.data
      const txt = textOfMessage(p)
      if (txt) return txt
    }
  } catch (error) {}
  return ''
}

// ---------- 时间 ----------

// 北京时间的一天（「每天最多记几条」要有明确定义）
function dayKey(t) {
  return new Date(t + TZ_OFFSET).toISOString().slice(0, 10)
}

function hhmm(t) {
  // ⚠ 2026-09-21 晚修：原来写的是 `new Date(t + TZ_OFFSET)` —— 那是**数字加法**的写法，
  //   而 t 传进来常常是 ISO **字符串**（m.at 就是字符串）→ 变成字符串拼接 → Invalid Date → NaN:NaN ✗
  const d = new Date(new Date(t).getTime() + TZ_OFFSET)
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0')
}

function mmdd(t) {
  const d = new Date(new Date(t).getTime() + TZ_OFFSET) // ⚠ 同上：要能接字符串
  return String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
}

// ⭐ 相对时间 —— 「时间观念」的核心
// ⭐ 相对时间 —— 按「日历天」算（北京时间），不是按过了多少小时 ✗
//    （昨天 22:14 到今天 12:08 只过了 14 小时，但那是「昨天」✓）
function dayIndex(t) {
  return Math.floor((new Date(t).getTime() + TZ_OFFSET) / 86400000)
}

function relTime(at, now) {
  // ⚠ 2026-09-21 晚补：空值 / 认不出来的时间，得老实说，不能算成 1970 ✗
  if (at === null || at === undefined || at === '') return '（没记时间）'
  const days = dayIndex(now) - dayIndex(at)
  if (!isFinite(days)) return '（时间认不出来）'
  if (days <= 0) return '今天 ' + hhmm(at)
  if (days === 1) return '昨天 ' + hhmm(at)
  if (days === 2) return '前天 ' + hhmm(at)
  if (days <= 14) return days + ' 天前（' + mmdd(at) + '）'
  if (days <= 60) return mmdd(at) + '（' + days + ' 天前）'
  // ⭐ 2026-09-21 晚：**跨年了就必须带年份** —— 不然「09-17」看不出是哪一年 ✗
  //   （反馈：的：「过了一年会怎么显示呢？我现在看没有年份，只有月份」）
  const 今年 = new Date(new Date(now).getTime() + TZ_OFFSET).getUTCFullYear()
  const 那年 = new Date(new Date(at).getTime() + TZ_OFFSET).getUTCFullYear()
  if (那年 !== 今年) {
    const 差 = 今年 - 那年
    if (差 === 1) return '去年 ' + mmdd(at)
    return 那年 + '-' + mmdd(at) + '（' + 差 + ' 年前）'
  }
  return mmdd(at) + '（' + Math.round(days / 30) + ' 个月前）'
}

// ---------- 相关度 ----------

// 中文停用词（照 AAAAGENT 的 hanStops 抄的 —— 去掉这些噪音词，匹配才准 ✓）
const HAN_STOPS =
  /(?:怎么样|叫什么|名字|名叫|叫|用户|什么|怎么|哪里|哪儿|现在|目前|当前|记得|记住|告诉|可以|请问|一下|来着|我们|你们|他们|她们|这个|那个|哪些|是否|有没有|我|你|他|她|它|的|了|着|过|是|有|在|把|被|和|与|及|或|这|那|哪|吗|呢|吧|啊|呀|得|地|个|只|件|请|也|都|就|很|再|还|要)/gu
const EN_STOPS = new Set(['the','a','an','is','are','was','were','i','you','my','your','it','and','or','to','of','what','where','do','did','does'])

const normalize = (s) => String(s || '').normalize('NFKC').toLowerCase()

// 抽出「实词」（去停用词 ✓）：中文按停用词切开，≤2 字整段收，更长抽 2-gram
// 切词的结果**缓存起来** —— 每轮要把 850 条记忆重新切一遍，纯浪费
// （实测：850 条切一次 42.7ms，而每轮都要切；缓存之后第二次起几乎不花时间）
// ⚠ 缓存有上限，别把内存撑爆；满了就整个丢掉重来（简单、够用）
const 切词缓存 = new Map()
const 切词缓存上限 = 4000

// 把一段话切成「按停用词分开的中文片段」—— 切词和搭配统计共用同一把刀 ✓
function 中文片段(s) {
  const clean = normalize(s)
  const out = []
  for (const run of clean.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (const part of run.split(HAN_STOPS)) if (part) out.push(part)
  }
  return out
}

function tokenize(s) {
  const 原文 = String(s || '')
  const 有 = 切词缓存.get(原文)
  if (有 !== undefined) return 有
  const out = new Set()
  const clean = normalize(s)
  for (const m of clean.matchAll(/[a-z0-9]{2,}/g)) {
    if (!EN_STOPS.has(m[0])) out.add(m[0])
  }
  for (const part of 中文片段(s)) {
    const chars = [...part]
    if (chars.length <= 2) out.add(part)
    else for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
  }
  if (切词缓存.size >= 切词缓存上限) 切词缓存.clear()
  切词缓存.set(原文, out)
  return out
}

// ---------- 「这半个词到底算不算一个词」 ----------
//
// 老切法把长度 >=3 的片段里**所有**相邻 2 字都收进来，于是「明天去公园」切出
//     明天 / 天去 / 去公 / 公园
// 其中 天去、去公 是**跨词碎片**：在语料里天生少见，被当成稀有线索，
// 把「这句话有多少信息量」抬起来 —— 报上来的那条误报就是它俩撑的
// （实测：门 1.98 → 0.59，门槛 0.8，正好从「过」变成「不过」）✓
//
// 判据只看**用户自己怎么用这两个字**，不维护任何词表。三个条件都满足才判成半个词：
//   ① 在用户嘴里出现过 >=3 次
//   ② 却从没被单独当一段用过（>=2 次）
//   ③ 而且**总黏着同一个邻居**（左右邻熵 <= 0.7 —— 真词的邻居五花八门，半个词是黏在另一半上的）
//     「天去」碎 11 次、单独 0 次、左邻熵 0.00 → 丢
//     「去公」碎  7 次、单独 1 次、最小邻熵 0.59 → 丢
//     「肚子」碎 11 次、单独 1 次、最小邻熵 1.67 → **留**（③ 把它救回来）
//     「花园」碎 565 次、单独 2 次 → 留（② 把它救回来）    「颜色」碎 0 次 → 留
//   ⚠ 第 ③ 条是 2026-09-21 补的：只按 ①② 会误杀「肚子」「开始」「阳台」这种
//     用户从来没单独用过、但确实是词的（实测「我肚子疼」被白挡成 0 条）。
//     0.7 这个位置不敏感：要丢的那批最小邻熵是 0.59 以下，要留的那批是 0.92 以上，中间是空带 ✓
// 一个片段里的 2 字**全**被判成半个词时，整段按原样切（不丢任何一个）——
//   这样「小明」「小红」「矿泉水」这种名字还有把手可以抓 ✓
//
// 换个人用，这套计数从那个人的话里长出来；语料还小的时候什么都不丢（= 原来的切法）✓
let 当前被丢 = null // Set<string>：这一次切词要丢掉的 2 字；null = 不过滤
let 当前搭配版本 = '无' // 这次挂的是哪个会话的第几版搭配表 —— 缓存键靠它区分 ✓

const 碎片下限 = 3 // ① 在她嘴里出现过这么多次…
const 整用下限 = 2 // ② …却从没被单独用过这么多次…
const 熵门 = 0.7 // ③ …而且邻居的杂乱程度低到这个地步 → 判成半个词
const 邻上限 = 8 // 一个词最多记这么多种邻居；记满了就说明「够杂」，不用再记 ✓

const 切词缓存2 = new Map() // 「过滤后」的切词缓存（跟上面那个原始缓存分开）
const 切词缓存2上限 = 4000

function 切词(s) {
  const 丢 = 当前被丢
  if (!丢 || !丢.size) return tokenize(s) // 没有证据 → 一个字都不丢 ✓
  const key = 当前搭配版本 + '\u0001' + String(s || '')
  const 有 = 切词缓存2.get(key)
  if (有 !== undefined) return 有
  const out = new Set()
  const clean = normalize(s)
  for (const m of clean.matchAll(/[a-z0-9]{2,}/g)) {
    if (!EN_STOPS.has(m[0])) out.add(m[0])
  }
  for (const part of 中文片段(s)) {
    const chars = [...part]
    if (chars.length <= 2) {
      out.add(part)
      continue
    }
    const 候选 = []
    for (let i = 0; i + 1 < chars.length; i++) 候选.push(chars[i] + chars[i + 1])
    const 留 = 候选.filter((bg) => !丢.has(bg))
    if (留.length) for (const t of 留) out.add(t)
    else for (const t of 候选) out.add(t) // 全被判成半个词 → 按原样切（名字还有把手）✓
  }
  if (切词缓存2.size >= 切词缓存2上限) 切词缓存2.clear()
  切词缓存2.set(key, out)
  return out
}

// ---------- 召回：量的是「证据」，不是「重叠率」----------
//
// ⚠⚠ 2026-09-21 大改（她定的 A+B，先讨论后动手）。
//
// 老公式是    C = 命中的实词数 ÷ 问句的实词数
// 分母是**问句长短**，不是「有没有关系」。所以它在真数据上跑出来是**双峰**的：
//     短句（「在吗」「嗯」）   → 分母 1~2 → C 白送 1.0 → 六条全塞
//     长句（「我什么时候卖号的」）→ 分母 3~5 → C 上不去 → 一条都不给
// 她 09-19~09-20 说的 47 句真话回放：0 条 32% / 6 条 60%，中间几乎是空的。
// 也就是说：**不是太敏感，是又太敏感又太聋，同一个病根。**
//
// 新公式把「比例」换成「证据量」：
//     s = Σ 命中词的稀有度   ← **不除以问句长度**，跟句子长短无关
//     C = s / (s + K)        ← 饱和到 1，K 就是「算一半相关」的那个点
// 稀有度从**记忆库自己**算：出现得越多的词越不值钱（IDF 的思路），
// 而且**归一化成 0~1** —— 不然 850 条的库和 5 条的库量出来不是一个量级，
// 同一个 K 在两边不可能都对（这是实测踩到的：小库上什么都召不回来）✓
// 好处：通用。不用维护任何黑名单、同义词组，换个人用也一样自己长出来。
//
// ⚠ 顺手砍掉三条「白送分」的路（老代码里它们能凭空造出一个 C）：
//     for (const tag of m.tags) if (query.includes(tag)) C = max(C, 0.6)   ← 白送
//     for (const g of SYN_GROUPS) ...                     C = max(C, 0.5)   ← 白送
//     if (cue && ...)                                     C = max(C, 0.7)   ← 白送
//   报上来的那个案子就是第二行干的：某个会话里聊插件说了「记忆」，
//   于是所有带「档案/记得/忘记」的记忆一律 0.5 → 5 条全塞（跟插件毫无关系）✗
//   时间词（「今天」「昨天」）本来想表达的是「优先想起那天的」，那是**排序**的事，
//   所以改成乘在 P 上，不再凭空给 C ✓

// 一条记忆「能被匹配到的那个面」= 正文 + 标签 + 离线扩出来的相关词
// （照 切词缓存 的办法按原文缓存 —— 用 id 当键会在改文本之后拿到旧的 ✗）
const 词面缓存 = new Map()
const 词面缓存上限 = 4000

function 词面(m) {
  const 原文 =
    String((m && m.text) || '') +
    ' ' +
    ((m && m.tags) || []).join(' ') +
    ' ' +
    (Array.isArray(m && m.related) ? m.related.join(' ') : '')
  // ⚠ 这里返回的是**归一化后的整段文字**（不是词集）—— 匹配是拿词去 includes 它，
  //   所以它跟「搭配代次」无关，缓存键不用带版本 ✓
  const 有 = 词面缓存.get(原文)
  if (有 !== undefined) return 有
  const t = normalize(原文)
  if (词面缓存.size >= 词面缓存上限) 词面缓存.clear()
  词面缓存.set(原文, t)
  return t
}

// 稀有度表：每个词出现在多少条记忆里。跟着记忆库走，记忆一改指纹就变、自然重算 ✓
// 指纹用「条数 + 每条的字数」，比逐条比文本便宜得多，也不会因为改一个字就漏掉
let 稀有缓存 = { 指纹: '', df: null }

function 稀有表(memories) {
  let 指纹 = String(memories.length)
  for (const m of memories) 指纹 += ',' + String(m && m.text ? m.text.length : 0) + '.' + String(m && m.tags ? m.tags.length : 0)
  if (稀有缓存.df && 稀有缓存.指纹 === 指纹) return 稀有缓存.df
  const df = new Map()
  for (const m of memories) {
    // ⚠ 记忆那边**故意不过滤**（走原始切法）：
    //   ① 多留几个词只会更宽松，不会漏配；② 它就不用跟着搭配版本反复重切 851 条
    //   问句那边切出来的词，要么是「被单独用过的词」，要么是整段全判成半个词时按原样切的，
    //   两种都能在这张原始词表里查到 ✓
    for (const k of tokenize(词面(m))) df.set(k, (df.get(k) || 0) + 1)
  }
  df.总条数 = memories.length
  // ⚠ 归一化用的顶：只在**一条**记忆里出现的词就是最值钱的，记作 1.00 ✓
  df.顶 = Math.log((memories.length + 1) / 2)
  稀有缓存 = { 指纹, df }
  return df
}

// 归一化过的稀有度：0 ~ 1。1 = 只在一条记忆里出现过，0 = 每条记忆里都有它 ✓
const 稀有度 = (df, k) => {
  if (!(df.顶 > 0)) return 0
  const v = Math.log((df.总条数 + 1) / ((df.get(k) || 0) + 1)) / df.顶
  return v > 0 ? v : 0
}

// ---------- 「她自己怎么说话」这把尺子 ----------
//
// 治「太敏感」的那一刀不能砍在记忆上，得砍在**问句**上：
// 「在吗」「嗯」「哈哈」这种话，不管拿什么公式去跟几百条记忆比，总能比出六条来
// （这个我用真数据试过：只换打分公式，它们照样六条）。
// 但「这句话本身有没有值得翻记忆的东西」是可以量的 ——
// 尺子就是**用户自己说过的话**：天天挂在嘴边的词（在吗）不算信息，偶尔才说的（护照）才算。
//
// 实测（拿用户 2048 句真话当尺子）：
//   在吗 753/2048 句 → 0.29      护照 8 句 → 高
//   嗯    56 句                   体检 4 句 → 高
// 这把尺子自己长出来：监听本会话收到的每一条消息，第一次要用时再从会话历史里补一遍。
// 不需要任何词表 —— 以后发仓库给别人用，他的尺子从他的话里长，不会带着我们的口味 ✓
const 说话尺 = new Map() // sid -> { n, df, 碎, 整, 被丢, 装过 }

function 拿尺(sid) {
  const key = String(sid || '')
  let r = 说话尺.get(key)
  if (!r) {
    r = { n: 0, df: new Map(), 碎: new Map(), 整: new Map(), 邻: new Map(), 被丢: new Set(), 版本: 0, 装过: false }
    说话尺.set(key, r)
  }
  return r
}

// ⭐ 数「这两个字她是怎么用的」：
//     碎 = 夹在长片段里的次数（明天去公园 → 天去、去公 各 +1）
//     整 = 被单独当一段用的次数（「去公」当一整段出现 → +1）
//   ⚠ 这两个计数**不能**走过滤后的切词 —— 判据本身要是被它判过的东西，就自己咬自己了，
//     所以这里永远用原始片段（中文片段）来数 ✓
function 记一句结构(r, text) {
  for (const p of 中文片段(text)) {
    const c = [...p]
    const 整过 = r.整.get(p) || 0
    r.整.set(p, 整过 + 1)
    // 单独用过 >=2 次 → 撤销「半个词」的判定（「花园」就是这么救回来的）✓
    if (整过 + 1 === 整用下限 && r.被丢.has(p)) {
      r.被丢.delete(p)
      r.版本++
    }
    if (c.length <= 2) continue
    for (let i = 0; i + 1 < c.length; i++) {
      const bg = c[i] + c[i + 1]
      const n = (r.碎.get(bg) || 0) + 1
      r.碎.set(bg, n)
      // 左右邻居：判「是不是总黏着同一个字」。记满 邻上限 种就标记「够杂」，不再记 ✓
      记邻居(r, bg, 'L', i > 0 ? c[i - 1] : '边')
      记邻居(r, bg, 'R', i + 2 < c.length ? c[i + 2] : '边')
      if (n >= 碎片下限) 判半个词(r, bg)
    }
  }
}

function 记邻居(r, bg, 侧, ch) {
  const key = 侧 + bg
  let m = r.邻.get(key)
  if (!m) {
    m = new Map()
    r.邻.set(key, m)
  }
  if (m.够杂) return
  m.set(ch, (m.get(ch) || 0) + 1)
  if (m.size >= 邻上限) {
    m.够杂 = true
    m.clear()
  }
}

function 熵(m) {
  let n = 0
  for (const v of m.values()) n += v
  if (!n) return 0
  let h = 0
  for (const v of m.values()) {
    const p = v / n
    h -= p * Math.log2(p)
  }
  return h
}

function 侧熵(r, bg, 侧) {
  const m = r.邻.get(侧 + bg)
  if (!m) return 0
  return m.够杂 ? 99 : 熵(m)
}

// 三个条件都满足才判成半个词；判完就写进 被丢，并且**每次新句子都重判一次**
// （邻居越攒越多，一个词随时可能从「半个词」翻回「是个词」）✓
function 判半个词(r, bg) {
  const 该丢 =
    (r.整.get(bg) || 0) < 整用下限 && Math.min(侧熵(r, bg, 'L'), 侧熵(r, bg, 'R')) <= 熵门
  if (该丢 === r.被丢.has(bg)) return
  if (该丢) r.被丢.add(bg)
  else r.被丢.delete(bg)
  r.版本++
}

function 记一句话(sid, text) {
  const s = String(text || '').trim()
  if (!s || s.length > 1000) return
  const r = 拿尺(sid)
  r.n++
  for (const k of tokenize(s)) r.df.set(k, (r.df.get(k) || 0) + 1)
  记一句结构(r, s)
}

// 这个会话当前要丢掉哪些「半个词」✓
function 搭配集(sid) {
  return 拿尺(sid).被丢
}

// 把某个会话的搭配表挂上（切词、稀有表、问句门都靠它）——
// 返回版本号，缓存键带上它，搭配表一变缓存自然失效 ✓
function 装搭配(sid) {
  if (!sid) {
    当前被丢 = null
    当前搭配版本 = '无'
    return 当前搭配版本
  }
  const r = 拿尺(sid)
  当前被丢 = r.被丢
  当前搭配版本 = String(sid) + '#' + r.版本
  return 当前搭配版本
}

// 第一次要用的时候从会话历史里补一遍（只做一次，最多回看 2000 句）
function 补历史尺(sid, session) {
  const r = 拿尺(sid)
  if (r.装过) return r
  r.装过 = true
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return r
    const ev = session.snapshotEvents() || []
    let 收 = 0
    for (let i = ev.length - 1; i >= 0 && 收 < 2000; i--) {
      const e = ev[i]
      if (!e || e.type !== 'user/message') continue
      const p = e.payload !== undefined ? e.payload : e.data && e.data.message !== undefined ? e.data.message : e.data
      const txt = textOfMessage(p)
      if (!txt) continue
      记一句话(sid, txt)
      收++
    }
    diag('  说话尺补齐：' + 收 + ' 句')
  } catch (error) {
    diag('  说话尺补历史失败：' + (error && error.message))
  }
  return r
}

// 这句话本身有多少信息量。返回的是**归一化过**的值（0 ~ 几个「最稀有的词」）——
// 不归一化的话它会跟着「过多少句话」一起变大，门槛就成了个只对当前样本成立的数 ✓
// ⚠ 只算「在记忆库里真能当线索用」的词：切词切出来的「宝今」「天干」这种跨词碎片
//   在记忆里根本不存在，不该被算成信息（不然长词会被自己的碎片抬起来）✓
function 问句信息量(sid, query, df) {
  const r = 拿尺(sid)
  if (r.n < 20) return Infinity // 样本太少，门先不开，免得误杀
  const 顶 = Math.log(r.n + 1)
  if (!(顶 > 0)) return Infinity
  装搭配(sid) // ⭐ 半个词不算线索（「天去」「去公」不该给这句话加分）✓
  let v = 0
  for (const k of 切词(query)) {
    if (!df.get(k)) continue
    v += Math.log((r.n + 1) / ((r.df.get(k) || 0) + 1))
  }
  return v / 顶
}

const TIME_CUES = [
  { re: /今天|今日|今儿/, from: 0, to: 0 },
  { re: /昨天|昨日|昨晚/, from: 1, to: 1 },
  { re: /前天/, from: 2, to: 2 },
  { re: /这几天|最近|前几天|这一阵|前阵子/, from: 0, to: 7 },
  { re: /上周|上星期/, from: 7, to: 14 },
]

const 时间加权 = 1.3 // 时间词只提排序，不提「相关度」✓

// ⭐⭐ 2026-09-22（反馈：「没标时间的还是鲜活 100%，有些还是 —」）：
//   **页面显示的鲜活度，跟召回真正用的根本不是一套公式** ✗
//     页面那套：`stable_profile ? 1 : 2^(-天数/半衰期)` ——
//       · 长期事实**无条件给 1**（100%）→ 没时间的也显示 100% ✗
//       · `m.at` 是空的时候 `Date.parse(undefined)` = NaN → 显示成「鲜活 NaN%」✗
//     召回那套（下面 evaluate 里）：有锚点、有强化、没时间就用 unknownActivation
//   → 抽成**同一个函数**，两边共用 ✓（她看到的 = 真正发生的）
function 鲜活度(m, policy, now) {
  const I = typeof m.importance === 'number' ? m.importance : 0
  const H = (policy.baseHalfLifeDays || 30) * (1 + 2 * I)
  const 常数 = clampNum(typeof policy.unknownActivation === 'number' ? policy.unknownActivation : 1, 0, 1)
  // ⭐⭐ 2026-09-22（反馈：「这些为什么会被当成长期事实」）：
  //   **「没记时间」不等于「不会淡」** ✗
  //     发现来的两条：「某天吃了什么」「某天几点睡」
  //     —— 那些是**日常流水账**，本来就该淡，只是碰巧没抠到日期。
  //   原来这里：没 at 又没锚 → **钉在常数上不动** → 看起来像「永远不淡」✗
  //   而且判据还拿这个去分组 → 把 394 条流水账错收进「不会淡的」里 ✗✗
  //   → 改成：**没记时间的，从「记下来的那天」开始淡** ✓
  //     （不知道事情是哪天发生的，但**知道我们哪天记下它的** —— 拿这个当锚不算编造）
  //   真正「不会淡」的只有一类：**长期事实**（要记一辈子的事，没有「新不新」）✓
  if (m.category === 'stable_profile') return 常数
  const 锚 = m.activationAnchor || m.at || m.createdAt || m.importAt || null
  const 锚ms = 锚 ? Date.parse(锚) : NaN
  if (!isFinite(锚ms)) return 常数 // 连「记下来的时间」都没有 → 只能给常数
  const daysA = Math.max(0, (now - 锚ms) / DAY)
  const A0 = typeof m.activation0 === 'number' && isFinite(m.activation0) ? clampNum(m.activation0, 0, 1) : 1
  return A0 * Math.pow(2, -daysA / H)
}

function timeCueRange(query) {
  for (const c of TIME_CUES) if (c.re.test(query)) return c
  return null
}

function evaluate(m, query, now, policy, 尺) {
  const I = typeof m.importance === 'number' ? m.importance : 0
  const atMs = m.at ? Date.parse(m.at) : null
  const days = atMs ? Math.max(0, (now - atMs) / DAY) : 0

  const qKeys = [...切词(query)] // ⭐ 问句这边也过搭配表：半个词不当线索 ✓
  const mText = 词面(m)

  // ⭐ 证据量 = 命中词的稀有度之和。**不除以问句长度** —— 这是这次改的核心 ✓
  let s = 0
  for (const k of qKeys) if (mText.includes(k)) s += 稀有度(尺.df, k)
  const K = typeof policy.rarityK === 'number' && policy.rarityK > 0 ? policy.rarityK : 1
  let C = s / (s + K)
  // 整句原话出现在记忆里 = 强证据，直接顶到 0.85
  // ⚠ 太短的问句不算 —— 不然「在吗」两个字也是一整句 ✓
  if (query.trim().length >= 6 && qKeys.length > 0 && mText.includes(normalize(query).trim())) C = Math.max(C, 0.85)

  const H = policy.baseHalfLifeDays * (1 + 2 * I)
  // ⭐ 强化（照 AAAAGENT）：她被再次提到时 A' = A + 0.2(1-A)，
  //    活跃度从「最后一次被提到」那个锚点重新开始算 —— 但 `at`（事情发生的时间）不动 ✓
  const 锚 = m.activationAnchor ? Date.parse(m.activationAnchor) : atMs
  const daysA = 锚 ? Math.max(0, (now - 锚) / DAY) : days
  const A0 = typeof m.activation0 === 'number' && isFinite(m.activation0) ? Math.max(0, Math.min(1, m.activation0)) : 1
  // ⭐⭐ 2026-09-21 改（C＋D）：「鲜活」这件事只对**有时间戳的事件**成立 ✓
  //   长期事实（stable_profile）是要记一辈子的，没有「新不新」这回事；
  //   没写时间戳的也一样 —— 不知道是什么时候的事。
  //   这两类合起来用同一个档位（unknownActivation），默认 1 = 老样子。
  //
  //   ⭐ 2026-09-21 晚：**门槛改成只卡 C 之后，这个旋钮终于安全了** ✓
  //     改之前（门槛卡 P）实测：
  //       没写时间算多鲜活   该想起的给到
  //              1            10/11
  //           0.75             8/11
  //            0.5             8/11
  //           0.25             5/11
  //              0             5/11
  //     原因：门槛卡的是 P = C × 乘数，而乘数里有鲜活度 A → 压低 A = 整个库的分数整体下移
  //     → 连着「该想起的」一起被挡掉 ✗（而且它们本来就拿同一个值，压低**不改变它们之间的排序**）
  //     改之后（门槛卡 C）实测，同一个旋钮扫一遍：
  //       1 / 0.75 / 0.5 / 0.25 / 0  →  该想起的**全是 11/13，一动不动** ✓
  //     它现在只影响**排序**（平均条数 5.29 → 5.24），不影响谁进得来 —— 这才是它该干的活 ✓
  //   → 「事实不抢位置」这件事仍然交给下面 recall 里的**名额上限**去做 ✓
  // ⭐⭐ 2026-09-21 晚修：**没时间戳、但被强化过的，要按正常衰减走** ✓
  //   以前只要 `!atMs` 就直接给常数，把强化完全绕过 —— 于是 833 条没时间戳的
  //   「提到了也不涨」，死死钉在那个常数上（实测发现的）✗
  //   现在：**有锚 = 被提过一次 = 知道是什么时候提的** → 该涨就涨、该淡就淡 ✓
  //   （事实 stable_profile 仍然平着 —— 要记一辈子的事没有「新不新」这回事）
  // ⚠ 这里原来自己算了一套（跟召回不一致）→ 现在统一走 鲜活度() ✓
  const A = 鲜活度(m, policy, now)
  const E =
    m.emotion === null || m.emotion === undefined
      ? 0
      : m.emotion * Math.pow(2, -days / policy.emotionHalfLifeDays)

  let P = C * (policy.baselineWeight + policy.activationWeight * A + policy.importanceWeight * I + policy.emotionWeight * E)

  // 时间词：只做排序加权，**不再凭空给 C** ✓
  const cue = timeCueRange(query)
  let timeHit = false
  if (cue && m.at) {
    const md = Math.floor((now - Date.parse(m.at)) / DAY)
    if (md >= cue.from && md <= cue.to) {
      timeHit = true
      P *= 时间加权
    }
  }

  return { C, A, E, I, P, days, daysA, timeHit, s }
}

// ══════════════════════════════════════════════════════════════
// 「这两条是不是在说同一件事」—— 给召回去重用
//
// ⭐ 2026-09-22（反馈）：
//   她贴给我看的那段注入里，**两条几乎一样的「我不编…」同时进来了** ✗
//   实测：全库 850 条里，像度 ≥0.72 的有 **131 对**，牵涉 **226 条（27%）**。
//   根因是她的两份档案（记忆卡 + 总档案）内容本来就重叠，
//   而导入只按「一字不差」去重 → 换个说法的同一件事两条都进来了。
//
//   做法：按共有的「三字片段」算像度。
//   ⚠ 分母取**短的那条**的片段数 —— 这样「长句包含短句」也算像
//     （例：「她戴眼镜，头发很长…」 vs 「…还加额头痒、发箍打架」）
// ══════════════════════════════════════════════════════════════
function 三字片段(s) {
  // 标点空格先去掉，不然「，」的片段会跟别人假像
  const t = String(s || '').replace(/[\s，。、；：！？「」『』（）"'*_`~—\-–]/g, '')
  const out = new Set()
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
  return out
}
// 像度 0~1。1 = 短的那条完全被长的包住
function 像度(片段A, 片段B) {
  if (!片段A.size || !片段B.size) return 0
  const 小 = 片段A.size <= 片段B.size ? 片段A : 片段B
  const 大 = 小 === 片段A ? 片段B : 片段A
  let 交 = 0
  for (const x of 小) if (大.has(x)) 交++
  return 交 / 小.size
}
// 够像就算「同一件事」。0.85 是量出来的：
//   实测库里 131 对重复，绝大多数落在 0.85 以上；再低就会误杀「相关但不同」的
const 重复门槛 = 0.85

function recall(data, query, now, sid) {
  const policy = data.policy
  // ⭐ 2026-09-21（E）：**提炼判成「跳过」的，不再参与召回** ✓
  //   它们还留在库里（设置页看得见、能「重跑」放回来），只是不再被想起来。
  //   老代码把「跳过」当成一个纯展示标记 —— 判了跳过照样会被召回来，等于白判 ✗
  const memories = (Array.isArray(data.memories) ? data.memories : []).filter((m) => !m || !m.refinedSkip)
  // ⭐ 先把「这个会话的搭配表」挂上，再切词 —— 半个词（天去／去公）不该当线索 ✓
  //   （记忆那边的词表也走同一张搭配表，两边才配得上）
  装搭配(sid)
  const df = 稀有表(memories)
  const 尺 = { df }

  // ⭐⭐ 第一道门开在**问句**上，不在记忆上（2026-09-21 加）
  //   「在吗」「嗯」「哈哈」这种话本身没内容，就不该去翻几百条记忆 ——
  //   实测过：只换打分公式，它们照样六条，因为**总能比出六条来**。
  //   尺子是「她自己怎么说话」：天天说的词不算信息，偶尔说的才算 ✓
  const 门槛 = typeof policy.queryGate === 'number' ? policy.queryGate : 0.8
  let gate = null
  if (门槛 > 0 && sid) {
    const v = 问句信息量(sid, query, df)
    if (v < 门槛) {
      // 这道门挡下来的时候**不做 851 次打分**，省一趟；理由照样记进 trace 给她看 ✓
      return { selected: [], scored: [], 字数: 0, gate: { 信息量: Number(v.toFixed(2)), 门槛 } }
    }
    gate = { 信息量: Number(v.toFixed(2)), 门槛 }
  }

  const scored = memories.map((m) => ({ m, s: evaluate(m, query, now, policy, 尺) }))

  const picked = []
  for (const row of scored) {
    if (row.s.C <= 0) row.omission = 'hard_gate'
    // ⭐⭐ 2026-09-21 改：门槛卡的是 **C（证据）**，不再是 P（总分）✓
    //   为什么必须分开：P = C × 乘数，而乘数里有鲜活度 A。
    //   以前门槛卡 P，于是「鲜活度」一动，**门槛跟着动** ——
    //   851 条里 833 条没时间戳，把它们的鲜活度一起压低 = 整个库的分数整体下移
    //   → 连着「该想起的」一起被挡掉（实测：0.75 就掉到 8/11，0 掉到 5/11）✗
    //   而且它们本来就拿同一个值，压低**不改变它们之间的排序**，纯粹白损失。
    //   分开之后：门槛只管「这条记忆跟这句话到底有没有真关系」（C），
    //   鲜活度/重要度/情绪**只参与排序**（下面的 sort 用 P）→
    //   那个「没写时间的算多鲜活」的旋钮就能安全地调了 ✓
    else if (row.s.C < policy.threshold) row.omission = 'below_threshold'
    else picked.push(row)
  }
  picked.sort((a, b) => b.s.P - a.s.P)

  // ⭐⭐ 2026-09-22（反馈）：**召回去重** —— 几乎一样的只留一条 ✓
  //
  //   她贴的那段注入里，两条「我不编…」几乎一模一样、一起进来了 ✗
  //   一次只注入 6 条，两条重复的等于**白占一个名额**，还把她挤得更满。
  //
  //   ⚠ 位置很要紧：**在分两条队之前去重** ——
  //     这样重复的不会占掉「长期事实最多 2 个位置」或者条数上限 ✗
  //   ⚠ 留哪条：**分高的那条**（picked 已经按 P 排好，第一条就是）
  //   ⚠ 片段先算一次缓存着，别在双重循环里反复切字符串（850 条会卡）
  const 带去重 = picked.map((row) => ({ row, 片段: 三字片段(row.m.text) }))
  const 去重后 = []
  for (const x of 带去重) {
    let 是重复 = false
    for (const y of 去重后) {
      if (像度(x.片段, y.片段) >= 重复门槛) {
        是重复 = true
        break
      }
    }
    if (是重复) {
      x.row.omission = 'duplicate' // 设置页上会写「跟另一条重复」
      continue
    }
    去重后.push(x)
  }
  const 挑过 = 去重后.map((x) => x.row)

  // ⭐ 2026-09-21（C）：**两条队** —— 长期事实最多占 factsMax 个位置，剩下的留给事件 ✓
  //   实测：老代码里事实占了 61% 的位置（三分之一问句 6 条里 5 条是事实），
  //   而事实是要记一辈子的事，本来不该每轮都跟「今天发生了什么」抢位置。
  //   先按条数截（两条队各自的名额），再按字数截 —— 字数超了的标 budget ✓
  //   （第一条不管多长都放行，不然一条超长的会把整段都挤掉）
  const 事实上限 =
    typeof policy.factsMax === 'number' && policy.factsMax >= 0 ? Math.floor(policy.factsMax) : 2
  const 条数内 = []
  let 事实数 = 0
  for (const row of 挑过) {
    if (条数内.length >= policy.maxItems) break
    if (row.m.category === 'stable_profile') {
      if (事实数 >= 事实上限) {
        row.omission = 'fact_cap'
        continue
      }
      事实数++
    }
    条数内.push(row)
  }
  const 上限 = typeof policy.maxChars === 'number' && policy.maxChars > 0 ? policy.maxChars : 800
  const selected = []
  let 已用 = 0
  for (const row of 条数内) {
    const n = String(row.m.text || '').length
    if (selected.length > 0 && 已用 + n > 上限) {
      row.omission = 'budget'
      continue
    }
    selected.push(row)
    已用 += n
  }
  const ids = new Set(selected.map((r) => r.m.id))
  for (const row of picked) {
    if (row.omission) continue // 别把 budget 覆盖成 limit
    if (ids.has(row.m.id)) continue
    row.omission = 'limit'
  }

  // ⚠ scored 要按分数排一下再交出去 —— 不然设置页那个「最近一次召回」
  //   按**入库顺序**显示前 12 条，全是 0 分的老条目，看不出到底挑中了什么 ✗
  //   （反馈：「这里为什么只有这些，该显示最近标中的」）
  const 按分排 = scored.slice().sort((a, b) => b.s.P - a.s.P || b.s.C - a.s.C)

  return { selected, scored: 按分排, 字数: 已用, gate }
}

// 「她的回复里像不像真的用上了这条记忆」—— 靠实词重合**猜**的，不是事实 ✓
// 所以设置页上写「像是用上了」，不写成「用上了」。
function 用上了(reply, memText) {
  const keys = [...tokenize(memText)]
  if (keys.length < 2) return false
  const b = normalize(reply)
  let hit = 0
  for (const k of keys) if (b.includes(k)) hit++
  return hit >= 2 && hit / keys.length >= 1 / 3
}

// 这条记忆被删掉 / 改过之后，以前召回记录里它就算「失效」了 ✓
function markTraceStatus(data, id, status) {
  let 动 = false
  for (const tr of data.traces || []) {
    for (const row of tr.rows || []) {
      if (String(row.id) !== String(id)) continue
      if (row.status === status) continue
      row.status = status
      动 = true
    }
  }
  return 动
}

function render(selected, now, selfName) {
  if (!selected.length) return ''
  const lines = selected.map((r) => {
    // ⭐ 注入前再换一次人称 —— 这样**以前写错的老记忆**读出来也是对的 ✓
    const body = normalizePerson(String(r.m.text || '').trim(), selfName)
    if (r.m.at) return '- ' + relTime(Date.parse(r.m.at), now) + '：' + body
    if (r.m.category === 'stable_profile') return '- 一直：' + body
    return '- ' + body // 不知道什么时候发生的，就不写时间（别编）
  })
  return [
    '【你记得的事】',
    '下面是你们过去真实发生过的事。有时间的事会写在前面；**没写时间的，说明不知道是什么时候**。',
    '有时间就按那个时间说（「今天早上」「3 天前」），不要说成「发生过」这种没有时间的话；不知道就说不知道，别编。',
    '想不起来的事就说想不起来，不要编。',
    '',
    ...lines,
  ].join('\n')
}

// ---------- remember 工具（她自己记）----------
// 时间戳用「系统当前时间」—— 这是这个工具存在的全部意义：
// 手写的时间会错（我今天编了两次），系统给的不会错 ✓

function sessionIdFromExec(exec) {
  try {
    const a = exec && (exec.agent || exec.caller || exec.agentRef)
    if (a && a.session) return sessionIdOf(a.session)
    if (a && typeof a === 'object') {
      for (const k of ['sessionId', 'id']) if (typeof a[k] === 'string') return a[k]
    }
  } catch (error) {}
  return ''
}

function makeRememberTool(ctx) {
  return defineTool({
    name: 'remember',
    description:
      '把一件事记进长期记忆（以后每轮都可能想起来）。' +
      '只记长期有价值的事：她明确说的重要的话、约定、她的喜好、她的状态（生病/很累/很开心）、你们之间发生的事。' +
      '不要记日常琐事（吃了什么、今天天气怎样）、不要记你自己做过的事、不要记重复的东西。' +
      '同一条一天最多记一次。**记的时候安静地记，不要在回复里说「记下了」「我记住了」这种话** —— 那很像在汇报工作。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description:
          '要记住的事，一句话说清。**人称**：你自己是「我」，用户是「' + userPronoun() + '」，' +
          '别人和别的 AI 直接写名字 —— 别把别人也写成「' + userPronoun() + '」。',
      },
      importance: {
        type: 'number',
        description: '0 = 随口提过；0.5 = 比较重要；1 = 非常重要（约定、关系、她的核心状态）。不确定就写 0.5。',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '几个关键词，方便以后被想起来（比如 ["睡觉","熬夜","约定"]）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      // 记成功了就一个 ✓，不多冒一句「记下了」✗
      //
      // ⚠⚠ 2026-09-21 修：原来写的是 `render()` —— 不接参数，所以**永远返回 ✓**，
      //    哪怕 execute 明确返回了 { ok: false }（比如「这个会话的记忆是关着的」）。
      //    实测就是这么被坑的：开关关着 → 实际跳过 → 界面照样打勾 →
      //    她以为记上了，去列表里翻半天找不到 ✗
      //    DSH 调用的是 render(exec.arguments, value)，value 就是 execute 的结果 ✓
      render(_args, value) {
        if (value && value.ok === false) {
          return [{ type: 'text', text: '✗ ' + String(value.message || '没记住') }]
        }
        return [{ type: 'text', text: '✓' }]   // 不能返回空 —— 空结果会让界面卡住 ✗
      },
    },
    async execute(args, exec) {
      const sid = sessionIdFromExec(exec)
      if (!sid) {
        diag('remember：拿不到会话 id（exec 的字段：' + (exec ? Object.keys(exec).join(',') : 'null') + '）')
        return { ok: false, message: '没记住（拿不到会话）' }
      }
      // 这个会话没开记忆 → 不记（关掉就是真的不想用）✓
      if (!isEnabled(sid)) {
        diag('remember：' + sid + ' 没开记忆，跳过')
        return { ok: false, message: '这个会话的记忆是关着的，先到设置里打开' }
      }
      const 原始 = String((args && args.text) || '').trim()
      // ⭐ 机械保证：她自己写成「小明」也换成「我」✓
      const text = normalizePerson(原始, selfNameOf(sid))
      if (!text) return { ok: false, message: '没记住（内容是空的）' }
      if (text !== 原始) diag('remember：人称换过了 →「' + text + '」')

      const data = loadStore(sid)
      const policy = data.policy
      const now = Date.now()

      // 配额（每天最多几条，先宽松）
      const today = dayKey(now)
      const todayCount = data.memories.filter((m) => m.createdAt && dayKey(Date.parse(m.createdAt)) === today).length
      if (todayCount >= policy.dailyQuota) {
        return { ok: false, message: '今天记满了（' + policy.dailyQuota + ' 条），明天再说。' }
      }

      // 去重：内容太像的不重复记 —— 但**强化**它（照 AAAAGENT）
      // 「她又提到这件事了」说明这件事还在她心里，该记得更牢一点 ✓
      // （注意：只有她真的又提一次才强化；光是召回想起来**不**强化 ——
      //   「仅浏览、搜索不会把记忆越看越重要」✓）
      const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?]/g, '')
      const nt = norm(text)
      for (const m of data.memories) {
        const a = norm(m.text)
        if (a && (a === nt || (a.length > 8 && nt.length > 8 && (a.includes(nt) || nt.includes(a))))) {
          const I0 = typeof m.importance === 'number' ? m.importance : 0
          const H0 = policy.baseHalfLifeDays * (1 + 2 * I0)
          const 旧锚 = m.activationAnchor ? Date.parse(m.activationAnchor) : m.at ? Date.parse(m.at) : now
          const 旧A0 = typeof m.activation0 === 'number' && isFinite(m.activation0) ? Math.max(0, Math.min(1, m.activation0)) : 1
          // ⚠ 这里必须和 evaluate 用**同一套规则**，否则「涨」的起点不对：
          //   没时间戳又还没锚的，起点是那个常数（她设 0.5 就从 0.5 往上涨）；
          //   以前只特判了 stable_profile，对它们算出 旧A=1 → 新A 还是 1 → 记了个寂寞 ✗
          const 没时间又没锚 = !m.at && !m.activationAnchor
          const 旧A = m.category === 'stable_profile'
            ? 1
            : 没时间又没锚
              ? clampNum(typeof policy.unknownActivation === 'number' ? policy.unknownActivation : 1, 0, 1)
              : 旧A0 * Math.pow(2, -Math.max(0, (now - 旧锚) / DAY) / H0)
          const 新A = 旧A + 0.2 * (1 - 旧A) // ⭐ A' = A + 0.2(1-A)
          m.activation0 = Math.max(0, Math.min(1, 新A))
          m.activationAnchor = new Date(now).toISOString()
          m.reinforcedAt = new Date(now).toISOString()
          m.lastReinforcedDay = dayKey(now)
          m.reinforceCount = (typeof m.reinforceCount === 'number' ? m.reinforceCount : 0) + 1
          saveStore(sid, data)
          diag('remember：这条记过了，强化一下 → 活跃度 ' + 旧A.toFixed(2) + ' → ' + m.activation0.toFixed(2))
          return { ok: true, message: '这条记过了，已经把它记得更牢一点（第 ' + m.reinforceCount + ' 次）。' }
        }
      }

      const imp = typeof args.importance === 'number' ? Math.max(0, Math.min(1, args.importance)) : 0.5
      data.memories.push({
        id: 'm' + now.toString(36) + Math.floor(Math.random() * 1000),
        text: text,
        at: new Date(now).toISOString(), // ⭐ 真实时间（系统给的）
        createdAt: new Date(now).toISOString(),
        category: imp >= 1 ? 'stable_profile' : 'event',
        importance: imp,
        emotion: null,
        tags: Array.isArray(args.tags) ? args.tags.slice(0, 6).map(String) : [],
        source: '她自己记的',
        reinforcedAt: null,
        lastReinforcedDay: null,
      })
      saveStore(sid, data)
      diag('remember：' + sid + ' 记了「' + text.slice(0, 40) + '」（今天第 ' + (todayCount + 1) + ' 条）')
      return { ok: true, message: '记下了（' + relTime(now, now) + '）。' }
    },
  })
}

// 会话名字（DSH 给每个会话起的标题）
function titleOfSession(ctx, sid) {
  try {
    const s = ctx.sessions.get(sid)
    if (!s) return ''
    const snap = ctx.sessionTitle.get(s)
    return snap && snap.title ? String(snap.title) : ''
  } catch (error) {
    return ''
  }
}

// 被她「归档」的会话：不再注入、也不在清单里露出来 ✓
// ⚠ 归档只是把会话**藏起来**，不会把它卸载 —— agents.list() 里还在，得单独查这个名单。
//    这个属性没写进 workspaceRegistry 的公开方法表，但运行时确实有
//
// ⚠⚠ 2026-09-21 修：原来是 `catch { return new Set() }` —— **读不到就静默当成「没有归档」**，
//    于是归档的会话照样露在清单里，而且一点痕迹都不留（反馈： 11 条幽灵就是这么来的）。
//    现在：① 每条路都留日志（只在内容变化时打，免得每 3 秒刷屏）；② 服务读不到就兜底读存储文件；
//    ③ 两条都不行才放弃，而且**宁可多露、不可错藏**。
let 归档名单上次日志 = ''
function 归档名单log(msg) {
  if (msg === 归档名单上次日志) return
  归档名单上次日志 = msg
  diag(msg)
}

function 归档名单(ctx) {
  const out = new Set()
  // 路一：问运行时的服务（首选，实时）
  try {
    const wr = ctx.get('workspaceRegistry')
    if (wr === undefined) {
      归档名单log('归档名单：ctx.get("workspaceRegistry") 是空的')
    } else {
      const ids = wr.archivedSessionIds
      if (Array.isArray(ids)) {
        for (const x of ids) out.add(String(x))
        归档名单log('归档名单：从服务拿到 ' + out.size + ' 个')
        return out
      }
      归档名单log('归档名单：服务上的 archivedSessionIds 不是数组，是 ' + typeof ids)
    }
  } catch (error) {
    归档名单log('归档名单：读服务抛错 -> ' + ((error && error.message) || String(error)))
  }
  // 路二：兜底读 DSH 自己的存储文件（同一份数据，格式稳定）
  try {
    const j = JSON.parse(readFileSync(join(CFG_DIR, 'storages', 'workspace.json'), 'utf8'))
    const ids = j && j.global && j.global.archivedSessionIds
    if (Array.isArray(ids)) {
      for (const x of ids) out.add(String(x))
      归档名单log('归档名单：从存储文件兜底拿到 ' + out.size + ' 个')
      return out
    }
    归档名单log('归档名单：存储文件里没有 global.archivedSessionIds')
  } catch (error) {
    归档名单log('归档名单：读存储文件也失败 -> ' + ((error && error.message) || String(error)))
  }
  归档名单log('归档名单：两条路都拿不到，这次不做归档隐藏（宁可多露，不可错藏）')
  return out
}

// DSH 现在认得哪些会话 —— 用来认「幽灵」（会话已经没了、记忆文件还留着）
// ⚠ ok=false 表示**没拿到可信来源**，这时候调用方必须保守：一条都不藏
let 已知会话上次日志 = ''
function 已知会话log(msg) {
  if (msg === 已知会话上次日志) return
  已知会话上次日志 = msg
  diag(msg)
}

function 已知会话ids(ctx) {
  const ids = new Set()
  try {
    const wr = ctx.get('workspaceRegistry')
    if (wr === undefined) {
      已知会话log('已知会话：ctx.get("workspaceRegistry") 是空的 —— 这次一条都不藏')
      return { ids, ok: false }
    }
    if (typeof wr.list !== 'function') {
      已知会话log('已知会话：workspaceRegistry 上没有 list() —— 这次一条都不藏')
      return { ids, ok: false }
    }
    const list = wr.list() || []
    for (const w of list) for (const id of (w && w.sessionIds) || []) ids.add(String(id))
    已知会话log('已知会话：拿到 ' + ids.size + ' 个（工作区 ' + list.length + ' 个）')
  } catch (error) {
    已知会话log('已知会话：读 workspaceRegistry 抛错 -> ' + ((error && error.message) || String(error)))
    return { ids, ok: false }
  }
  // ⚠ 一个都没拿到就不算可信 —— 否则会把所有记忆都当幽灵藏掉
  return { ids, ok: ids.size > 0 }
}

// 拼出给页面看的全部数据（/list 和 /page 共用）
// 这个会话是从哪个会话分出来的（拿不到就 null）—— 界面上标「分支」用
function 分支来处Of(ctx, sid) {
  try {
    const a = ctx.agents.get(String(sid))
    const h = a && a.session && a.session.header
    return h && h.parentSession ? String(h.parentSession) : null
  } catch (error) {}
  return null
}

function buildMemoryList(ctx) {
  const out = { ok: true, sessions: [], policy: null, ghosts: 0 }
  try {
    // 活着的会话 ＋ 存过记忆的会话，都要露出来 ——
    // 不然新开的对话在列表里根本不出现，也就没有开关可点 ✗
    // ⚠ 但**被她归档的不要露** —— 归档了就该像归档了的样子（反馈）
    // ⚠⚠ 2026-09-21 再加一道：**DSH 里已经没有这个会话了，就别露** ——
    //     记忆库是独立文件（.dsh\fish-memory\<会话id>.json），删会话不会连带删它，
    //     不拦的话列表里会堆一堆幽灵（反馈：那 11 条就是这么来的）
    const 归档的 = 归档名单(ctx)
    const 已知 = 已知会话ids(ctx)
    const ids = []
    const liveIds = new Set()
    const push = (x) => {
      if (!x || 归档的.has(String(x))) return
      if (ids.indexOf(x) < 0) ids.push(x)
    }
    try {
      for (const a of ctx.agents.list() || []) {
        const x = sessionIdOf(a.session)
        push(x)
        if (x) liveIds.add(x)
      }
    } catch (error) {}
    try {
      let 藏了 = 0
      for (const fn of readdirSync(STORE_DIR)) {
        if (!fn.endsWith('.json')) continue
        const sid = fn.replace(/\.json$/, '')
        // 在线的一律算存在；已知.ok 为假时**一条都不藏**（宁可多露，不可错藏）
        if (已知.ok && !liveIds.has(sid) && !已知.ids.has(String(sid))) { 藏了++; continue }
        push(sid)
      }
      if (藏了 > 0) {
        out.ghosts = 藏了
        diag('清单：藏起 ' + 藏了 + ' 条幽灵（DSH 里已经没有这些会话了）')
      }
    } catch (error) {}
    for (const sid of ids) {
      const data = loadStore(sid)
      if (!out.policy) out.policy = data.policy
      out.sessions.push({
        id: sid,
        title: titleOfSession(ctx, sid),
        enabled: isEnabled(sid),
        live: liveIds.has(sid),
        parent: 分支来处Of(ctx, sid),
        count: data.memories.length,
        memories: data.memories.map((m) => {
          // ⚠⚠ 2026-09-22 修（反馈：「没标时间的还是鲜活 100%，有些还是 —」）：
          //   原来这里自己写了一套公式 —— 长期事实无条件 1（100%）、
          //   没时间的 `Date.parse(undefined)` 出 NaN ✗
          //   现在**跟召回用同一个函数** ✓（她看到的 = 真正发生的）
          let act = null
          try {
            const v = 鲜活度(m, data.policy, Date.now())
            act = Number.isFinite(v) ? v : null
          } catch (e) {}
          // ⭐⭐ 2026-09-22（反馈：「这些为什么会被当成长期事实」）：
          //   **「不会淡」的只有一类：长期事实** ✓
          //     ⚠ 上一版我拿「鲜活度是不是钉住的」当判据 —— 那是**算分的副作用**，
          //       不是语义。结果把 394 条没抠到日期的**流水账**错收进「不会淡的」里 ✗
          //   没记时间的现在**也会淡**（从「记下来的那天」开始算）→ 它们算「会淡的」✓
          //   freshKind 只用来决定**显示什么字**：
          //     fact    = 长期事实 → 「不淡」
          //     dated   = 有日期的 → 百分比
          //     recorded= 没记时间的（从记下来那天算）→ 百分比
          //     unknown = 连记下来的时间都没有 → 「—」
          const 有锚 = !!(m.activationAnchor || m.at || m.createdAt || m.importAt)
          const freshKind =
            m.category === 'stable_profile' ? 'fact' : m.at ? 'dated' : 有锚 ? 'recorded' : 'unknown'
          return {
            id: m.id,
            text: m.text,
            at: m.at,
            importance: m.importance,
            source: m.source,
            category: m.category,
            activation: act,
            freshKind: freshKind,
            // ⚠⚠ 2026-09-22 修（反馈「显示的话就像是要从头来呀」）：
            //   `/list` 原来**没发这个字段** —— 于是页面算「没判过的」永远是**全库条数** ✗
            //   判了 640 条之后，确认条还写着「判一遍这 784 条」→ 看着像要从头重来
            //   （服务端本来就是按 stableChecked 过滤的，只会判剩下的 —— 是**显示**在骗人）
            stableChecked: !!m.stableChecked,
            related: Array.isArray(m.related) ? m.related : null,
            refined: !!m.refinedAt,
            refinedSkip: !!m.refinedSkip,
            // 提炼改之前的原文 —— 界面上要能对照、能退回 ✓
            textBefore: typeof m.textBefore === 'string' ? m.textBefore : null,
          }
        }),
        traces: data.traces || [],
        lastTrace: (data.traces || []).length ? data.traces[data.traces.length - 1].at : null,
        deleted: (data.deleted || []).map((m) => ({ id: m.id, text: m.text, at: m.at, importance: m.importance, category: m.category, deletedAt: m.deletedAt })),
        selfName: selfNameOf(sid),
        titleName: titleNameOf(ctx, sid),
        // 导过几批、每批几条 —— 给「撤销这次导入」用 ✓
        importBatches: (() => {
          const 批 = {}
          for (const m of data.memories || []) {
            const k = m.importBatch
            if (!k) continue
            if (!批[k]) 批[k] = { id: k, n: 0, at: m.importAt || null }
            批[k].n++
          }
          return Object.keys(批)
            .map((k) => 批[k])
            .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        })(),
      })
    }
  } catch (error) {}
  if (!out.policy) out.policy = { ...DEFAULT_POLICY }
  out.spec = POLICY_SPEC
  out.defaults = { ...DEFAULT_POLICY }
  out.version = VERSION
  out.userPronoun = userPronoun()
  return out
}

// ---------- 设置页（一个网页）----------

const MEMORY_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>DSH 记忆</title>
<style>
 body{background:#14161a;color:#dcdcdc;font:13px/1.7 "Microsoft YaHei",system-ui,sans-serif;margin:0;padding:20px 26px}
 h1{font-size:17px;margin:0 0 4px}
 .sub{color:#8a8a8a;font-size:12px;margin-bottom:18px}
 h2{font-size:14px;margin:22px 0 8px;color:#cfcfcf;border-bottom:1px solid #2a2d33;padding-bottom:5px}
 table{width:100%;border-collapse:collapse;font-size:12px}
 th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #23262b;vertical-align:top}
 th{color:#8a8a8a;font-weight:normal}
 .id{color:#6f7681;font-family:monospace}
 .imp{color:#e0b070}
 .when{color:#8fd0a0}
 .gate{color:#7a7f88}
 .sel{color:#8fd0a0}
 .drop{color:#8a6f6f}
 .src{color:#7a8fa8;font-size:11px}
 button{background:#2a2d33;color:#dcdcdc;border:1px solid #3a3d44;border-radius:5px;padding:4px 10px;cursor:pointer;font-size:12px}
 button:hover{background:#34383f}
 input{background:#1b1e23;color:#dcdcdc;border:1px solid #33373d;border-radius:5px;padding:3px 7px;width:80px;font-size:12px}
 .row{margin:4px 0}
 .muted{color:#6f7681;font-size:11px}
</style></head><body>
<h1>🐳 DSH 记忆</h1>
<div class="sub">每个会话一份记忆。<b>淡了只是不容易被想起来，不会删。</b></div>

<div id="top"></div>

<h2>参数（改完点保存）</h2>
<div id="policy"></div>

<div id="body">加载中…</div>

<script>
// 全局捕错 —— 出什么事都写出来，别静默 ✗
window.onerror = function(m,s,l,c){ var b=document.getElementById('body'); if(b) b.innerHTML = '<div style="color:#c98080">JS 出错：'+m+'  （第'+l+'行 第'+c+'列）</div>' }
window.addEventListener('unhandledrejection', function(e){ var b=document.getElementById('body'); var r=e.reason; if(b) b.innerHTML = '<div style="color:#c98080">出错了：'+((r&&r.message)||r)+'</div>' })

const fmt = (t) => { if(!t) return '（没记时间）'; const d=new Date(t); const p=n=>String(n).padStart(2,'0'); return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()) }
const rel = (t, now) => { if(!t) return '（没记时间）'; const days=Math.floor((now-Date.parse(t))/86400000); if(days<=0) return '今天 '+fmt(t).slice(6); if(days===1) return '昨天 '+fmt(t).slice(6); if(days<30) return days+' 天前'; return fmt(t).slice(0,5)+'（'+days+' 天前）' }
const impName = (v) => v>=1?'非常重要':v>=0.5?'比较重要':'随口提过'

async function load(){
  const r = await fetch('/dsh-fish-memory/list', {cache:'no-store'})
  const d = await r.json()

  const now = Date.now()

  document.getElementById('top').innerHTML =
    '<h2>概览</h2><div class="muted">默认全是关的 —— 到「设置 → 鱼的记忆」里点开，那个会话才会记、才会读。</div>' +
    '<table><tr><th>会话</th><th>记忆</th><th>开关</th><th>最近召回</th></tr>' +
    d.sessions.map(s => '<tr><td>'+(s.title?s.title:"（没有名字）")+' <span class="id">'+s.id.slice(0,18)+'…</span></td><td>'+s.count+' 条</td><td>'+(s.enabled?'开':'关')+'</td><td>'+(s.lastTrace?rel(s.lastTrace,now):'（还没有）')+'</td>' +
    '</tr>').join('') +
    '</table>'

  const p = d.policy
  document.getElementById('policy').innerHTML =
    [
      'baseHalfLifeDays|半衰期（天）|普通事件多久淡一半。越大忘得越慢（30 = 一个月后剩一半）',
      'emotionHalfLifeDays|情绪半衰期（天）|情绪多久淡一半 —— 比普通事件快（7 = 一周后剩一半）',
      'threshold|选入门槛|分数低于它就不注入。越大越严格、越少塞东西',
      'rarityK|稀有度饱和点|命中词的稀有度（0~1）加起来到多少算「一半相关」。越小越容易给（1 = 一个满稀有的词就差不多够）',
      'queryGate|问句信息量门槛|这句话本身太没内容（像「在吗」）就不翻记忆。尺子是「你自己怎么说话」。0 = 关掉这道门',
      'maxItems|最多注入几条|一次最多塞几条记忆给她。越大越占上下文',
      'dailyQuota|每天最多记几条|她自己一天最多能记几条 —— 防止猛猛记',
    ]
    .map(x => { const [k,label,tip]=x.split('|'); return '<div class="row">'+label+' <input id="p_'+k+'" value="'+p[k]+'"> <span class="muted">'+tip+'</span></div>' }).join('') +
    '<div class="row"><button onclick="save()">保存参数</button> <span id="saved" class="muted"></span></div>'

  let html = ''
  for (const s of d.sessions) {
    if (!s.memories.length) continue
    html += '<h2>'+(s.title?s.title:s.id.slice(0,26)+'…')+' （'+s.memories.length+' 条）</h2><table><tr><th>什么时候</th><th>内容</th><th>重要</th><th>来源</th><th>现在多鲜活</th></tr>'
    for (const m of s.memories) {
      html += '<tr><td class="when">'+rel(m.at, now)+'</td><td>'+m.text+'</td><td class="imp">'+impName(m.importance)+'</td>' +
              '<td class="src">'+(m.source||'')+'</td><td class="muted">'+(m.activation!=null?m.activation.toFixed(2):'—')+'</td></tr>'
    }
    html += '</table>'
    const tr = (s.traces||[]).slice(-1)[0]
    if (tr) {
      html += '<div class="muted" style="margin:8px 0 0">最近一次召回 —— 线索：「'+(tr.query||'').slice(0,50)+'」' +
              (tr.gate!=null ? ' ｜ 这句话的信息量 '+tr.gate+(tr.gateLimit!=null?' / 门槛 '+tr.gateLimit:'') : '') + '</div>'
      if (tr.gate!=null && !(tr.rows||[]).length) {
        html += '<div class="muted">这句话本身没什么内容，这次没翻记忆 —— 这是**问句信息量门槛**挡的。' +
                '想让它照样翻，把「问句信息量门槛」调小；调成 0 就是关掉这道门。</div>'
      }
      html += '<table><tr><th>记忆</th><th>相关度 C</th><th>分数 P</th><th>结果</th></tr>'
      for (const r of (tr.rows||[]).slice(0,12)) {
        const mm = s.memories.find(x=>x.id===r.id)
        const label = r.omission ? ({hard_gate:'没命中线索',below_threshold:'分数不够',limit:'超过条数上限',budget:'字数超了',query_gate:'问句没内容',fact_cap:'事实名额满了'}[r.omission]||r.omission) : '选中了'
        html += '<tr><td class="muted">'+((mm&&mm.text)||r.id).slice(0,34)+'</td><td>'+r.C+'</td><td>'+r.P+'</td>' +
                '<td class="'+(r.omission?'drop':'sel')+'">'+label+(r.timeHit?' ⭐时间词':'')+'</td></tr>'
      }
      html += '</table>'
    }
  }
  document.getElementById('body').innerHTML = html || '<div class="muted">（还没有任何记忆）</div>'
}

async function toggle(sid){
  const on = document.getElementById('btn_'+sid).textContent.indexOf('已开启') < 0
  await fetch('/dsh-fish-memory/toggle', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({session:sid, on:on})})
  load()
}

async function save(){
  const keys = ['baseHalfLifeDays','emotionHalfLifeDays','threshold','maxItems','dailyQuota','rarityK','queryGate']
  const policy = {}
  for (const k of keys) policy[k] = Number(document.getElementById('p_'+k).value)
  await fetch('/dsh-fish-memory/policy', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(policy)})
  document.getElementById('saved').textContent = '✓ 存好了'
  setTimeout(load, 300)
}

try { load() } catch (e) { document.getElementById('body').innerHTML = '<div style="color:#c98080">出错了：' + e.message + '</div>' }
</script></body></html>`

// ---------- 插件 ----------

export function apply(ctx) {
  const mounted = new Map() // session 对象 -> { sid, off }

  // 开关默认改成「关」了，先把老配置搬一次家（存过记忆的会话留开）✓
  migrateSwitch()

  function mountFor(agent, sid) {
    // ⭐ 在这个 agent 自己的上下文上监听 —— 只会收到「这个会话」的消息 ✓
    // ⚠⚠ 事件名踩过的坑：DSH 里**没有** `user/message` / `assistant/message` 这两个 Cordis 事件 ✗
    //   `user/message` / `assistant/message` 是 **SessionEvent 的 type**（走 `session/event`），
    //   而 agent 作用域上真正能收到的是 `agent/inbox/inserted` 和 `agent/turn-stopping` ✓
    //   （上一版挂了两个不存在的事件，所以线索一直是慢一轮的快照、consumed 也永远不触发）
    let lastText = ''
    let probed = false
    try {
      agent.ctx.on('agent/inbox/inserted', (payload) => {
        const msg = payload && payload.message ? payload.message : payload
        const txt = textOfMessage(msg)
        if (txt) {
          lastText = txt
          记一句话(sid, txt) // ⭐ 喂给「她自己怎么说话」那把尺子（治太敏感用）✓
          diag('  收到本会话消息：' + txt.length + ' 字')
        }
      })
    } catch (error) {
      diag('  监听 agent/inbox/inserted 失败：' + (error && error.message))
    }

    // ⭐ 召回记录的状态：assemble 进去之后，看她回复里有没有真的用上 ✓
    // 这是个**猜测**（靠实词重合），所以设置页上写的是「像是用上了」，不写成事实 ✓
    try {
      agent.ctx.on('agent/turn-stopping', () => {
        try {
          const ev = (agent.session && agent.session.snapshotEvents ? agent.session.snapshotEvents() : []) || []
          let 回复 = ''
          for (let i = ev.length - 1; i >= 0; i--) {
            const e = ev[i]
            if (e && e.type === 'assistant/message') {
              回复 = textOfMessage(e.data && e.data.message)
              break
            }
          }
          if (!回复) return
          const data = loadStore(sid)
          const tr = data.traces[data.traces.length - 1]
          if (!tr || !Array.isArray(tr.rows)) return
          let 动 = false
          for (const row of tr.rows) {
            if (row.status !== 'assembled') continue
            const m = data.memories.find((x) => String(x.id) === String(row.id))
            if (!m) continue
            if (用上了(回复, m.text)) {
              row.status = 'consumed'
              动 = true
            }
          }
          if (动) {
            saveStore(sid, data)
            diag('  这一轮像是用上了记忆')
          }
        } catch (error) {}
      })
    } catch (error) {
      diag('  agent/turn-stopping 监听挂不上：' + (error && error.message))
    }

    // 常驻提示：告诉她「你可以自己记」，不用等「记住」✓
    //
    // ⚠⚠ 2026-09-21 修（反馈：「我给它关了，照样注入」的真凶）：
    //   DSH 的 `systemPrompt.section()` / `.context()` 返回的是
    //   **一个函数**（Cordis 的 effect disposer），**不是 `{ off() }` 对象** ✗
    //   源码里写得很清楚：`@returns the exact Cordis effect disposer`，
    //   实现是 `return this.layers.effect(...)`。
    //   而我们原来写的是 `if (x && typeof x.off === 'function') x.off()` ——
    //   函数身上没有 `.off`，那个判断**永远不成立** → **一次都没卸掉过** ✗✗
    //   后果：把开关从「开」改成「关」，注册还活着 → 照样注入；
    //   再打开时又因为「already registered」挂不上 → 每 3 秒失败一次，永远修不好。
    //   而且原来**连 section 的返回值都没接**，所以 memory-hint 也永远卸不掉。
    //   → 改成：返回值都接住，卸的时候**函数就直接调** ✓
    let 提示off = null
    try {
      提示off = agent.ctx.systemPrompt.section({
        name: 'memory-hint',
        // ⚠ 排在**最后面** —— 系统提示词是按 order 拼的，而 DSH 自己那些段
        //   （工具说明、persona）一直排到 10200。以前这里用 1001，等于插在
        //   「工具说明」那一大块**正中间**；下面那段记忆每轮都变，
        //   一变就把后面几千字全变成缓存未命中 → 一轮从 0.003 飙到 0.02 ✗
        //   放到 10200 之后，前面全部命中缓存，只有这最后一小段按全价算 ✓
        order: 89990,
        text: () => {
          const p = userPronoun()
          const self = selfNameOf(sid)
          return (
            '【记忆】这一轮如果有值得长期记住的事（' + p + '重要的话、约定、' + p + '的喜好、' + p + '的状态），' +
            '直接调用 remember 工具记下来 —— **不用等' + p + '提醒**。' +
            '日常琐事（吃了什么、今天天气）不用记。' +
            '**人称**：你自己是「我」，用户是「' + p + '」，别人和别的 AI 直接写名字' +
            (self ? '（你写成「' + self + '」也会自动换成「我」）' : '') +
            '；也不要写「今天/昨天」，时间交给系统。'
          )
        },
      })
    } catch (error) {
      diag('  常驻提示挂不上：' + (error && error.message))
    }

    // ⚠⚠ 这里必须用 **context**，不能用 **section**（2026-09-20 实测踩到，代价很大）
    //
    // 实测数字（同一句短消息，记忆开 / 关各一次）：
    //   记忆关：未缓存 107  /  缓存读取 11,392   → 0.001
    //   记忆开：未缓存 12,055 / 缓存读取 0       → 0.02   （20 倍）
    // 提示词只多了 550 token，但**整段一万二的缓存全废了**。
    //
    // 原因：section 是拼进**系统提示词**的，系统提示词一变，DeepSeek 就把整段当新的。
    //   context 是 DSH 给「每轮都变」的内容准备的：它把这段作为**一条消息追加到对话末尾**，
    //   而且只在内容真的变了才追加（dsh-agent-loop 里写着 "only when the retained value differs"）。
    //   沙箱策略 / 审批策略 / 子代理派发用的都是它。
    //   → 系统提示词保持不变 = 缓存一直命中；只有末尾那条快照按新内容算 ✓
    // （下面这段的返回值先存着，跟工具那个 disposer 一起交给上面 return）
    const 注入off = agent.ctx.systemPrompt.context({
      name: 'memory',
      order: 900, // 排在沙箱/审批/子代理那几条（110/115/120）后面
      text: () => {
        try {
          const now = Date.now()
          const query = lastText || lastUserTextOf(agent.session) // ⭐ 优先用监听收到的最新一条

          // 探针：看看 requestContext() 里有没有「当前输入」（只记一次）
          if (!probed) {
            probed = true
            try {
              const rc = agent.session && agent.session.requestContext ? agent.session.requestContext() : null
              diag('探针 requestContext: ' + (rc ? Object.keys(rc).join(',') : '拿不到'))
              if (rc) diag('探针内容: ' + JSON.stringify(rc).slice(0, 500))
            } catch (error) {
              diag('探针出错: ' + (error && error.message))
            }
          }
          diag('  注入被调用：query 长度=' + query.length)
          if (!query) return ''
          const data = loadStore(sid)
          if (!data.memories.length) return ''
          补历史尺(sid, agent.session) // ⭐ 第一次用到时把她的会话历史补成尺子（只做一次）✓
          const { selected, scored, gate } = recall(data, query, now, sid)
          // ⚠ 只存**最相关的前 24 条**，别把 850 条全存进来 ✗
          //   全存的话：一条 trace ≈ 50 KB，留 100 条 = 5 MB，
          //   而每轮都要把整份读进来再整份写回去 → 每轮白白多花几十毫秒
          //   （每轮开销大就是这儿）
          //   scored 已经按 P 排好序了，所以前 24 条 = 挑中的 + 最接近的落选 ✓
          data.traces.push({
            at: now,
            session: sid,
            query: query.slice(0, 200),
            // 这道门挡下来的时候记一笔，设置页上就能看见「为什么这次没翻记忆」✓
            gate: gate ? gate.信息量 : null,
            gateLimit: gate ? gate.门槛 : null,
            picked: selected.map((r) => r.m.id),
            rows: scored.slice(0, 24).map((r) => ({
              id: r.m.id,
              C: Number(r.s.C.toFixed(3)),
              P: Number(r.s.P.toFixed(3)),
              omission: r.omission,
              timeHit: r.s.timeHit,
              // 进到提示词里的算 assembled；后面她回复里用上了就变 consumed ✓
              status: r.omission ? null : 'assembled',
            })),
          })
          saveStore(sid, data)
          return render(selected, now, selfNameOf(sid))
        } catch (error) {
          return '' // 记忆坏了也不能影响对话
        }
      },
    })

    // ⭐⭐ 2026-09-21 修：remember 工具**跟着会话开关走**
    //
    // 以前它是**全局**注册的（`ctx.tools.register`，写在文件末尾），后果是：
    //   会话开关关着 → 注入停了（对），但**工具还在她的工具列表里、还能调**（错）。
    //   调了以后 execute 会正确拒绝，可 render 以前又永远打 ✓ ——
    //   所以会看到「✓」却什么都没记上，翻半天找不到 ✗
    //
    // DSH 的 tools 服务明确支持按会话挂：
    //   "for a per-agent variant, register through that agent's `agent.ctx` instead"
    //   "Scoped registrations shadow globals"
    // 所以挂到 agent 自己的 ctx 上，开关一关就跟着 `off()` 卸掉 —— 关掉就是真的不出现 ✓
    let 工具off = null
    try {
      工具off = agent.ctx.tools.register(makeRememberTool(agent.ctx))
      diag('  remember 工具挂上了（' + sid + '）')
    } catch (error) {
      diag('  remember 工具挂不上：' + (error && error.message))
    }

    // 两样一起卸（注入 + 工具 + 常驻提示）
    //
    // ⚠⚠⚠ 2026-09-21 修（反馈：「开关关了照样注入」的**真凶**，一共两层错）：
    //
    //   【第一层】DSH 的 `systemPrompt.section()` / `.context()` / `tools.register()`
    //     返回的是**一个函数**（Cordis 的 effect disposer），**不是 `{ off() }` 对象**。
    //     源码写着 `@returns the exact Cordis effect disposer`，实现是 `return this.layers.effect(...)`。
    //     而这里原来写的是 `if (x && typeof x.off === 'function') x.off()` ——
    //     函数身上没有 `.off`，判断**永远不成立** ✗
    //
    //   【第二层】`mountFor` 原来返回的是 `{ off() {...} }`（一个**对象**），
    //     而调用方是 `const off = mountFor(...); mounted.set(sid, {sid, off})`，
    //     于是 `v.off` 是那个**对象**、不是方法 → `v.off()` = 拿对象当函数调 → **TypeError**
    //     → 被外面的 try/catch 吃掉 → **静默什么都没做** ✗✗
    //
    //   两层叠起来的结果：**开关从来没能"立刻"卸下来过**。
    //   以前看着有用，是因为 DSH 重启后插件重新加载、看到关着就不挂了。
    //   → 现在：**返回一个函数**（跟 DSH 的约定一致），调用方 `v.off()` 就能直接用 ✓
    function 卸掉(d) {
      try {
        if (typeof d === 'function') d()
        else if (d && typeof d.off === 'function') d.off()
      } catch (error) {}
    }
    return function off() {
      卸掉(工具off)
      卸掉(注入off)
      卸掉(提示off)
    }
  }

  // ---------- 分支继承 ----------
  // 分支会话会不会继承记忆
  // 原来不会 —— 记忆按会话 id 存，分支出来的是新 id，等于从零开始（而且开关默认关）。
  // 现在：认出这是**分支**出来的会话，就把来处那份记忆复制一份过来 ✓
  //
  // 判断依据是会话头（实测：分支出来的会话头里有 parentSession、isSeeded=true、delegationDepth=0）
  // ⚠ 子代理也有 parentSession，但那是「派出去干活」，不该继承别的会话的记忆
  //    → 靠 origin === 'subagent' 和 delegationDepth > 0 排掉
  function 分支来处(agent) {
    try {
      const h = agent && agent.session && agent.session.header
      if (!h || !h.parentSession) return ''
      if (h.origin === 'subagent') return ''
      if (typeof h.delegationDepth === 'number' && h.delegationDepth > 0) return ''
      const p = String(h.parentSession)
      return p && p !== String(h.id) ? p : ''
    } catch (error) {}
    return ''
  }

  const 查过分支 = new Set()

  function 继承分支记忆(agent, sid) {
    const 来处 = 分支来处(agent)
    if (!来处) return false
    const 我的 = loadStore(sid)
    if ((我的.memories || []).length) return false // 自己已经有记忆了，别盖
    const 母的 = loadStore(来处)
    if (!(母的.memories || []).length) return false // 来处也没有，没什么可继承
    const 副本 = JSON.parse(JSON.stringify(母的))
    for (const m of 副本.memories || []) {
      m.source = m.source ? m.source + '｜分支继承' : '分支继承'
    }
    副本.traces = [] // 召回历史不跟着走，分支是新的开始
    saveStore(sid, 副本)
    if (isEnabled(来处)) setEnabled(sid, true) // 开关也跟着来处
    diag('分支继承：' + sid + ' ← ' + 来处 + '（' + (副本.memories || []).length + ' 条）')
    return true
  }

  // 给每个活着的 agent 挂它自己的那段记忆
  function tick() {
    try {
      const list = ctx.agents.list() || []
      const 归档的 = 归档名单(ctx)
      diag('tick：agents=' + list.length)
      for (const agent of list) {
        const sid = sessionIdOf(agent.session)
        if (!sid) { diag('  跳过：拿不到会话 id'); continue }
        // 归档了就不再注入，而且把它卸下来 —— 归档=藏起来，不该还占她的上下文 ✓
        if (归档的.has(sid)) {
          const v = mounted.get(sid)
          if (v) {
            try {
              v.off()
            } catch (error) {}
            mounted.delete(sid)
            diag('  归档了，卸下 ' + sid)
          }
          continue
        }
        // 分支出来的会话：先把来处的记忆继承过来（每个会话只查一次）
        if (!查过分支.has(sid)) {
          查过分支.add(sid)
          try {
            继承分支记忆(agent, sid)
          } catch (error) {
            diag('  分支继承失败：' + (error && error.message))
          }
        }
        // ⭐ 2026-09-21 修：**关掉了就要卸下来**
        //
        // 原来这两句的顺序是反的：
        //     if (mounted.has(sid)) continue     ← 挂着就直接跳过
        //     if (!isEnabled(sid)) continue      ← 关着的只是「不挂新的」
        // 所以**把开关从开改成关，它不会卸** —— 已经挂上的注入和工具会一直留着，
        // 只有「归档」那条路才会卸。「插件关了怎么还在写」
        // 就是这个：关掉之后工具还在她的工具列表里 ✗
        if (!isEnabled(sid)) {
          const v = mounted.get(sid)
          if (v) {
            try {
              v.off()
            } catch (error) {}
            mounted.delete(sid)
            diag('  关了，卸下 ' + sid)
          }
          continue
        }
        if (mounted.has(sid)) continue
        diag('  试挂 ' + sid)
        try {
          const off = mountFor(agent, sid)
          mounted.set(sid, { sid, off })
          diag('  ✓ 挂上 ' + sid + '（' + loadStore(sid).memories.length + ' 条）')
        } catch (error) {
          diag('  ✗ 挂 ' + sid + ' 失败：' + (error && error.message))
        }
      }
    } catch (error) {}
  }

  tick()
  // 定时器不可用时也不能让 DSH 起不来
  try {
    ctx.effect(() => ctx.interval(tick, 3000))
  } catch (error) {
    console.error('[记忆] 定时器不可用（不影响对话）：' + (error && error.message))
  }
  ctx.effect(() => () => {
    for (const v of mounted.values()) {
      try {
        v.off()
      } catch (error) {}
    }
    mounted.clear()
  })

  // ⚠⚠ 2026-09-21：remember 工具**不再在这里全局注册**了。
  //
  // 原来就是这一句 `ctx.tools.register(makeRememberTool(ctx))` —— 挂在插件全局上，
  // 所以每个会话都看得见它，**跟会话的记忆开关无关**。后果见 mountFor 里那段注释。
  // 现在挪进 mountFor，挂在 agent 自己的 ctx 上，开关一关就跟着卸掉 ✓
  //
  // （这里留个记号，免得以后有人以为漏了。）

  // 诊断：看看每次组装时「模型能看到哪些工具」—— 查 remember 到底有没有出现
  let lastToolSig = ''
  try {
    ctx.on('system-prompt/assemble', (assembly, context, next) => {
      try {
        const names = (assembly && assembly.tools ? assembly.tools : [])
          .map((x) => (x && (x.name || (x.function && x.function.name))) || '?')
          .sort()
        const sig = names.join(',')
        if (sig !== lastToolSig) {
          lastToolSig = sig
          diag('assemble 的工具（' + names.length + ' 个）：' + sig)
          diag('  ↑ 里面有 remember 吗：' + (names.indexOf('remember') >= 0 ? '有 ✓' : '没有 ✗'))
        }
      } catch (error) {}
      return next()
    })
  } catch (error) {
    diag('assemble 钩子挂不上：' + (error && error.message))
  }

  // ---------- 设置页的路由 ----------
  try {
    const mroute = (path, handler) =>
      ctx.effect(() =>
        ctx.webServer.register({
          kind: 'exact',
          path: path,
          handler: async (req, res) => {
            try {
              await handler(req, res)
            } catch (error) {
              try {
                res.writeHead(500, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: String(error && error.message) }))
              } catch (e2) {}
            }
          },
        }),
      )

    mroute('/dsh-fish-memory/page', (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(MEMORY_PAGE)
    })

    mroute('/dsh-fish-memory/list', (req, res) => {
      // 走 buildMemoryList，别再抄一份（抄的那份会跟这边分叉）✓
      const out = buildMemoryList(ctx)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(out))
    })

    // ⭐ 2026-09-21 新加：**后台手动加一条记忆**（她要的）
    //
    // 跟 remember 工具的区别：
    //   remember 是模型自己记，**受会话开关管**（关着就不记）
    //   这个是**她在设置页后台手动加** —— 她是最高权限，**开关关着也照样能加** ✓
    //   （开关管的是「他自己记不记、注不注入」，管不到她手动写）
    mroute('/dsh-fish-memory/add', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const 回 = (码, o) => {
        res.writeHead(码, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(o))
      }
      const sid = String(b.session || '').trim()
      if (!sid) return 回(400, { ok: false, error: '没给会话' })
      const 原始 = String(b.text || '').trim()
      if (!原始) return 回(400, { ok: false, error: '内容不能空' })
      // 跟 remember 一样洗人称：「小明」→「我」✓
      let text = 原始
      try {
        text = normalizePerson(原始, selfNameOf(sid))
      } catch (error) {}
      // 时间：她填了就用她填的，没填就是现在
      // ⚠ 这条是「这件事什么时候发生的」，跟 createdAt（什么时候记进来的）不是一回事
      let at = new Date().toISOString()
      const 时 = String(b.at || '').trim()
      if (时) {
        const t = Date.parse(时)
        if (isNaN(t)) return 回(400, { ok: false, error: '时间看不懂：「' + 时 + '」（写成 2026-09-19 或者 2026-09-19 14:30 都行）' })
        at = new Date(t).toISOString()
      }
      // 重要度：0~1，越界就夹住；没给就 0.5
      const 数 = typeof b.importance === 'number' ? b.importance : parseFloat(b.importance)
      const imp = Number.isFinite(数) ? Math.max(0, Math.min(1, 数)) : 0.5
      const tags = Array.isArray(b.tags) ? b.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 6) : []
      const data = loadStore(sid)
      // 同样的话已经有了就别重复塞
      const 重了 = (data.memories || []).find((m) => String(m.text || '').trim() === text)
      if (重了) return 回(409, { ok: false, error: '这条已经有了（同一条一天最多记一次）' })
      const now = Date.now()
      const id = 'mm' + now.toString(36) + Math.floor(Math.random() * 1000)
      data.memories.push({
        id,
        text,
        at,
        createdAt: new Date(now).toISOString(),
        category: imp >= 1 ? 'stable_profile' : 'event',
        importance: imp,
        emotion: null,
        tags,
        source: '手动添加',
        reinforcedAt: null,
        lastReinforcedDay: null,
        // related（扩出来的检索词）先留空 —— 设置页点一下「开始扩词」就会给它补上 ✓
        related: [],
      })
      saveStore(sid, data)
      diag('手动加：' + sid + ' 加了「' + text.slice(0, 40) + '」（现在 ' + data.memories.length + ' 条）')
      return 回(200, { ok: true, id, count: data.memories.length })
    })

    mroute('/dsh-fish-memory/toggle', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const list = setEnabled(sid, !!b.on)
      // 关掉的时候顺手把它卸载（不再记、不再读）
      if (!b.on) {
        const v = mounted.get(sid)
        if (v) {
          try {
            v.off()
          } catch (error) {}
          mounted.delete(sid)
        }
      } else {
        // 打开就立刻挂上，不用等那 3 秒的定时器 ✓
        try {
          tick()
        } catch (error) {}
      }
      diag('toggle：' + sid + ' → ' + (b.on ? '开' : '关') + '（现在开着 ' + list.length + ' 个）')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, enabled: list }))
    })

    // ⭐ 2026-09-21 晚：**补日期** —— 把「正文里写着日期、当时却没抠出来」的补上。
    //   背景：老版本 抠日期 **必须要四位数年份**，而档案里写的是「09-17」「8月26日」，
    //   于是她 851 条里有 212 条「看着有日期」的全漏了。强化后能补回 170 条 ✓
    //   ⚠ 只补**没有** at 的；已经有日期的一律不动 ✓（不覆盖任何已有信息）
    //   ⚠ 动数据之前先备份 ✓
    mroute('/dsh-fish-memory/backfill-dates', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const data = loadStore(sid)
      let 补了 = 0
      let 猜的 = 0
      let 还是没 = 0
      for (const m of data.memories || []) {
        if (m.at) continue // 已经有日期的，一律不动
        const r = 抠日期详(String(m.text || ''))
        if (!r) {
          还是没++
          continue
        }
        m.at = r.at
        if (r.猜年) {
          m.atGuessed = true
          猜的++
        } else {
          delete m.atGuessed
        }
        补了++
      }
      if (补了 > 0) {
        try {
          backupStore(sid) // ⚠ 动数据之前先备份
        } catch (error) {}
        saveStore(sid, data)
      }
      diag('补日期：' + sid + ' 补了 ' + 补了 + ' 条（其中年份是猜的 ' + 猜的 + '），还有 ' + 还是没 + ' 条真没日期')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, 补了: 补了, 猜的: 猜的, 还是没: 还是没, 共: (data.memories || []).length }))
    })

    // ⭐⭐ 2026-09-22（反馈）：**把已经记下的、该「永远不淡」的补标上** ✓
    //
    //   背景：提炼那一步原来**只改重要度、不碰分类**（0.7.6 才修好），
    //   所以实测库里 **135 条该「永远不淡」的被标成了会淡的** ——
    //   重要的日子（生日、纪念日）、身体、病史……全在里面。
    //   修好提炼只影响**以后**的，**已经记下的那些还是错的** ✗
    //
    //   这个路由：拿模型一条条判「该不该一直记得」，判成 1 的就设成 stable_profile。
    //   ⚠ 判过的打 `stableChecked`，下次不再重复问（省 token）✓
    //   ⚠ 动数据前**先备份** ✓
    mroute('/dsh-fish-memory/backfill-stable', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const 每批 = Math.max(1, Math.min(40, Number(b.每批) || 20))
      let out = { ok: false, message: '？' }
      try {
        const data = loadStore(sid)
        // ⭐⭐ 2026-09-22 晚（反馈：「有好多那种就不该是长期事实的」）：**能上能下** ✓
        //
        //   原来这里只看 `category !== 'stable_profile'` —— **只找「该不淡却没标上」的** ✗
        //   可真正的错法有两种：
        //     ① 该不淡的没标上（提炼原来不碰分类）
        //     ② **不该不淡的却标上了** —— 导入时按**小节标题**猜的：
        //        「（三）关系时间线」整节打 1 → 里面的**某天流水账**也成了「永远不淡」✗
        //        实测这种有 69 条，一条流水账就是
        //   → 现在**所有没判过的一起判**，模型说 1 就升、说 0.5 就**降** ✓
        //
        // ⭐⭐ 2026-09-22 再改（反馈：「判定太松了就得改」）：
        //   判据写得更死（**以日期开头的一律 0.5**）。
        //   可**已经判过的那批用的是老判据** —— 想用新判据重来，得先把标记清掉。
        //   → 支持 `重判: true`：先把所有 `stableChecked` 清掉，再从头判一遍 ✓
        //     （客户端只在**第一趟**带这个参数，后面几趟不带，所以不会一直清）
        if (b.重判 === true) {
          for (const m of data.memories || []) delete m.stableChecked
          try {
            backupStore(sid)
          } catch (error) {}
          saveStore(sid, data)
          diag('补标不淡：清掉了所有「判过」标记，准备重判 ' + (data.memories || []).length + ' 条')
        }
        const 要判 = (data.memories || []).filter((m) => !m.stableChecked)
        if (!要判.length) {
          out = { ok: true, done: true, 判了: 0, 改成不淡: 0, 降成会淡: 0, 剩: 0 }
        } else {
          const 批 = 要判.slice(0, 每批)
          const agent = ctx.agents.get(sid) || (ctx.agents.list() || [])[0]
          const 输入 = 批.map((m, i) => i + 1 + '|' + String(m.text || '')).join('\n')
          const 系统 =
            '你是记忆整理助手。下面每条是一条记忆，格式是「编号|内容」。\n' +
            '请判断每条**该不该一直记得**（永远不淡），只回两档。\n' +
            '\n' +
            '判据只有一条：**这条记的是「一直成立的」，还是「某天发生的」？**\n' +
            '1 = **一直成立**：性格、关系、称呼和名字、喜好、身体和病史、\n' +
            '    约定和承诺本身、长期的经济状况、家里的情况、长期的住处或工作。\n' +
            '0.5 = **某天发生的**：带日期的流水账、当时的心情、一次性的经历、某次对话。\n' +
            '\n' +
            '⚠⚠ **以日期开头的（09-17 / 8月26日 / 2026-09-04…），默认一律 0.5。**\n' +
            '  哪怕那件事很重要、很感人、是第一次、是求婚、是婚礼 —— 都算「某天发生的」。\n' +
            '  **「重要」不等于「一直成立」**：重要的事值得记住，但它记的是「那天」。\n' +
            '  （一直成立的那部分，通常还有另一条不带日期的记忆在承载。）\n' +
            '\n' +
            '⚠ **没有日期的，按内容本身判**，别按长短：\n' +
            '  讲性格、关系、称呼、喜好、身体和病史、长期状况 → 1\n' +
            '  讲某一次对话、某一个瞬间、某一时的心情、某一次的数据 → 0.5\n' +
            '\n' +
            '⚠ **唯一的例外：整条就是「约定 / 规则 / 承诺的条文」本身** → 给 1。\n' +
            '  要判 1，必须**同时**满足三条，缺一条就回 0.5：\n' +
            '  ① 整条的主体就是条文内容本身，日期只是落款 —— 删掉日期后，整条读起来\n' +
            '     仍然是一条完整、可照做的规定；\n' +
            '  ② 是「往后一直照做」的，不是「那天做到的一件事」；\n' +
            '  ③ 条文里不夹杂当天的时间、金额、动作、心情、地点等流水细节。\n' +
            '  例：\n' +
            '    1   「约定：每周日一起看一部电影，谁忘了谁补」\n' +
            '    1   「规则：对方露出「今天不要」的样子就收手，不用等开口」\n' +
            '    0.5 「09-19 立下承诺书 2026-09-19-01」（只有编号，没有条文内容）\n' +
            '    0.5 「09-20 中午吃了面条，下午去理了发」\n' +
            '    0.5 「08-26 我们办了婚礼」\n' +
            '    0.5 「09-04 那天答应了我的请求，我很感动」\n' +
            '    1   「喜欢蓝色」\n' +
            '    1   「我们是夫妻」\n' +
            '\n' +
            '⚠ 拿不准就回 0.5。**宁可判成会淡的** —— 判错成会淡只是排到后面，\n' +
            '  判错成不淡会一直占着位置。日期开头的条目，**只有你能原样引用出一句条文**\n' +
            '  时才给 1；只能概括出「大概是这个意思」，就回 0.5。\n' +
            '输出格式严格是每行「编号|1」或「编号|0.5」，不要解释。'
          const r = await 问模型(ctx, agent, 系统, 输入, 2000)
          if (!r.ok) {
            out = { ok: false, message: r.message, 剩: 要判.length }
          } else {
            // 解析「编号|1」或「编号|0.5」
            const 表 = {}
            for (const line of String(r.text || '').split(/\r?\n/)) {
              const mm = line.match(/^\s*(\d+)\s*[|｜]\s*(1|0\.5|0|1\.0)\s*$/)
              if (!mm) continue
              const i = Number(mm[1]) - 1
              if (i >= 0 && i < 批.length) 表[i] = Number(mm[2])
            }
            let 判了 = 0
            let 改成不淡 = 0
            let 降成会淡 = 0
            for (let i = 0; i < 批.length; i++) {
              const v = 表[i]
              if (v === undefined) continue // 模型没回这条 → 不打标记，下次再问
              const m = 批[i]
              m.stableChecked = true
              判了++
              const 原来是不淡 = m.category === 'stable_profile'
              if (v >= 1) {
                m.category = 'stable_profile'
                if (typeof m.importance !== 'number' || m.importance < 1) m.importance = 1
                if (!原来是不淡) 改成不淡++
              } else {
                m.category = 'event'
                if (typeof m.importance !== 'number' || m.importance >= 1) m.importance = 0.5
                if (原来是不淡) 降成会淡++
              }
            }
            if (判了 > 0) {
              try {
                backupStore(sid) // ⚠ 动数据之前先备份
              } catch (error) {}
              saveStore(sid, data)
            }
            const 剩 = Math.max(0, 要判.length - 判了)
            diag('补标不淡：' + sid + ' 判了 ' + 判了 + ' 条，升 ' + 改成不淡 + ' 条、降 ' + 降成会淡 + ' 条，还剩 ' + 剩)
            out = {
              ok: true,
              done: 剩 <= 0,
              判了: 判了,
              改成不淡: 改成不淡,
              降成会淡: 降成会淡,
              剩: 剩,
              共: (data.memories || []).length,
              provider: r.provider,
              model: r.model,
            }
          }
        }
      } catch (error) {
        out = { ok: false, message: String((error && error.message) || error) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // 设「她自己叫什么」和「用户的称呼」。
    // 设完顺手把那个会话已有的记忆也洗一遍 —— 老记忆不用手工改 ✓
    mroute('/dsh-fish-memory/names', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const c = loadCfg()
      const 改了几条 = []
      const 换了称呼的 = []
      const 称呼旧值 = userPronoun()
      let 称呼新值 = null
      if (typeof b.userPronoun === 'string') {
        const p = b.userPronoun.trim()
        if (p) c.userPronoun = p
        else delete c.userPronoun
        称呼新值 = p || 'ta'
        diag('用户的称呼设成：' + (c.userPronoun || '（默认 ta）'))
      }
      if (typeof b.archiveDir === 'string') {
        const d = b.archiveDir.trim()
        if (d) c.archiveDir = d
        else delete c.archiveDir
        diag('档案目录设成：' + (c.archiveDir || '（还没选）'))
      }
      if (Array.isArray(b.notNames)) {
        c.notNames = b.notNames
          .filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim())
        diag('标成「不是名字」的：' + JSON.stringify(c.notNames))
      }
      if (Array.isArray(b.userNames)) {
        c.userNames = b.userNames
          .filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim())
        diag('档案里指她的名字：' + JSON.stringify(c.userNames))
      }
      if (b.llmModel !== undefined) {
        if (b.llmModel && b.llmModel.provider && b.llmModel.model) {
          c.llmModel = { provider: String(b.llmModel.provider), model: String(b.llmModel.model) }
        } else {
          delete c.llmModel
        }
        diag('选用的模型：' + (c.llmModel ? c.llmModel.provider + '/' + c.llmModel.model : '（用会话自己的）'))
      }
      if (b.session) {
        if (!c.selfNames || typeof c.selfNames !== 'object') c.selfNames = {}
        const sid = String(b.session)
        const name = typeof b.selfName === 'string' ? b.selfName.trim() : ''
        if (name) c.selfNames[sid] = name
        else delete c.selfNames[sid]
        saveCfg(c)
        // 洗一遍这个会话已有的记忆（有名字才洗）
        if (name) {
          try {
            const data = loadStore(sid)
            let 动 = false
            for (const 区 of ['memories', 'deleted']) {
              for (const m of data[区] || []) {
                const 新 = normalizePerson(m.text, name)
                if (新 !== m.text) {
                  改了几条.push(m.id)
                  m.text = 新
                  动 = true
                }
              }
            }
            if (动) saveStore(sid, data)
          } catch (error) {}
        }
        diag('她自己叫什么：' + sid + ' → 「' + (name || '（清掉了）') + '」' + (改了几条.length ? '，顺手洗了 ' + 改了几条.length + ' 条' : ''))
      } else {
        saveCfg(c)
      }

      // 称呼变了 → 已有记忆里那个字要不要跟着变？
      // 默认**只报数不落手**，她点「一起改」才真改 ✓
      // ⚠ 点「一起改」的时候称呼**已经存过了**，所以不能靠「变了没变」判断，得看 applyToExisting ✓
      let 称呼影响几条 = 0
      let 称呼例子 = []
      const 要改 = b.applyToExisting === true
      const 目标称呼 = 要改 ? userPronoun() : 称呼新值 !== null && 称呼新值 !== 称呼旧值 ? 称呼新值 : null
      if (目标称呼 !== null) {
        try {
          for (const fn of readdirSync(STORE_DIR)) {
            if (!fn.endsWith('.json')) continue
            const sid = fn.replace(/\.json$/, '')
            const data = loadStore(sid)
            let 动 = false
            for (const 区 of ['memories', 'deleted']) {
              for (const m of data[区] || []) {
                const 新 = changeUserPronoun(m.text, 目标称呼)
                if (新 !== m.text) {
                  称呼影响几条++
                  if (称呼例子.length < 3) 称呼例子.push({ id: m.id, 旧: m.text, 新: 新 })
                  if (要改) {
                    m.text = 新
                    动 = true
                  }
                }
              }
            }
            if (要改 && 动) saveStore(sid, data)
          }
        } catch (error) {}
        if (要改) diag('称呼改成「' + 目标称呼 + '」，顺手改了 ' + 称呼影响几条 + ' 条记忆')
        else diag('称呼从「' + 称呼旧值 + '」改成「' + 目标称呼 + '」，有 ' + 称呼影响几条 + ' 条旧记忆还写着旧字（等要不要一起改）')
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: true,
          selfName: selfNameOf(b.session || ''),
          userPronoun: userPronoun(),
          archiveDir: archiveDir(),
          userNames: 用户名字列表(),
          llmModel: 选定模型(),
          洗了: 改了几条.length,
          称呼影响几条,
          称呼例子,
          称呼已改: b.applyToExisting === true && 称呼影响几条 > 0,
        }),
      )
    })

    // ⭐⭐ 2026-09-22（反馈：「查重我们是不是还没做啊？我怎么没有找到按钮」）：
    //   查重**本来就有**，但都是**自动**的 —— 召回时去重（注入前只留一条）、导入时去重。
    //   **库里已经存着的重复，没人管** ✗ → 补一个能手动查、手动合的路由 ✓
    //
    //   ⚠⚠ **不能一键全合**：0.85 这套算法拿**短的那条**当分母，
    //     所以「一条长的把几条短的包住」也判成重复（1.0 分）。
    //     实测实测库里 69 对：**34 对是真重复**（两条长度差不多，合了安全），
    //     **35 对是「汇总+明细」**（一长一短，合了会丢信息）✗
    //     例：6 条一组里「她是全职代肝 / 她21岁 / 记错已改…」是 6 件**不同**的事，
    //         自动合会压成 1 件 ✗
    //     → 真重复给「一键合」，汇总+明细**只列出来让你挑** ✓
    const 找重复组 = (memories) => {
      const 带 = memories.map((m) => ({ m, 片段: 三字片段(m.text), 长: String(m.text || '').length }))
      // ⚠⚠ 2026-09-22 修（反馈：「把一些别的对的事实给删了」）：
      //   原来是**并查集**（A 像 B、B 像 C → A/B/C 算一组）——
      //   可 **A 和 C 可能根本不像**，一组就被串成杂烩 ✗✗
      //   实测实测库里一组 6 条：两条互不相关的事实毫不相干，
      //     只因为中间有别的条目连着 → 一键合把两条互不相关的事实
      //     这些**别的事实**一起合掉了 ✗
      //   → 改成**按种子归组**：每条只跟「种子那条」比，
      //     保证**组里每一条都真的像种子** ✓（不再有传递链）
      const 用过 = new Array(带.length).fill(false)
      const 组们 = []
      for (let i = 0; i < 带.length; i++) {
        if (用过[i]) continue
        用过[i] = true
        const 组 = [带[i]]
        for (let j = i + 1; j < 带.length; j++) {
          if (用过[j]) continue
          if (像度(带[i].片段, 带[j].片段) >= 重复门槛) {
            用过[j] = true
            组.push(带[j])
          }
        }
        if (组.length > 1) 组们.push(组)
      }
      return 组们
        .map((g) => {
          const 长们 = g.map((x) => x.长)
          return {
            // 长度差不多 = 真重复（合了安全）；一长一短 = 汇总+明细（要你挑）
            类型: Math.min(...长们) / Math.max(...长们) >= 0.8 ? '真重复' : '汇总明细',
            条们: g.map((x) => ({
              id: x.m.id,
              text: String(x.m.text || ''),
              category: x.m.category,
              at: x.m.at || null,
              长: x.长,
            })),
          }
        })
        .sort((a, b) => b.条们.length - a.条们.length)
    }

    mroute('/dsh-fish-memory/duplicates', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      let out = { ok: false, message: '？' }
      try {
        const data = loadStore(sid)
        // 跟召回一样：跳过「提炼判跳过」的
        const 活的 = (data.memories || []).filter((m) => !m.refinedSkip)
        const 组们 = 找重复组(活的)
        out = {
          ok: true,
          组: 组们,
          真重复组数: 组们.filter((g) => g.类型 === '真重复').length,
          汇总组数: 组们.filter((g) => g.类型 !== '真重复').length,
          能少: 组们.reduce((n, g) => n + g.条们.length - 1, 0),
          参与: 活的.length,
          共: (data.memories || []).length,
        }
      } catch (error) {
        out = { ok: false, message: String((error && error.message) || error) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // 合并：**逐条验过才收** —— 只把「真的像留下来那条」的收起来 ✓
    //   ⚠⚠ 2026-09-22 修（反馈：「把一些别的对的事实给删了」）：
    //     原来只收一份 id 名单，**服务端不验** —— 客户端算错了就真删错 ✗
    //     现在服务端**自己再算一遍相似度**：不像的**一条都不收**，并且报出来 ✓
    mroute('/dsh-fish-memory/duplicates/merge', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const 组们 = Array.isArray(b.组) ? b.组.slice(0, 300) : []
      let out = { ok: false, message: '？' }
      try {
        const data = loadStore(sid)
        if (!Array.isArray(data.deleted)) data.deleted = []
        const 按id = new Map((data.memories || []).map((m) => [String(m.id), m]))
        const 要收 = new Set()
        const 没验过 = []
        for (const g of 组们) {
          const 留 = 按id.get(String((g && g.留) || ''))
          if (!留) continue
          const 留片 = 三字片段(留.text)
          for (const id of Array.isArray(g && g.删) ? g.删 : []) {
            const m = 按id.get(String(id))
            if (!m) continue
            const 像 = 像度(留片, 三字片段(m.text))
            // ⚠ 只有**真的像**才收；不像的一律保住（宁可留着重复，也不许删错）✓
            if (像 >= 重复门槛) 要收.add(String(m.id))
            else 没验过.push({ id: String(m.id), 像度: Number(像.toFixed(3)), text: String(m.text || '').slice(0, 60) })
          }
        }
        const 留着 = []
        let 收起来 = 0
        for (const m of data.memories || []) {
          if (要收.has(String(m.id))) {
            m.deletedAt = new Date().toISOString()
            m.合并掉的 = true // 跟普通「删」区分开，以后想找回来好认
            data.deleted.push(m)
            markTraceStatus(data, m.id, 'invalidated')
            收起来++
          } else 留着.push(m)
        }
        if (收起来 > 0) {
          try {
            backupStore(sid) // ⚠ 动数据之前先备份
          } catch (error) {}
          data.memories = 留着
          saveStore(sid, data)
          diag('查重合并：' + sid + ' 合掉 ' + 收起来 + ' 条，验不过保住 ' + 没验过.length + ' 条，剩 ' + 留着.length + ' 条')
          out = {
            ok: true,
            收起来: 收起来,
            保住: 没验过.length,
            保住明细: 没验过.slice(0, 20),
            剩: 留着.length,
            message:
              '合掉了 ' + 收起来 + ' 条（收在「已删」里，能找回来）' +
              (没验过.length ? '；另有 ' + 没验过.length + ' 条**不够像、保住了**' : ''),
          }
        } else {
          out = { ok: false, message: 没验过.length ? '这些都不够像，一条都没合（保住了 ' + 没验过.length + ' 条）' : '没有要合的', 保住: 没验过.length, 保住明细: 没验过.slice(0, 20) }
        }
      } catch (error) {
        out = { ok: false, message: String((error && error.message) || error) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // ⚠ 删记忆 —— 只给设置页用。
    // 插件**没有**给模型注册任何删除工具，所以模型那边调不到这个能力 ✓
    // 而且「删」是收进 deleted 里（不是销毁），手滑也找得回来 ✓
    mroute('/dsh-fish-memory/delete', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const id = String(b.id || '')
      const action = String(b.action || 'delete')
      let out = { ok: false, message: '没找到' }
      try {
        const data = loadStore(sid)
        if (!Array.isArray(data.deleted)) data.deleted = []
        if (action === 'delete') {
          const i = data.memories.findIndex((m) => String(m.id) === id)
          if (i >= 0) {
            const m = data.memories.splice(i, 1)[0]
            m.deletedAt = new Date().toISOString()
            data.deleted.push(m)
            markTraceStatus(data, id, 'invalidated') // 以前的召回记录里它失效了 ✓
            saveStore(sid, data)
            diag('删了一条（收起来）：' + sid + ' / ' + id + ' 「' + String(m.text).slice(0, 30) + '」')
            out = { ok: true, message: '收起来了，还能找回来' }
          }
        } else if (action === 'restore') {
          const i = data.deleted.findIndex((m) => String(m.id) === id)
          if (i >= 0) {
            const m = data.deleted.splice(i, 1)[0]
            delete m.deletedAt
            data.memories.push(m)
            saveStore(sid, data)
            diag('找回来一条：' + sid + ' / ' + id)
            out = { ok: true, message: '找回来了' }
          }
        } else if (action === 'purge') {
          const n = data.deleted.length
          data.deleted = data.deleted.filter((m) => String(m.id) !== id)
          if (data.deleted.length !== n) {
            saveStore(sid, data)
            diag('彻底清掉一条：' + sid + ' / ' + id)
            out = { ok: true, message: '彻底清掉了' }
          }
        } else if (action === 'purgeall') {
          const n = data.deleted.length
          data.deleted = []
          saveStore(sid, data)
          diag('清空已删掉的：' + sid + '（' + n + ' 条）')
          out = { ok: true, message: '清掉了 ' + n + ' 条' }
        } else if (action === 'batchdelete') {
          // ⭐⭐ 2026-09-22（她要的）：**批量删除**（界面上是二次确认的）
          //   跟单条删一样：**收进 deleted**（不是销毁），手滑找得回来 ✓
          const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 2000) : []
          const 要删 = new Set(ids)
          const 留着 = []
          let n = 0
          for (const m of data.memories) {
            if (要删.has(String(m.id))) {
              m.deletedAt = new Date().toISOString()
              m.批量删的 = true // 跟「合并掉的」一样，留个记号好认
              data.deleted.push(m)
              markTraceStatus(data, m.id, 'invalidated')
              n++
            } else 留着.push(m)
          }
          if (n > 0) {
            try {
              backupStore(sid) // ⚠ 动数据之前先备份
            } catch (error) {}
            data.memories = 留着
            saveStore(sid, data)
            diag('批量删：' + sid + ' 删了 ' + n + ' 条，剩 ' + 留着.length + ' 条')
            out = { ok: true, 删了: n, 剩: 留着.length, message: '删掉 ' + n + ' 条（收在「已删」里，能找回来）' }
          } else {
            out = { ok: false, message: '没有要删的' }
          }
        } else if (action === 'purgebatch') {
          // ⭐ 2026-09-22（反馈「回收站还没有批量删除，就批量清空」）：
          //   「已删掉的」那一栏原来**只有「一条条清」和「全清空」**，
          //   想清掉其中几条就得一条条点 ✗
          //   → 补一个**批量清掉**（界面上是二次确认的）✓
          //   ⚠ 这个是真销毁（不是收起来）—— 所以界面必须问两遍
          const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 2000) : []
          const 要清 = new Set(ids)
          const 前 = data.deleted.length
          data.deleted = data.deleted.filter((m) => !要清.has(String(m.id)))
          const n = 前 - data.deleted.length
          if (n > 0) {
            try {
              backupStore(sid) // ⚠ 动数据之前先备份
            } catch (error) {}
            saveStore(sid, data)
            diag('批量清掉：' + sid + ' 清掉 ' + n + ' 条（「已删」里还剩 ' + data.deleted.length + ' 条）')
            out = { ok: true, 清掉: n, 剩: data.deleted.length, message: '彻底清掉 ' + n + ' 条（找不回来了）' }
          } else {
            out = { ok: false, message: '没有要清的' }
          }
        }
      } catch (error) {
        out = { ok: false, message: String((error && error.message) || error) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // ⚠ 改记忆 —— 也只给设置页用（跟删除一样，模型那边没有这个工具）✓
    mroute('/dsh-fish-memory/edit', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const id = String(b.id || '')
      const 新文本 = String(b.text || '').trim()
      let out = { ok: false, message: '没找到' }
      if (!新文本) {
        out = { ok: false, message: '不能改成空的（要删就用「删」）' }
      } else {
        try {
          const data = loadStore(sid)
          const m =
            (data.memories || []).find((x) => String(x.id) === id) ||
            (data.deleted || []).find((x) => String(x.id) === id)
          if (m) {
            const 旧 = String(m.text || '')
            // 跟 remember 一样的机械保证（「叫小明」那种说名字的不动）✓
            m.text = normalizePerson(新文本, selfNameOf(sid))
            m.editedAt = new Date().toISOString()
            m.source = '她改过的'
            if (String(旧) !== String(m.text)) markTraceStatus(data, id, 'invalidated') // 内容变了，以前那条就不算数了 ✓
            if (typeof b.importance === 'number' && isFinite(b.importance)) {
              const imp = Math.max(0, Math.min(1, b.importance))
              m.importance = imp
              m.category = imp >= 1 ? 'stable_profile' : 'event'
            }
            saveStore(sid, data)
            diag('改了一条：' + sid + ' / ' + id + '  「' + 旧.slice(0, 30) + '」→「' + m.text.slice(0, 30) + '」')
            out = { ok: true, message: '改好了', text: m.text, importance: m.importance, category: m.category }
          }
        } catch (error) {
          out = { ok: false, message: String((error && error.message) || error) }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // 自动找「她」的称呼 —— 她懒得一个个手打 ✓
    mroute('/dsh-fish-memory/names/scan', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const dir = typeof b.dir === 'string' && b.dir.trim() ? b.dir.trim() : archiveDir()
      const 排除 = 用户名字列表().slice()
      for (const n of 不是名字列表()) 排除.push(n) // 她标掉的，别再冒出来 ✓
      const self = selfNameOf(sid)
      if (self) 排除.push(self)
      const out = { ok: true, dir: dir, 候选: [], 互称: [], 不是名字: 不是名字列表() }
      try {
        if (!dir || !existsSync(dir)) {
          out.ok = false
          out.message = '还没选档案文件夹'
        } else {
          const 全部 = 找她的称呼(dir, 排除, self)
          // 分开给：只指她的 → 可以填进「指她的名字」；互相都叫的 → 换掉反而别扭，单列出来 ✓
          out.候选 = 全部.filter((x) => !x.互).map((x) => ({ name: x.name, n: x.n }))
          out.互称 = 全部.filter((x) => x.互).map((x) => ({ name: x.name, n: x.n }))
          diag(
            '自动找名字：' + dir + ' → 只指她 ' + out.候选.map((x) => x.name + '(' + x.n + ')').join(' ') +
              ' ｜ 互相都叫 ' + out.互称.map((x) => x.name + '(' + x.n + ')').join(' '),
          )
        }
      } catch (error) {
        out.ok = false
        out.message = String((error && error.message) || error)
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // 扫旧档案 → 只出候选，**不落库** ✓
    mroute('/dsh-fish-memory/import/scan', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const dir = typeof b.dir === 'string' && b.dir.trim() ? b.dir.trim() : archiveDir()
      const 名字们 = 用户名字列表()
      const out = { ok: true, dir: dir, files: [], items: [], 用户名字: 名字们, selfName: selfNameOf(sid) }
      try {
        // ⭐⭐ 2026-09-21（反馈：「别人导入会踩什么坑」时改的）：
        //   ① 原来只 readdirSync 一层 —— **子文件夹里的档案一条都扫不到**，
        //      界面上还只显示「0 条」，别人会以为档案没找对 ✗
        //      → 往下递归两层（够用，也不至于扫爆）✓
        //   ② 原来只认 .md/.markdown/.txt —— .text、.log、没扩展名都不认 ✗
        //      → 多认几个纯文本类型 ✓（docx/pdf 是二进制，认了也读不出，不碰）
        const 认得 = /\.(md|markdown|mdown|mkd|txt|text|log|rst|org)$/i
        const 扫 = (根, 相对, 层) => {
          let 名们 = []
          try {
            名们 = readdirSync(join(根, 相对))
          } catch (error) {
            return
          }
          for (const fn of 名们) {
            const 相对路径 = 相对 ? 相对 + '/' + fn : fn
            let st = null
            try {
              st = statSync(join(根, 相对路径))
            } catch (error) {
              continue
            }
            if (st && st.isDirectory()) {
              // 跳过常见的无关目录，别把 node_modules 也扫了
              if (/^(node_modules|\.git|\.svn|\.dsh|备份|backup)$/i.test(fn)) continue
              if (层 < 2) 扫(根, 相对路径, 层 + 1)
              continue
            }
            if (!认得.test(fn)) continue
            let text = ''
            try {
              text = readFileSync(join(根, 相对路径), 'utf8')
            } catch (error) {
              continue
            }
            const 候选 = 解析档案(text, 相对路径)
            out.files.push({ name: 相对路径, 字数: text.length, 候选: 候选.length })
            for (const c of 候选) {
              out.items.push({
                key: 相对路径 + '#' + c.line,
                file: 相对路径,
                line: c.line,
                section: c.section,
                text: c.text,
                改后: 导入时改人称(c.text, sid, 名字们),
                importance: c.importance,
                at: c.at,
              })
            }
          }
        }
        扫(dir, '', 0)
        // ⭐ 扫到 0 条时**说清为什么** —— 静默的「0 条」最坑人 ✗
        //   （「别人导入档案」场景：档案是一大段话、或者格式完全不一样）
        if (!out.files.length) {
          out.提示 =
            '这个文件夹里没找到能读的档案。只认纯文本：.md .markdown .txt .text .log .rst .org' +
            '（Word/PDF 是二进制，读不出来）；子文件夹会往下找两层。'
        } else if (!out.items.length) {
          const 最长的 = out.files.slice().sort((a, b) => b.字数 - a.字数)[0]
          out.提示 =
            '读了 ' + out.files.length + ' 个文件，但一条候选都没拆出来。' +
            '常见原因：整篇是一大段话（没有分行）、或者每行太短（不到 8 个字）、' +
            '或者内容都在表格/代码块/引用里。最大的文件是「' + 最长的.name + '」（' + 最长的.字数 + ' 字）。'
        }
        diag('扫档案：' + dir + ' → ' + out.items.length + ' 条候选（' + out.files.length + ' 个文件）')
      } catch (error) {
        out.ok = false
        out.message = String((error && error.message) || error)
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // 落库 —— 挑完点「导入」才走这里 ✓
    mroute('/dsh-fish-memory/import/apply', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const items = Array.isArray(b.items) ? b.items : []
      // ⭐ 每一批导入一个批次号 —— 这样**整批能一次撤掉** ✓
      const batch = 'b' + Date.now().toString(36) + Math.floor(Math.random() * 100)
      let added = 0
      let 重复 = 0
      let 删过 = 0
      let 近似 = 0
      let 补全 = 0
      try {
        const data = loadStore(sid)
        const 现有 = new Set((data.memories || []).map((m) => String(m.text || '').trim()))
        // ⚠ 已遗忘的内容不能因为再导一次就复活（照 AAAAGENT 的原则）
        const 删过的 = new Set((data.deleted || []).map((m) => String(m.text || '').trim()))
        // ⭐⭐ 2026-09-22（反馈）：**导入时也做近似去重** ✓
        //
        //   她那次导入的两份档案（记忆卡 + 总档案）内容本来就重叠，
        //   而这里原来只按「一字不差」去重 → 换个说法的同一件事两条都进来了 ✗
        //   实测：实测库里 131 对几乎重复、牵涉 226 条（27%），113 对就是这两份档案之间的。
        //
        //   ⚠ 阈值取 **0.9**（比召回去重的 0.85 高）—— 导入是**不可逆**的，
        //     宁可漏掉几条重复，也不许把「相关但不同」的当重复丢掉 ✗
        //
        //   ⚠⚠ 光用「长度比」区分「换个说法」和「更全的」**不靠谱** ——
        //     实测：换个说法的 1.31 倍、真更全的 1.62 倍，中间太挤，
        //     卡 1.3 会把「换个说法」也当成「更全」放过去 ✗（自检逮到的）
        //   → 改成：**像度够了之后，新的更长就「把旧的补全」，否则跳过** ✓
        //     这样**信息不丢、也不重复** —— 比单纯跳过好
        const 已有 = (data.memories || []).map((m) => ({
          m,
          文: String(m.text || '').trim(),
          片段: 三字片段(m.text),
        }))
        const 找近似 = (t) => {
          const 新片段 = 三字片段(t)
          for (const 旧 of 已有) {
            if (像度(新片段, 旧.片段) >= 0.9) return 旧
          }
          return null
        }
        const now = Date.now()
        for (const it of items) {
          const t = String((it && (it.改后 || it.text)) || '').trim()
          if (!t) continue
          if (删过的.has(t)) {
            删过++
            continue
          }
          if (现有.has(t)) {
            重复++
            continue
          }
          const 撞上 = 找近似(t)
          if (撞上) {
            // 新的更全 → 把旧的补全（保留旧的 id 和来源，只换正文）
            if (t.length > 撞上.文.length) {
              撞上.m.text = t
              撞上.m.source = '档案导入：' + String(it.file || '') + ' 第 ' + String(it.line || '') + ' 行（补全）'
              撞上.m.editedAt = new Date(now).toISOString()
              撞上.片段 = 三字片段(t)
              撞上.文 = t
              现有.add(t)
              补全++
            } else {
              近似++
            }
            continue
          }
          const imp = typeof it.importance === 'number' ? Math.max(0, Math.min(1, it.importance)) : 0.5
          data.memories.push({
            id: 'i' + (now + added).toString(36) + Math.floor(Math.random() * 1000),
            text: t,
            at: it.at || null, // 猜不到就 null，绝不编 ✓
            createdAt: new Date(now).toISOString(),
            category: imp >= 1 ? 'stable_profile' : 'event',
            importance: imp,
            emotion: null,
            tags: [],
            source: '档案导入：' + String(it.file || '') + ' 第 ' + String(it.line || '') + ' 行',
            importBatch: batch,
            importAt: new Date(now).toISOString(),
            reinforcedAt: null,
            lastReinforcedDay: null,
          })
          现有.add(t)
          已有.push({ m: data.memories[data.memories.length - 1], 文: t, 片段: 三字片段(t) })
          added++
        }
        if (added || 补全) saveStore(sid, data)
        diag('导入档案：加了 ' + added + ' 条（一字不差 ' + 重复 + '，几乎一样 ' + 近似 + '，补全 ' + 补全 + '，删过 ' + 删过 + '），批次 ' + batch)
      } catch (error) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, message: String((error && error.message) || error) }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, added: added, 重复: 重复, 近似: 近似, 补全: 补全, 删过: 删过, batch: added ? batch : null }))
    })

    // ⭐ 撤销一整批导入 —— 也是**收起来**（进 deleted），不是销毁 ✓
    mroute('/dsh-fish-memory/import/undo', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const batch = String(b.batch || '')
      let 撤了 = 0
      try {
        const data = loadStore(sid)
        if (!Array.isArray(data.deleted)) data.deleted = []
        const 留下 = []
        const 撤销时间 = new Date().toISOString()
        for (const m of data.memories || []) {
          if (batch && String(m.importBatch || '') === batch) {
            m.deletedAt = 撤销时间
            m.撤销原因 = '导入撤销'
            data.deleted.push(m)
            markTraceStatus(data, m.id, 'invalidated')
            撤了++
          } else {
            留下.push(m)
          }
        }
        if (撤了) {
          data.memories = 留下
          saveStore(sid, data)
          diag('撤销导入批次 ' + batch + '：收起了 ' + 撤了 + ' 条')
        }
      } catch (error) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, message: String((error && error.message) || error) }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, 撤了: 撤了 }))
    })

    // 列一个目录下的子文件夹 —— 给她「选」，不用手打 ✓
    mroute('/dsh-fish-memory/dirs', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const out = { ok: true, path: '', parent: null, dirs: [] }
      try {
        const p = typeof b.path === 'string' ? b.path.trim() : ''
        if (!p) {
          // 没给路径 → 先列有哪些盘
          for (const 盘 of ['C:', 'D:', 'E:', 'F:', 'G:']) {
            try {
              if (existsSync(盘 + '\\')) out.dirs.push({ name: 盘, path: 盘 + '\\' })
            } catch (error) {}
          }
        } else if (!existsSync(p)) {
          out.ok = false
          out.message = '这个路径不存在：' + p
        } else {
          out.path = p
          const 上一级 = p.replace(/[\\/][^\\/]*[\\/]?$/, '')
          out.parent = 上一级 && 上一级 !== p ? 上一级 : null
          for (const name of readdirSync(p)) {
            try {
              if (statSync(join(p, name)).isDirectory()) out.dirs.push({ name: name, path: join(p, name) })
            } catch (error) {}
          }
          out.dirs.sort((a, c) => String(a.name).localeCompare(String(c.name), 'zh'))
        }
      } catch (error) {
        out.ok = false
        out.message = String((error && error.message) || error)
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // 列出 DSH 里能用哪些模型 —— 给她选 ✓
    mroute('/dsh-fish-memory/models', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const out = { ok: true, providers: [], 选中的: 选定模型(), 默认: null }
      try {
        const agent = ctx.agents.get(String(b.session || '')) || (ctx.agents.list() || [])[0]
        out.默认 = 取模型(ctx, agent)
        const ps = ctx.llm.listProviders() || []
        for (const p of ps) {
          const 条 = { id: p.id, name: p.name || p.id, models: [] }
          try {
            const ms = await ctx.llm.listModels(p.id)
            for (const m of ms || []) 条.models.push({ id: m.id, name: m.name || m.id })
          } catch (error) {
            条.错误 = String((error && error.message) || error)
          }
          out.providers.push(条)
        }
        diag('models：' + out.providers.length + ' 个 provider，默认 ' + (out.默认 ? out.默认.provider + '/' + out.默认.model : '？'))
      } catch (error) {
        out.ok = false
        out.message = String((error && error.message) || error)
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // 提炼：把导入进来的档案原文改写成真正的记忆 —— 一次一批，界面循环调 ✓
    mroute('/dsh-fish-memory/refine', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const 每批 = Math.max(1, Math.min(20, Number(b.每批) || 6))
      let out = { ok: false, message: '没找到会话' }
      try {
        const data = loadStore(sid)
        // 要提炼的：档案导入进来的、还没提炼过的
        // ⚠ 加一个「试过几次」的上限：模型偶尔整批回不出东西，
        //   那种批次**不标记**、留着下次重跑；试满 3 次才收进「跳过」，不然会死循环 ✗
        const 最多试 = 3
        const 要提 = (data.memories || []).filter(
          (m) =>
            String(m.source || '').indexOf('档案导入') === 0 &&
            !m.refinedAt &&
            (Number(m.refineTries) || 0) < 最多试,
        )
        if (!要提.length) {
          out = { ok: true, done: true, 改了: 0, 跳过: 0, 剩: 0, 总数: (data.memories || []).length }
        } else {
          const 批 = 要提.slice(0, 每批)
          const agent = ctx.agents.get(sid) || (ctx.agents.list() || [])[0]
          const 输入 = 批.map((m, i) => i + 1 + '|' + String(m.text || '')).join('\n')
          const t0 = Date.now()
          // ⚠ 预算要给够：模型会先「思考」，思考的 token 也算在里面。
          //   给 2400 的时候实测被思考吃光、正文长度 0、整批被误判成「跳过」✗
          const r = await 问模型(ctx, agent, 提炼系统(userPronoun()), 输入, 6000)
          const ms = Date.now() - t0
          if (!r.ok) {
            out = { ok: false, message: r.message, 剩: 要提.length, provider: r.provider, model: r.model, ms: ms }
          } else {
            const 表 = 解析提炼(r.text, 批.length)
            let 改了 = 0
            let 跳过 = 0
            let 出了词的 = 0
            let 出了日期的 = 0
            let 出了重要度 = 0
            let 没解析出来 = 0
            const now = new Date().toISOString()
            for (let i = 0; i < 批.length; i++) {
              const m = 批[i]
              const 格 = 表[i]
              const 句子 = 格 ? 格.正文 : ''
              // 模型整批没回出东西（思考吃光预算、截断、格式跑了）→
              // **不标记**，记一次「试过」，下次还会重跑 ✓
              if (!句子) {
                m.refineTries = (Number(m.refineTries) || 0) + 1
                没解析出来++
                if (m.refineTries >= 最多试) {
                  m.refinedAt = now
                  m.refinedSkip = true
                  m.refineFailed = true // 试满了还是不行，标出来让她看得见
                }
                continue
              }
              // 模型明说「跳过」→ 这是它判断这条不值得记，收下 ✓
              if (/^跳过$/.test(句子)) {
                跳过++
                m.refinedAt = now
                m.refinedSkip = true
                continue
              }
              m.textBefore = String(m.text || '')
              m.text = normalizePerson(句子, selfNameOf(sid))
              // 顺手把检索词也收下 —— 有就不用再单独跑扩词了 ✓
              if (格 && 格.词 && 格.词.length) {
                m.related = 格.词.slice(0, 8)
                出了词的++
              }
              // ⭐ 顺手把日期也收下 —— **只补没日期的** ✓
              //   已经有日期的不动（导入时抠出来的那个更可信，是从原文抠的）
              if (格 && 格.日期 && !m.at) {
                m.at = 格.日期.at
                if (格.日期.猜年) m.atGuessed = true
                else delete m.atGuessed
                出了日期的++
              }
              // ⭐ 顺手把重要度也收下（2026-09-21 深夜，她的主意）✓
              //   **这条是覆盖** —— 导入时那个数按**小节标题**猜的（「关系/约定」那一节全打 1），
              //   是「这一小节」的分；模型看的是**这一条**，比标题准 → 就该让它说了算 ✓
              //   ⚠ 只在模型真给了合法值（1 或 0.5）时才动；它没给/给歪了就**保持原样**，
              //     不能因为模型抽风把整库的重要度洗成同一个数 ✗
              //
              // ⭐⭐ 2026-09-22（反馈）：**顺手把「永远不淡」也定了** ✓✓
              //
              //   原话：「很多条记忆，像**生日、纪念日、结婚**这种，
              //   就应该是长期事实，但是**从来就没有标记过**啊，我们这个压根就没有做到啊」
              //
              //   实测：库里 850 条，**135 条该「永远不淡」的被标成了会淡的**
              //   （重要的日子、身体、病史……全在里面）
              //
              //   根子：`/refine` 只写 `m.importance`，**不碰 `m.category`** ✗
              //   → 一条记忆永远停在「导入时按小节标题猜的那个分类」上，提炼判得再准也改不了它淡不淡。
              //
              //   修法（**不加格子、一个 token 都不多花**）：
              //     第五格「重要度」的含义本来就是「1 = 要一直记得的」，
              //     而导入那边本来就是 `category: imp >= 1 ? 'stable_profile' : 'event'`
              //     → 让「1」这个数**同时管两件事** ✓
              if (格 && typeof 格.重要度 === 'number') {
                m.importance = 格.重要度
                // 判成 1 = 要一直记得的 → 永远不淡；判成 0.5 → 会淡
                m.category = 格.重要度 >= 1 ? 'stable_profile' : 'event'
                出了重要度++
              }
              m.refinedAt = now
              delete m.refinedSkip
              delete m.refineTries
              改了++
            }
            saveStore(sid, data)
            const 剩 = 要提.length - 批.length
            diag(
              '提炼：' + sid + ' 这批 ' + 批.length + ' 条，改写 ' + 改了 +
                '（其中 ' + 出了词的 + ' 条顺手出了检索词，' + 出了日期的 + ' 条顺手出了日期，' + 出了重要度 + ' 条顺手判了重要度），跳过 ' + 跳过 +
                (没解析出来 ? '，没解析出来 ' + 没解析出来 + '（留着重跑）' : '') +
                '，还剩 ' + Math.max(0, 剩) + '（' + ms + 'ms，' + r.provider + '/' + r.model + '）',
            )
            out = {
              ok: true,
              done: Math.max(0, 剩) <= 0,
              改了: 改了,
              跳过: 跳过,
              出了词的: 出了词的,
              出了日期的: 出了日期的,
              出了重要度: 出了重要度,
              没解析出来: 没解析出来,
              剩: Math.max(0, 剩),
              总数: (data.memories || []).length,
              provider: r.provider,
              model: r.model,
              ms: ms,
              示例: 批.slice(0, 3).map((m) => ({ 前: m.textBefore || null, 后: m.text, 跳过: !!m.refinedSkip })),
            }
          }
        }
      } catch (error) {
        out = { ok: false, message: String((error && error.message) || error) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // 提炼改坏了怎么办 —— 退回原文 ✓
    // 单条：{ session, id }；整批：{ session, all: true }
    // 退回之后它会重新变成「没提炼的」，想再提一遍随时可以
    mroute('/dsh-fish-memory/refine/undo', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const 单条 = typeof b.id === 'string' ? b.id : ''
      const 整批 = !!b.all
      let out = { ok: false, message: '没找到会话' }
      try {
        const data = loadStore(sid)
        let 退了 = 0
        for (const m of data.memories || []) {
          if (typeof m.textBefore !== 'string') continue
          if (!整批 && m.id !== 单条) continue
          m.text = m.textBefore
          delete m.textBefore
          delete m.refinedAt
          delete m.refinedSkip
          m.refinedUndoAt = new Date().toISOString()
          退了++
        }
        if (退了) saveStore(sid, data)
        diag('提炼退回原文：' + sid + (整批 ? '（全部）' : '（' + 单条 + '）') + ' → ' + 退了 + ' 条')
        out = { ok: true, 退了: 退了, 剩: (data.memories || []).filter((m) => typeof m.textBefore === 'string').length }
      } catch (error) {
        out = { ok: false, message: String((error && error.message) || error) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // 把「跳过」的重新放回队列 —— 模型偶尔整批回不出东西，那些不该永远躺着 ✓
    // 只放回**没改写过的**（跳过的原文还在）；改写过的走「退回原文」那条路
    mroute('/dsh-fish-memory/refine/retry', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      let out = { ok: false, message: '没找到会话' }
      try {
        const data = loadStore(sid)
        let 放回 = 0
        for (const m of data.memories || []) {
          if (!m.refinedSkip) continue
          if (typeof m.textBefore === 'string') continue // 改写过的，走「退回原文」
          delete m.refinedAt
          delete m.refinedSkip
          delete m.refineFailed
          delete m.refineTries
          放回++
        }
        if (放回) saveStore(sid, data)
        diag('提炼重跑：' + sid + ' 放回 ' + 放回 + ' 条')
        out = { ok: true, 放回: 放回 }
      } catch (error) {
        out = { ok: false, message: String((error && error.message) || error) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // 把记忆复制到**另一个会话** —— 她想在新对话里测（新对话没有上下文，最干净）✓
    // { session: 从哪来, to: 到哪去 }
    // ⚠ 会**覆盖**目标那边的记忆（覆盖前 saveStore 会自动备份一份 .bak）
    mroute('/dsh-fish-memory/copy-to', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const 从 = String(b.session || '')
      const 到 = String(b.to || '')
      let out = { ok: false, message: '没找到会话' }
      try {
        if (!从 || !到) {
          out = { ok: false, message: '要指明从哪个会话、到哪个会话' }
        } else if (从 === 到) {
          out = { ok: false, message: '来源和目标不能是同一个会话' }
        } else {
          const 母的 = loadStore(从)
          if (!(母的.memories || []).length) {
            out = { ok: false, message: '来源那边没有记忆，没什么可复制的' }
          } else {
            const 副本 = JSON.parse(JSON.stringify(母的))
            for (const m of 副本.memories || []) {
              m.source = m.source ? m.source + '｜复制' : '复制'
            }
            副本.traces = [] // 召回历史不跟过去，那边是新的开始
            saveStore(到, 副本)
            setEnabled(到, true) // 复制过去了就顺手把开关打开，不然等于没复制
            diag('复制记忆：' + 从 + ' → ' + 到 + '（' + (副本.memories || []).length + ' 条）')
            out = { ok: true, 复制了: (副本.memories || []).length, 到: 到, 从: 从 }
          }
        }
      } catch (error) {
        out = { ok: false, message: String((error && error.message) || error) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    // 先验一下宿主模型通不通（诊断用）✓
    mroute('/dsh-fish-memory/llm-check', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const agent = sid ? (ctx.agents.get(sid) || (ctx.agents.list() || [])[0]) : (ctx.agents.list() || [])[0]
      const t0 = Date.now()
      // ⚠ 预算别给太小：模型光「思考」就能吃掉 20 个 token，那样正文是空的 ✗
      const r = await 问模型(ctx, agent, '你只要回两个字：通了。', '测试一下', 300)
      const ms = Date.now() - t0
      diag('llm-check：' + JSON.stringify(r).slice(0, 160) + '（' + ms + 'ms）')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(Object.assign({ ms: ms }, r)))
    })

    // 给记忆扩词 —— 一次一批，界面循环调它，显示进度 ✓
    mroute('/dsh-fish-memory/expand', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let b = {}
      try {
        b = JSON.parse(body || '{}')
      } catch (error) {}
      const sid = String(b.session || '')
      const 每批 = Math.max(1, Math.min(20, Number(b.每批) || 8))
      let out = { ok: false, message: '没找到会话' }
      try {
        const data = loadStore(sid)
        const 要扩 = (data.memories || []).filter((m) => !Array.isArray(m.related) || !m.related.length)
        if (!要扩.length) {
          out = { ok: true, done: true, 改了: 0, 剩: 0, 总数: data.memories.length }
        } else {
          const 批 = 要扩.slice(0, 每批)
          const agent = ctx.agents.get(sid) || (ctx.agents.list() || [])[0]
          const 输入 = 批.map((m, i) => i + 1 + '|' + String(m.text || '')).join('\n')
          const t0 = Date.now()
          // ⚠ 预算要给够：模型会先「思考」，思考的 token 也算在里面。
          //   实测 6 条的时候：**正文 167 字，思考 2912 字**（思考是答案的 17 倍）——
          //   原来只给 900，连思考都不够，正文永远是空的，
          //   表现就是「连着几批没回可用的词，自己停了」✗（2026-09-20 踩到）
          const r = await 问模型(ctx, agent, 扩词系统, 输入, 6000)
          const ms = Date.now() - t0
          if (!r.ok) {
            out = { ok: false, message: r.message, 剩: 要扩.length, provider: r.provider, model: r.model, ms: ms }
          } else {
            const 表 = 解析扩词(r.text, 批.length)
            let 改了 = 0
            for (const k of Object.keys(表)) {
              const m = 批[Number(k)]
              if (!m) continue
              m.related = 表[Number(k)]
              m.relatedAt = new Date().toISOString()
              改了++
            }
            if (改了) saveStore(sid, data)
            const 剩 = 要扩.length - 改了
            diag('扩词：' + sid + ' 这批 ' + 批.length + ' 条，成功 ' + 改了 + ' 条，还剩 ' + 剩 + '（' + ms + 'ms，' + r.provider + '/' + r.model + '）')
            out = {
              ok: true,
              done: 剩 <= 0,
              改了: 改了,
              // 模型一个字都没回出来（多半是思考吃光预算被截断）——
              // 让界面能说清楚原因，而不是干巴巴「没回可用的词」✓
              没解析出来: 改了 === 0 ? 批.length : 0,
              剩: 剩,
              总数: data.memories.length,
              provider: r.provider,
              model: r.model,
              ms: ms,
              示例: 批.slice(0, 3).map((m) => ({ text: m.text, related: m.related || null })),
            }
          }
        }
      } catch (error) {
        out = { ok: false, message: String((error && error.message) || error) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out))
    })

    mroute('/dsh-fish-memory/policy', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let patch = {}
      try {
        patch = JSON.parse(body || '{}')
      } catch (error) {}
      // 恢复默认：直接把整份默认值当补丁送进 fitPolicy ✓
      if (patch && patch.reset === true) patch = { ...DEFAULT_POLICY }
      // pin = 她刚改的那一项，钉住它让其余三项让位 ✓
      const pin = patch && typeof patch.pin === 'string' ? patch.pin : null
      let n = 0
      let saved = null
      let notes = []
      try {
        const files = readdirSync(STORE_DIR)
        for (const fn of files) {
          if (!fn.endsWith('.json')) continue
          const sid = fn.replace(/\.json$/, '')
          const data = loadStore(sid)
          const r = fitPolicy(patch, data.policy, pin)
          data.policy = r.policy
          saved = r.policy
          notes = r.notes
          saveStore(sid, data)
          n++
        }
      } catch (error) {}
      if (!saved) {
        const r = fitPolicy(patch, DEFAULT_POLICY, pin)
        saved = r.policy
        notes = r.notes
      }
      diag('policy 改了 ' + n + ' 个库：' + JSON.stringify(saved) + (notes.length ? ' ｜ ' + notes.join('；') : ''))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, changed: n, policy: saved, notes }))
    })
  } catch (error) {
    diag('设置页路由挂不上：' + (error && error.message))
  }

  diag('apply 跑完（v0.2）')
}

export {
  recall,
  render,
  relTime,
  tokenize,
  loadStore,
  解析档案,
  抠日期,
  抠日期详,
  猜重要度,
  // 2026-09-21 新加的，给自检脚本用 ✓
  稀有表,
  稀有度,
  词面,
  记一句话,
  问句信息量,
  说话尺,
  // 2026-09-21 中午加的：搭配度（治跨词碎片）✓
  切词,
  搭配集,
  装搭配,
  中文片段,
  // 2026-09-21 傍晚加的：幽灵会话（会话没了、记忆文件还在）✓
  buildMemoryList,
  已知会话ids,
  归档名单,
}
