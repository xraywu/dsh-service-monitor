/**
 * dsh-service-monitor — 宿主半边 / host half.
 *
 * 单一 Loader 行(见 cordis.patch.yml)挂载本模块,职责:
 *   1. 维护第三方服务的余额缓存($DSH_HOME/storages/service-monitor/state.json);
 *   2. 按 1/5/10/30 分钟定时(或手动)向各服务查询剩余额度;
 *   3. 把 API Key 存入 DSH 凭据库(不可写时回落到私有状态文件);
 *   4. 通过 ctx.webServer 暴露同源 JSON API,供客户端看板读写。
 *
 * 只使用 Node 内建能力与 ctx 服务,不 import 任何 @deepseek-ai/* 运行时包:
 * 插件安装在 profile 的 node_modules 下,那里没有这些包。因此 credential ref
 * 只按名字构造(credentialRef 在运行时就是原字符串)。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'service-monitor'

/** `webServer` 是硬依赖:没有 HTTP 载体就没有这个插件。 */
export const inject = ['webServer']

// ── 常量 ─────────────────────────────────────────────────────────────────────

const PLUGIN_ID = 'service-monitor'
const MOUNT_PATH = '/service-monitor'
const API_BASE = MOUNT_PATH + '/api'
const STATE_VERSION = 1
const INTERVAL_CHOICES = [1, 5, 10, 30]
const DEFAULT_INTERVAL_MINUTES = 10
const REQUEST_TIMEOUT_MS = 15000
const BODY_LIMIT_BYTES = 64 * 1024
const STARTUP_REFRESH_DELAY_MS = 2500

/**
 * 注入用的系统提示词段落 order。
 *
 * 宿主把段落按 order 升序拼装,内置表 `SECTION_ORDERS` 里最大的一项是
 * `DEPLOYMENT_PERSONA_SUFFIX: 10200`,所以取一个更大的值就等于「所有系统
 * 段落之后、用户消息之前」—— 这正是要的位置:余额是会变的数据,放在系统
 * 提示词末尾,变化只影响尾部,前面那段稳定的前缀仍然命中提示词缓存。
 * 若将来宿主把这个数提到 10300 以上,这个值需要跟着调大。
 */
export const PROMPT_SECTION_ORDER = 10300

/** 会话上下文中该段落的稳定名字。 */
const PROMPT_SECTION_NAME = 'service-monitor:balances'

/** 用户可见的服务端文案(zh/en),随宿主语言选择。 */
const MESSAGES = {
  zh: {
    noKey: '尚未配置 API Key',
    unauthorized: 'API Key 无效或已过期(HTTP {status})',
    forbidden: '该 API Key 无权访问余额接口(HTTP {status})',
    noCredits: '额度已用尽(HTTP 402):请到厂商控制台充值',
    rateLimited: '请求过于频繁(HTTP 429),请稍后重试',
    http: '接口返回 HTTP {status}',
    network: '网络请求失败:{message}',
    dnsFailed: '域名解析失败({host}):本机 DNS 可能被污染或未联网',
    unreachable: '连不上 {host}(超时或被拒绝):该服务在当前网络下可能不可达;如走代理,请为 DSH 进程配置代理',
    timeout: '请求超时({ms} 毫秒未响应)',
    parse: '响应不是预期的 JSON 结构',
    unknownService: '未知的服务:{id}',
    badInterval: '刷新间隔只能是 1、5、10、30 分钟',
    badBody: '请求体不是合法 JSON',
    forbiddenHost: '请求来源不被信任',
    keyTooLong: 'API Key 过长',
    keyEmpty: 'API Key 不能为空',
    cleared: 'API Key 已移除',
    // 注入上下文用的文案
    promptTitle: '第三方服务余额',
    promptMeta: '每 {interval} 分钟刷新 · 更新于 {time}',
    promptMetaPending: '每 {interval} 分钟刷新 · 尚未取到数据',
    promptAmount: '剩余 {amount}{unit}',
    promptNoReading: '暂无数值',
    promptDepleted: '已耗尽',
    promptNoKey: '未配置 API Key',
    promptFailed: '查询失败 —— {message}',
    unitCredits: '额度',
    unitRequests: '次',
    unitUsd: '美元',
    unitCny: '元',
  },
  en: {
    noKey: 'No API key configured yet',
    unauthorized: 'API key is invalid or expired (HTTP {status})',
    forbidden: 'This API key may not read the usage endpoint (HTTP {status})',
    noCredits: 'Credits exhausted (HTTP 402) — top up in the vendor console',
    rateLimited: 'Rate limited (HTTP 429), try again later',
    http: 'Endpoint returned HTTP {status}',
    network: 'Network request failed: {message}',
    dnsFailed: 'DNS lookup failed for {host}: the local resolver may be poisoned or offline',
    unreachable: 'Could not reach {host} (timeout or refused): the service may be unreachable on this network; configure a proxy for the DSH process if you use one',
    timeout: 'Request timed out (no response within {ms} ms)',
    parse: 'Response was not the expected JSON shape',
    unknownService: 'Unknown service: {id}',
    badInterval: 'Refresh interval must be 1, 5, 10 or 30 minutes',
    badBody: 'Request body is not valid JSON',
    forbiddenHost: 'Request origin is not trusted',
    keyTooLong: 'API key is too long',
    keyEmpty: 'API key must not be empty',
    cleared: 'API key removed',
    // copy for the injected context block
    promptTitle: 'Third-party service balances',
    promptMeta: 'refreshed every {interval} min · as of {time}',
    promptMetaPending: 'refreshed every {interval} min · no reading yet',
    promptAmount: '{amount}{unit} remaining',
    promptNoReading: 'no readable value',
    promptDepleted: 'depleted',
    promptNoKey: 'no API key configured',
    promptFailed: 'query failed — {message}',
    unitCredits: 'credits',
    unitRequests: 'requests',
    unitUsd: 'USD',
    unitCny: 'CNY',
  },
}

/**
 * 渲染一条文案。抽成模块级纯函数,是为了让注入上下文的文本能在 test/ 里
 * 直接断言 —— 那段文字会进入每一轮模型请求,值得有个测试盯着。
 */
function message(lang, key, params = {}) {
  const dict = MESSAGES[lang] ?? MESSAGES.en
  const template = dict[key] ?? MESSAGES.en[key] ?? key
  return String(template).replace(/\{(\w+)\}/g, (_, name) => (name in params ? String(params[name]) : `{${name}}`))
}

// ── 小工具 ───────────────────────────────────────────────────────────────────

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
/** 数字字段的宽容读取:很多网关把数字以字符串返回("10820856.78")。 */
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim().length > 0) {
    const parsed = Number(v)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
const clampText = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : null)

/** 带 code 的查询失败,便于客户端区分「没配 Key」与「Key 失效」。 */
class MonitorError extends Error {
  constructor(code, message, httpStatus, host) {
    super(message)
    this.name = 'MonitorError'
    this.code = code
    this.httpStatus = typeof httpStatus === 'number' ? httpStatus : null
    this.host = typeof host === 'string' ? host : null
  }
}

/**
 * 连不上和「Key 不对」是两回事:在本机 DNS 被污染或需要代理的网络里,
 * 界面上写「网络请求失败」等于没说。这里把底层 cause 分类成可行动的结论。
 */
const DNS_FAILURE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN'])
const UNREACHABLE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_ERROR',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

function networkError(error, url) {
  const host = hostOf(url)
  const cause = error && typeof error === 'object' ? error.cause : undefined
  const code = String((cause && cause.code) ?? (error && error.code) ?? '')
  if (DNS_FAILURE_CODES.has(code)) return new MonitorError('dns', `${host ?? url}: ${code}`, null, host)
  if (UNREACHABLE_CODES.has(code)) return new MonitorError('unreachable', `${host ?? url}: ${code}`, null, host)
  return new MonitorError('network', `${host ?? url}: ${code || (error && error.message) || 'unknown'}`, null, host)
}

/**
 * 用 AbortController 给 fetch 加超时,并把响应读成 { status, ok, body }。
 * body 先按 JSON 解析,失败则保留原始文本(截断)。
 */
async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { redirect: 'follow', ...options, signal: controller.signal })
    const text = await res.text()
    let body = null
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = clampText(text, 600)
      }
    }
    return { status: res.status, ok: res.ok, body }
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      throw new MonitorError('timeout', `timeout after ${timeoutMs}ms`, null, hostOf(url))
    }
    throw networkError(error, url)
  } finally {
    clearTimeout(timer)
  }
}

/** 从各服务五花八门的错误体里挖出一句人能读的话。 */
function providerMessage(body, depth = 0) {
  if (typeof body === 'string') return clampText(body, 200)
  if (!isObject(body)) return null
  for (const key of ['detail', 'error', 'message', 'msg', 'error_message']) {
    const value = body[key]
    if (typeof value === 'string' && value.length > 0) return clampText(value, 200)
    // Tavily 把话藏在 detail.error 里,Firecrawl 藏在 data.error 里。
    if (isObject(value) && depth < 2) {
      const nested = providerMessage(value, depth + 1)
      if (nested !== null) return nested
    }
  }
  return null
}

/** 非 2xx 一律转成带 code 的 MonitorError,附上服务端自己的描述。 */
export function requireOk(res) {
  if (res.ok) return res.body
  const detail = providerMessage(res.body)
  const suffix = detail ? ` — ${detail}` : ''
  if (res.status === 401) throw new MonitorError('unauthorized', `HTTP 401${suffix}`, 401)
  if (res.status === 402) throw new MonitorError('no-credits', `HTTP 402${suffix}`, 402)
  if (res.status === 403) throw new MonitorError('forbidden', `HTTP 403${suffix}`, 403)
  if (res.status === 429) throw new MonitorError('rate-limited', `HTTP 429${suffix}`, 429)
  throw new MonitorError('http', `HTTP ${res.status}${suffix}`, res.status)
}

// ── 服务适配器 ───────────────────────────────────────────────────────────────

/**
 * 每个适配器把厂商响应归一化成:
 *   { remaining, total, used, unit, plan, resetsAt, extra[] }
 * remaining/total/used 单位为 unit('credits' | 'requests' | 'usd')。
 * query() 抛 MonitorError 表示查询失败。
 */
const PROVIDERS = [
  {
    id: 'tavily',
    label: { zh: 'Tavily 搜索', en: 'Tavily' },
    unit: 'credits',
    envs: ['TAVILY_API_KEY'],
    keyHint: 'tvly-…',
    consoleUrl: 'https://app.tavily.com',
    quotaNote: { zh: '按月套餐额度', en: 'Monthly plan credits' },
    async query(key) {
      const body = requireOk(
        await fetchJson('https://api.tavily.com/usage', {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        }),
      )
      return normalizeTavily(body)
    },
  },
  {
    id: 'bocha',
    label: { zh: '博查 Bocha', en: 'Bocha' },
    unit: 'cny',
    envs: ['BOCHA_API_KEY', 'BOCHA_KEY'],
    keyHint: 'sk-…',
    consoleUrl: 'https://open.bochaai.com/',
    quotaNote: { zh: '账户余额(元)', en: 'Account balance (CNY)' },
    async query(key) {
      // GET /v1/fund/remaining → { success, code, msg, data: { remaining } },remaining 单位为元。
      // api.bocha.cn 是主域名,api.bochaai.com 为兼容域名。
      const headers = { authorization: `Bearer ${key}`, accept: 'application/json' }
      let lastError = null
      for (const url of ['https://api.bocha.cn/v1/fund/remaining', 'https://api.bochaai.com/v1/fund/remaining']) {
        try {
          const body = requireOk(await fetchJson(url, { headers }))
          return normalizeBocha(body)
        } catch (error) {
          lastError = error
          // 只有「端点不存在」才值得试下一个;鉴权失败是最终结论。
          if (!(error instanceof MonitorError) || (error.httpStatus !== 404 && error.httpStatus !== 405)) throw error
        }
      }
      throw lastError ?? new MonitorError('http', 'no Bocha endpoint answered')
    },
  },
  {
    id: 'firecrawl',
    label: { zh: 'Firecrawl 抓取', en: 'Firecrawl' },
    unit: 'credits',
    envs: ['FIRECRAWL_API_KEY'],
    keyHint: 'fc-…',
    consoleUrl: 'https://www.firecrawl.dev/app/api-keys',
    quotaNote: { zh: '计费周期内剩余额度', en: 'Credits left this billing period' },
    async query(key) {
      const headers = { authorization: `Bearer ${key}`, accept: 'application/json' }
      let body = null
      let lastError = null
      for (const url of ['https://api.firecrawl.dev/v2/team/credit-usage', 'https://api.firecrawl.dev/v1/team/credit-usage']) {
        try {
          const res = await fetchJson(url, { headers })
          // v2 未上线时返回 404/405,继续试 v1。
          if (!res.ok && (res.status === 404 || res.status === 405)) {
            lastError = new MonitorError('http', `HTTP ${res.status}`, res.status)
            continue
          }
          body = requireOk(res)
          break
        } catch (error) {
          lastError = error
          if (!(error instanceof MonitorError) || (error.httpStatus !== 404 && error.httpStatus !== 405)) throw error
        }
      }
      if (body === null) throw lastError ?? new MonitorError('http', 'no Firecrawl endpoint answered')
      return normalizeFirecrawl(body)
    },
  },
  {
    id: 'serpapi',
    label: { zh: 'SerpAPI 搜索', en: 'SerpAPI' },
    unit: 'requests',
    envs: ['SERPAPI_API_KEY', 'SERP_API_KEY'],
    keyHint: '64 位十六进制',
    consoleUrl: 'https://serpapi.com/manage-api-key',
    quotaNote: { zh: '本月剩余搜索次数', en: 'Searches left this month' },
    async query(key) {
      const url = `https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`
      const body = requireOk(await fetchJson(url, { headers: { accept: 'application/json' } }))
      return normalizeSerpapi(body)
    },
  },
  {
    id: 'tinyfish',
    label: { zh: 'TinyFish Agent 服务', en: 'TinyFish' },
    unit: 'usd',
    envs: ['TINYFISH_API_KEY'],
    // 厂商未公布 Key 的格式,前台就不猜格式,只写「从控制台取」。
    keyHint: null,
    consoleUrl: 'https://agent.tinyfish.ai/api-keys',
    quotaNote: { zh: '预付费钱包余额', en: 'Prepaid wallet balance' },
    async query(key) {
      // 余额在钱包上,不在 api.fetch.tinyfish.ai/usage(那是逐次抓取日志)。
      const body = requireOk(
        await fetchJson('https://agent.tinyfish.ai/v1/wallet', {
          headers: { 'X-API-Key': key, accept: 'application/json' },
        }),
      )
      return normalizeTinyfish(body)
    },
  },
]

// ── 响应归一化 ───────────────────────────────────────────────────────────────
//
// 每个厂商的响应形状都不同,而且同一厂商不同版本还会换命名(Firecrawl v2 是
// camelCase、v1 是 snake_case),所以解析集中在这几个纯函数里,由 test/ 直接
// 用官方文档里的示例报文验证 —— 用无效 Key 只能验证到 401,验证不到成功分支。
// 这几个函数为测试而导出,cordis 只关心 `name` / `apply`。

/**
 * Tavily `GET /usage` → { key:{usage,limit}, account:{current_plan,plan_usage,plan_limit,…} }。
 * 接口不给「剩余」,要自己相减;也没有重置日期字段。
 */
export function normalizeTavily(body) {
  if (!isObject(body)) throw new MonitorError('parse', 'unexpected Tavily payload')
  const account = isObject(body.account) ? body.account : {}
  const keyUsage = isObject(body.key) ? body.key : {}
  const total = num(account.plan_limit) ?? num(keyUsage.limit)
  const used = num(account.plan_usage) ?? num(keyUsage.usage)
  const remaining = total !== null && used !== null ? Math.max(0, total - used) : null
  const extra = []
  const searchUsage = num(account.search_usage)
  if (searchUsage !== null) extra.push({ key: 'searchUsage', value: String(searchUsage) })
  const extractUsage = num(account.extract_usage)
  if (extractUsage !== null) extra.push({ key: 'extractUsage', value: String(extractUsage) })
  const paygoUsage = num(account.paygo_usage)
  if (paygoUsage !== null && paygoUsage > 0) extra.push({ key: 'paygoUsage', value: String(paygoUsage) })
  const keyLimit = num(keyUsage.limit)
  if (keyLimit !== null && keyLimit > 0) {
    extra.push({ key: 'keyUsage', value: `${num(keyUsage.usage) ?? 0} / ${keyLimit}` })
  }
  return { remaining, total, used, unit: 'credits', plan: clampText(account.current_plan, 80), resetsAt: null, extra }
}

/**
 * 博查 `GET /v1/fund/remaining` → { success, code:"200", msg, data:{ remaining } },
 * remaining 单位为元。也兼容个别网关把字段平铺或改名的写法。
 */
export function normalizeBocha(body) {
  if (!isObject(body)) throw new MonitorError('parse', 'unexpected Bocha payload')
  // HTTP 200 但业务失败时,别把缺失的字段当成余额。
  if (body.success === false || (body.code !== undefined && String(body.code) !== '200')) {
    throw new MonitorError('http', `Bocha error ${body.code ?? ''}: ${body.msg ?? body.message ?? 'unknown'}`.trim())
  }
  const roots = [body.data, body.result, body].filter(isObject)
  for (const root of roots) {
    const balance = num(root.remaining) ?? num(root.balance) ?? num(root.amount) ?? num(root.money)
    if (balance !== null) {
      const total = num(root.total) ?? num(root.total_amount) ?? null
      const used = num(root.used) ?? num(root.used_amount) ?? (total !== null ? Math.max(0, total - balance) : null)
      const extra = []
      const gift = num(root.gift_balance) ?? num(root.free_balance)
      if (gift !== null) extra.push({ key: 'giftBalance', value: String(gift) })
      return { remaining: balance, total, used, unit: 'cny', plan: null, resetsAt: null, extra }
    }
  }
  throw new MonitorError('parse', 'unexpected Bocha payload')
}

/**
 * Firecrawl `GET /team/credit-usage`。v2 是 camelCase、v1 是 snake_case,
 * 两个版本字段名不同,所以两套拼写都要认 —— 只认一套会在另一版上抛 parse。
 * 没有「已用」也没有套餐名;planCredits 不含优惠券与 PAYGO 而 remainingCredits
 * 含,因此相减出来的已用只是近似值。
 */
export function normalizeFirecrawl(body) {
  if (!isObject(body)) throw new MonitorError('parse', 'unexpected Firecrawl payload')
  if (body.success === false) {
    throw new MonitorError('http', `Firecrawl error: ${providerMessage(body) ?? 'unknown'}`)
  }
  const data = isObject(body.data) ? body.data : body
  const remaining = num(data.remainingCredits) ?? num(data.remaining_credits)
  const total = num(data.planCredits) ?? num(data.plan_credits)
  if (remaining === null && total === null) throw new MonitorError('parse', 'unexpected Firecrawl payload')
  const used = total !== null && remaining !== null ? Math.max(0, total - remaining) : null
  // Firecrawl 的账单接口**没有任何「额度重置」字段**:v2 OpenAPI 里
  // /team/credit-usage 只有 remainingCredits / planCredits / billingPeriodStart /
  // billingPeriodEnd,/team/token-usage 同样只有计费周期起止,/team/credit-usage/historical
  // 只有 startDate / endDate / totalCredits。年付套餐的 billingPeriodEnd 是套餐到期日,
  // 与「每月额度重置」不是一回事 —— 所以这里既不把它塞进 resetsAt,也不自己推算一个
  // 日期,只如实展示「计费周期」,免得把一个错的日子标成「重置时间」。
  const extra = []
  const periodStart = clampText(data.billingPeriodStart ?? data.billing_period_start, 40)
  const periodEnd = clampText(data.billingPeriodEnd ?? data.billing_period_end, 40)
  if (periodStart !== null) extra.push({ key: 'billingPeriodStart', value: periodStart, kind: 'date' })
  if (periodEnd !== null) extra.push({ key: 'billingPeriodEnd', value: periodEnd, kind: 'date' })
  return { remaining, total, used, unit: 'credits', plan: null, resetsAt: null, extra }
}

/**
 * TinyFish `GET /v1/wallet`。钱包是预付费模型,只有余额没有总量:
 * { available_balance:"21.44"(字符串!), currency:"USD", as_of,
 *   auto_reload:{state}, pending_top_up:{amount,started_at},
 *   rates:{meters:[{label,unit_amount,currency,per}]}, agent_top_up_url }
 * 少数网关会把钱包包一层 data/wallet,这里一并认。
 */
export function normalizeTinyfish(body) {
  if (!isObject(body)) throw new MonitorError('parse', 'unexpected TinyFish wallet payload')
  const wallet = isObject(body.wallet) ? body.wallet : isObject(body.data) ? body.data : body
  const remaining = num(wallet.available_balance) ?? num(wallet.availableBalance) ?? num(wallet.balance)
  if (remaining === null) throw new MonitorError('parse', 'unexpected TinyFish wallet payload')
  const currency = typeof wallet.currency === 'string' ? wallet.currency.toLowerCase() : 'usd'
  const extra = []
  const autoReload = isObject(wallet.auto_reload) ? wallet.auto_reload : null
  if (autoReload && typeof autoReload.state === 'string') extra.push({ key: 'autoReload', value: autoReload.state })
  const pending = isObject(wallet.pending_top_up) ? num(wallet.pending_top_up.amount) : num(wallet.pending_top_up)
  if (pending !== null && pending > 0) extra.push({ key: 'pendingTopUp', value: String(pending) })
  const meters = isObject(wallet.rates) && Array.isArray(wallet.rates.meters) ? wallet.rates.meters : []
  for (const meter of meters.slice(0, 3)) {
    if (!isObject(meter) || typeof meter.label !== 'string') continue
    const amount = num(meter.unit_amount)
    if (amount === null) continue
    const suffix = [meter.currency, meter.per ? `/${meter.per}` : ''].join('')
    extra.push({ key: 'meter', label: meter.label, value: `${amount} ${suffix}`.trim() })
  }
  return { remaining, total: null, used: null, unit: currency === 'usd' ? 'usd' : 'credits', plan: null, resetsAt: null, extra }
}
/** SerpAPI `GET /account.json` —— 认证只走 query 参数。 */
export function normalizeSerpapi(body) {
  if (!isObject(body)) throw new MonitorError('parse', 'unexpected SerpAPI payload')
  const total = num(body.searches_per_month) ?? num(body.plan_searches_per_month)
  const planLeft = num(body.plan_searches_left)
  const totalLeft = num(body.total_searches_left)
  const remaining = totalLeft ?? planLeft
  const monthUsage = num(body.this_month_usage)
  const used = monthUsage !== null ? monthUsage : total !== null && planLeft !== null ? Math.max(0, total - planLeft) : null
  const extra = []
  if (planLeft !== null) extra.push({ key: 'planSearchesLeft', value: String(planLeft) })
  const extraCredits = num(body.extra_credits)
  if (extraCredits !== null && extraCredits > 0) extra.push({ key: 'extraCredits', value: String(extraCredits) })
  const hourly = num(body.account_rate_limit_per_hour)
  if (hourly !== null) extra.push({ key: 'rateLimitPerHour', value: String(hourly) })
  const monthlyPrice = num(body.plan_monthly_price)
  if (monthlyPrice !== null) extra.push({ key: 'planMonthlyPrice', value: `$${monthlyPrice}` })
  if (body.account_email) extra.push({ key: 'accountEmail', value: clampText(body.account_email, 120) })
  return {
    remaining,
    total,
    used,
    unit: 'requests',
    plan: clampText(body.plan_name ?? body.plan_id, 80),
    resetsAt: clampText(body.plan_renewal_date, 40),
    extra,
  }
}

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]))

// ── 注入上下文 ───────────────────────────────────────────────────────────────

/** 注入文本里的金额格式,跟界面保持一致的写法。 */
function promptAmount(value, unit) {
  if (value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (unit === 'usd') return `$${n.toFixed(2)}`
  if (unit === 'cny') return `¥${n.toFixed(2)}`
  return String(Math.round(n * 100) / 100)
}

const unitWord = (lang, unit) => message(lang, `unit${unit === 'usd' ? 'Usd' : unit === 'cny' ? 'Cny' : unit === 'requests' ? 'Requests' : 'Credits'}`)

/**
 * 生成注入系统提示词尾部的余额块。纯函数:不读全局状态,测试可直接喂数据。
 *
 * 约定:
 *   - 只列**已启用**的服务,一行一个,顺序固定(便于命中缓存);
 *   - 没有任何已启用服务时返回空串,让调用方干脆不注册段落;
 *   - 余额 <= 0 标注「已耗尽」—— 这是模型最该知道的一条事实。
 *
 * @param {object} input
 * @param {'zh'|'en'} input.lang 文案语言。
 * @param {number} input.intervalMinutes 当前刷新间隔。
 * @param {string|null} input.lastRefreshAt 最近一次成功刷新时间。
 * @param {Array<{id: string, label: {zh: string, en: string}, unit: string, enabled: boolean}>} input.providers 服务元信息。
 * @param {Record<string, object>} input.results 各服务最近一次查询结果。
 * @returns {string} markdown 片段;无内容时为 ''。
 */
export function buildBalancePromptText({ lang = 'en', intervalMinutes, lastRefreshAt, providers = [], results = {} } = {}) {
  const enabled = providers.filter((p) => p.enabled)
  if (enabled.length === 0) return ''
  const lines = []
  for (const provider of enabled) {
    const label = typeof provider?.label?.[lang] === 'string' ? provider.label[lang] : String(provider?.id ?? '?')
    const result = results[provider.id]
    if (!result) {
      lines.push(`- ${label}: ${message(lang, 'promptNoKey')}`)
      continue
    }
    if (result.status === 'unconfigured') {
      lines.push(`- ${label}: ${message(lang, 'promptNoKey')}`)
      continue
    }
    if (result.status !== 'ok') {
      lines.push(`- ${label}: ${message(lang, 'promptFailed', { message: result.message ?? result.code ?? 'error' })}`)
      continue
    }
    const unit = unitWord(lang, provider.unit)
    const remaining = promptAmount(result.remaining, provider.unit)
    const total = promptAmount(result.total, provider.unit)
    let body
    if (remaining === null) {
      body = message(lang, 'promptNoReading')
    } else {
      // 货币已经带符号,再缀一个「美元/CNY」既啰嗦又难看,所以只有计数型单位才追加。
      const currency = provider.unit === 'usd' || provider.unit === 'cny'
      const unitText = currency ? '' : ` ${unit}`
      const amountText = total !== null ? `${remaining} / ${total}` : remaining
      body = message(lang, 'promptAmount', { amount: amountText, unit: unitText }).trim()
    }
    const depleted = Number.isFinite(Number(result.remaining)) && Number(result.remaining) <= 0
    lines.push(`- ${label}: ${body}${depleted ? ` (${message(lang, 'promptDepleted')})` : ''}`)
  }
  if (lines.length === 0) return ''
  const time = typeof lastRefreshAt === 'string' && lastRefreshAt.length > 0 ? new Date(lastRefreshAt).toLocaleTimeString() : null
  const meta = time === null
    ? message(lang, 'promptMetaPending', { interval: intervalMinutes })
    : message(lang, 'promptMeta', { interval: intervalMinutes, time })
  return [`## ${message(lang, 'promptTitle')}`, `(${meta})`, ...lines].join('\n')
}

// ── 状态文件 ─────────────────────────────────────────────────────────────────

/** $DSH_HOME 的解析规则与 @deepseek-ai/dsh-home-paths 一致。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

const stateDir = () => join(resolveDshHome(), 'storages', PLUGIN_ID)
const stateFile = () => join(stateDir(), 'state.json')

const emptyState = () => ({
  version: STATE_VERSION,
  config: {
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    services: PROVIDERS.map((p) => p.id),
    autoRefresh: true,
    // 默认关闭:往用户每一轮对话里塞东西,必须是用户主动开的事。
    injectBalances: false,
  },
  keys: {},
  results: {},
  lastRefreshAt: null,
})

function normalizeServices(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw === 'string' && PROVIDER_BY_ID.has(raw)) seen.add(raw)
  }
  return PROVIDERS.map((p) => p.id).filter((id) => seen.has(id))
}

function normalizeInterval(value, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return INTERVAL_CHOICES.includes(n) ? n : fallback
}

function mergeState(raw, bootConfig) {
  const base = emptyState()
  const boot = isObject(bootConfig) ? bootConfig : {}
  const saved = isObject(raw) ? raw : {}
  const savedConfig = isObject(saved.config) ? saved.config : {}
  const config = {
    intervalMinutes: normalizeInterval(
      savedConfig.intervalMinutes ?? boot.intervalMinutes,
      normalizeInterval(boot.intervalMinutes, base.config.intervalMinutes),
    ),
    services: normalizeServices(
      savedConfig.services ?? boot.services,
      normalizeServices(boot.services, base.config.services),
    ),
    autoRefresh:
      typeof savedConfig.autoRefresh === 'boolean'
        ? savedConfig.autoRefresh
        : typeof boot.autoRefresh === 'boolean'
          ? boot.autoRefresh
          : base.config.autoRefresh,
    injectBalances:
      typeof savedConfig.injectBalances === 'boolean'
        ? savedConfig.injectBalances
        : typeof boot.injectBalances === 'boolean'
          ? boot.injectBalances
          : base.config.injectBalances,
  }
  const keys = {}
  if (isObject(saved.keys)) {
    for (const [id, value] of Object.entries(saved.keys)) {
      if (PROVIDER_BY_ID.has(id) && typeof value === 'string' && value.length > 0) keys[id] = value
    }
  }
  const results = {}
  if (isObject(saved.results)) {
    for (const [id, value] of Object.entries(saved.results)) {
      if (PROVIDER_BY_ID.has(id) && isObject(value)) results[id] = value
    }
  }
  return {
    version: STATE_VERSION,
    config,
    keys,
    results,
    lastRefreshAt: typeof saved.lastRefreshAt === 'string' ? saved.lastRefreshAt : null,
  }
}

// ── 插件主体 ─────────────────────────────────────────────────────────────────

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件所属上下文。
 * @param {Record<string, unknown>} [bootConfig] cordis.patch.yml 里该行的 config。
 */
export function apply(ctx, bootConfig = {}) {
  const log = (...args) => ctx.logger?.info?.('[service-monitor]', ...args)
  const warn = (...args) => ctx.logger?.warn?.('[service-monitor]', ...args)
  const trustedHosts = new Set(
    (Array.isArray(bootConfig?.trustedHosts) ? bootConfig.trustedHosts : [])
      .filter((h) => typeof h === 'string' && h.length > 0)
      .map((h) => h.toLowerCase()),
  )

  /** 进程内运行状态:配置 + 缓存结果。持久化只是它的投影。 */
  let state = emptyState()
  let revision = 0
  let dirty = false
  let saveChain = Promise.resolve()
  let saveTimer = null
  const inflight = new Map()
  let timer = null
  let startupTimer = null
  let disposed = false

  const lang = () => {
    try {
      const active = ctx.get('locale')?.getSnapshot?.().active
      return typeof active === 'string' && active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    } catch {
      return 'en'
    }
  }
  const msg = (key, params = {}) => message(lang(), key, params)

  // ── 注入系统提示词 ────────────────────────────────────────────────────────
  //
  // systemPrompt 是可选服务:组合里没有它时,这个开关就静静地什么都不做,
  // 而不是让整个插件挂掉。用嵌套 inject 等它出现。

  let promptCtx = null
  let sectionDisposer = null

  function disposeSection() {
    if (sectionDisposer === null) return
    const disposer = sectionDisposer
    sectionDisposer = null
    try {
      disposer()
    } catch (error) {
      warn('prompt section disposal failed:', error?.message ?? error)
    }
  }

  /** 开关打开才注册段落;关掉时连空段落都不留。 */
  function syncPromptSection() {
    if (promptCtx === null || state.config.injectBalances !== true) {
      disposeSection()
      return
    }
    if (sectionDisposer !== null) return
    const snapshot = () => ({
      lang: lang(),
      intervalMinutes: state.config.intervalMinutes,
      lastRefreshAt: state.lastRefreshAt,
      providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, unit: p.unit, enabled: state.config.services.includes(p.id) })),
      results: state.results,
    })
    try {
      sectionDisposer = promptCtx.systemPrompt.section({
        name: PROMPT_SECTION_NAME,
        order: PROMPT_SECTION_ORDER,
        // 每次装配时求值,所以拿到的是缓存里的最新读数。
        text: () => buildBalancePromptText(snapshot()),
      })
    } catch (error) {
      sectionDisposer = null
      warn('could not register the prompt section:', error?.message ?? error)
    }
  }

  ctx.inject(['systemPrompt'], (scoped) => {
    promptCtx = scoped
    syncPromptSection()
    return () => {
      promptCtx = null
      disposeSection()
    }
  })

  // ── 持久化 ────────────────────────────────────────────────────────────────

  async function load() {
    try {
      const text = await readFile(stateFile(), 'utf8')
      state = mergeState(JSON.parse(text), bootConfig)
    } catch (error) {
      if (error?.code !== 'ENOENT') warn('state file unreadable, starting from defaults:', error?.message ?? error)
      state = mergeState(null, bootConfig)
      dirty = true
    }
  }

  /** 原子写:先落临时文件再 rename,避免半截 JSON 被下次启动读到。 */
  function save() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (disposed) return saveChain
    dirty = false
    const snapshot = JSON.stringify(state, null, 2)
    saveChain = saveChain
      .then(async () => {
        await mkdir(stateDir(), { recursive: true })
        const tmp = stateFile() + '.tmp'
        await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 })
        await rename(tmp, stateFile())
      })
      .catch((error) => {
        dirty = true
        warn('could not persist state:', error?.message ?? error)
      })
    return saveChain
  }

  /**
   * 合并短时间内的多次改动再落盘:一次 refreshAll 会连改 5 次 state,
   * 每次都写文件既无必要也伤盘。真正需要「回包前已持久化」的调用点
   * (配置、密钥)自己 await save()。
   */
  function scheduleSave() {
    if (saveTimer !== null || disposed) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (dirty) void save()
    }, 300)
    saveTimer.unref?.()
  }

  function touch() {
    revision += 1
    dirty = true
    scheduleSave()
  }

  // ── API Key 存取 ──────────────────────────────────────────────────────────

  const credentialService = () => {
    try {
      const service = ctx.get('credentials')
      return service && typeof service.resolve === 'function' && typeof service.set === 'function' ? service : null
    } catch {
      return null
    }
  }

  /** 解析顺序:DSH 凭据库 → 插件状态文件 → 进程环境变量。 */
  async function keyOf(provider) {
    const credentials = credentialService()
    if (credentials) {
      try {
        const resolved = await credentials.resolve(provider.envs[0])
        if (resolved && typeof resolved.value === 'string' && resolved.value.length > 0) {
          return { value: resolved.value, source: resolved.source === 'env' ? 'env' : 'credential' }
        }
      } catch (error) {
        warn(`credential resolve failed for ${provider.id}:`, error?.message ?? error)
      }
    }
    const stored = state.keys[provider.id]
    if (typeof stored === 'string' && stored.length > 0) return { value: stored, source: 'file' }
    for (const envName of provider.envs) {
      const value = process.env[envName]
      if (typeof value === 'string' && value.length > 0) return { value, source: 'env' }
    }
    return null
  }

  /**
   * 写入 Key:优先 DSH 凭据库(需目标可写),否则回落到状态文件。
   * 空字符串表示清除。
   */
  async function setKey(provider, value) {
    const credentials = credentialService()
    if (value.length === 0) {
      if (credentials) {
        try {
          await credentials.unset(provider.envs[0])
        } catch (error) {
          warn(`credential unset failed for ${provider.id}:`, error?.message ?? error)
        }
      }
      delete state.keys[provider.id]
      dirty = true
      await save()
      return { stored: 'cleared', message: msg('cleared') }
    }
    if (credentials) {
      try {
        const info = await credentials.describe(provider.envs[0])
        if (info?.writable) {
          await credentials.set(provider.envs[0], value)
          delete state.keys[provider.id]
          dirty = true
          await save()
          return { stored: 'credential' }
        }
        warn(`credential "${provider.envs[0]}" is not writable; falling back to the plugin state file`)
      } catch (error) {
        warn(`credential write failed for ${provider.id}:`, error?.message ?? error)
      }
    }
    state.keys[provider.id] = value
    dirty = true
    await save()
    return { stored: 'file' }
  }

  /** 该服务当前的 Key 来源,用于界面提示;绝不返回 Key 本身。 */
  async function keySourceOf(provider) {
    const found = await keyOf(provider)
    return found === null ? null : found.source
  }

  // ── 查询与缓存 ────────────────────────────────────────────────────────────

  function errorResult(error) {
    const code = error instanceof MonitorError ? error.code : 'unknown'
    const status = error instanceof MonitorError ? error.httpStatus : null
    let message
    switch (code) {
      case 'unauthorized':
      case 'forbidden':
      case 'rate-limited':
      case 'no-credits':
      case 'http':
        message = msg(
          code === 'no-credits'
            ? 'noCredits'
            : code === 'rate-limited'
              ? 'rateLimited'
              : code === 'forbidden'
                ? 'forbidden'
                : code === 'unauthorized'
                  ? 'unauthorized'
                  : 'http',
          { status: status ?? '?' },
        )
        break
      case 'timeout':
        message = msg('timeout', { ms: REQUEST_TIMEOUT_MS })
        break
      case 'dns':
        message = msg('dnsFailed', { host: error?.host ?? '?' })
        break
      case 'unreachable':
        message = msg('unreachable', { host: error?.host ?? '?' })
        break
      case 'network':
        message = msg('network', { message: error?.message ?? 'unknown' })
        break
      case 'parse':
        message = msg('parse')
        break
      default:
        message = error?.message ? String(error.message) : String(error)
    }
    return { status: 'error', code, message, httpStatus: status, fetchedAt: new Date().toISOString() }
  }

  /** 查询单个服务:结果写进缓存,失败也写进缓存(status:'error')。 */
  function refreshOne(provider, { force = false } = {}) {
    if (inflight.has(provider.id)) return inflight.get(provider.id)
    const job = (async () => {
      const startedAt = Date.now()
      const previous = state.results[provider.id] ?? null
      const found = await keyOf(provider)
      if (found === null) {
        state.results[provider.id] = {
          status: 'unconfigured',
          message: msg('noKey'),
          fetchedAt: new Date().toISOString(),
          latencyMs: 0,
          stale: false,
        }
        touch()
        return state.results[provider.id]
      }
      try {
        const data = await provider.query(found.value)
        state.results[provider.id] = {
          status: 'ok',
          ...data,
          keySource: found.source,
          fetchedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          stale: false,
        }
      } catch (error) {
        const failed = { ...errorResult(error), keySource: found.source, latencyMs: Date.now() - startedAt }
        // 一次瞬时失败不该让看板从「有余额」变成「全空」:保留上次的数字并标记 stale。
        const transient = ['network', 'timeout', 'dns', 'unreachable'].includes(error?.code)
        if (previous && previous.status === 'ok' && transient) {
          state.results[provider.id] = { ...previous, stale: true, staleSince: failed.fetchedAt, lastError: failed.message }
        } else {
          state.results[provider.id] = failed
        }
        if (!force) warn(`${provider.id} refresh failed:`, failed.message)
      }
      touch()
      return state.results[provider.id]
    })().finally(() => inflight.delete(provider.id))
    inflight.set(provider.id, job)
    return job
  }

  function enabledProviders() {
    return PROVIDERS.filter((p) => state.config.services.includes(p.id))
  }

  /**
   * 立刻重查一个服务,但若它恰有一次查询在途,先等它结束 —— 否则在途那次
   * (用的是旧 Key)会在我们之后落地,把新结果覆盖掉。
   */
  function refreshAfterInflight(provider) {
    const pending = inflight.get(provider.id)
    if (pending === undefined) {
      void refreshOne(provider, { force: true })
      return
    }
    void pending.finally(() => refreshOne(provider, { force: true }))
  }

  async function refreshAll({ force = false } = {}) {
    const targets = enabledProviders()
    if (targets.length === 0) return
    await Promise.all(targets.map((p) => refreshOne(p, { force })))
    state.lastRefreshAt = new Date().toISOString()
    touch()
    await save()
  }

  // ── 定时器 ────────────────────────────────────────────────────────────────

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function nextRefreshAt() {
    if (!state.config.autoRefresh) return null
    return new Date(Date.now() + state.config.intervalMinutes * 60_000).toISOString()
  }

  function schedule() {
    clearTimer()
    if (disposed || !state.config.autoRefresh) return
    timer = setTimeout(async () => {
      timer = null
      try {
        await refreshAll()
      } catch (error) {
        warn('scheduled refresh failed:', error?.message ?? error)
      }
      schedule()
    }, state.config.intervalMinutes * 60_000)
    timer.unref?.()
  }

  // ── HTTP API ──────────────────────────────────────────────────────────────

  function hostAllowed(req) {
    const host = req.headers?.host
    if (typeof host !== 'string' || host.length === 0) return false
    const authority = host.toLowerCase()
    const bare = authority.startsWith('[')
      ? authority.slice(1, authority.indexOf(']'))
      : authority.replace(/:\d+$/, '')
    if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') return true
    return trustedHosts.has(authority) || trustedHosts.has(bare)
  }

  /** 同源校验:带 Origin 的请求必须与 Host 完全一致,挡住跨站表单与脚本。 */
  function originAllowed(req) {
    const origin = req.headers?.origin
    if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return true
    try {
      return new URL(origin).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase()
    } catch {
      return false
    }
  }

  function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) throw new MonitorError('http', 'request body too large', 413)
      chunks.push(chunk)
    }
    if (size === 0) return {}
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return isObject(parsed) ? parsed : {}
    } catch {
      throw new MonitorError('parse', msg('badBody'))
    }
  }

  /** 面向前端的完整快照。不含任何 Key 材料。 */
  async function snapshot() {
    const providers = []
    for (const provider of PROVIDERS) {
      providers.push({
        id: provider.id,
        label: provider.label,
        unit: provider.unit,
        keyHint: provider.keyHint ?? null,
        consoleUrl: provider.consoleUrl,
        quotaNote: provider.quotaNote,
        envs: provider.envs,
        enabled: state.config.services.includes(provider.id),
        keySource: await keySourceOf(provider),
      })
    }
    return {
      revision,
      pluginId: PLUGIN_ID,
      config: {
        intervalMinutes: state.config.intervalMinutes,
        services: state.config.services,
        autoRefresh: state.config.autoRefresh,
        injectBalances: state.config.injectBalances === true,
      },
      intervalChoices: INTERVAL_CHOICES,
      providers,
      results: state.results,
      refreshing: [...inflight.keys()],
      lastRefreshAt: state.lastRefreshAt,
      nextRefreshAt: nextRefreshAt(),
      serverTime: new Date().toISOString(),
    }
  }

  async function handleApi(req, res, url) {
    const raw = url.pathname.slice(API_BASE.length)
    const route = raw === '' || raw === '/' ? '/state' : raw
    const method = req.method ?? 'GET'

    // 路由与方法分开判定:未知路径在任何方法下都是 404,已知路径用错方法才是 405。
    if (route !== '/state' && route !== '/health' && route !== '/config' && route !== '/key' && route !== '/refresh') {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (route === '/state') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      sendJson(res, 200, await snapshot())
      return
    }
    if (route === '/health') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      sendJson(res, 200, { ok: true, plugin: PLUGIN_ID, revision })
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { error: error?.code === 'parse' ? msg('badBody') : String(error?.message ?? error) })
      return
    }

    if (route === '/config') {
      if (body.intervalMinutes !== undefined) {
        const parsed = typeof body.intervalMinutes === 'number' ? body.intervalMinutes : Number.parseInt(String(body.intervalMinutes), 10)
        if (!INTERVAL_CHOICES.includes(parsed)) {
          sendJson(res, 400, { error: msg('badInterval') })
          return
        }
        state.config.intervalMinutes = parsed
      }
      if (body.services !== undefined) {
        if (!Array.isArray(body.services)) {
          sendJson(res, 400, { error: 'services must be an array of provider ids' })
          return
        }
        const unknown = body.services.filter((id) => typeof id === 'string' && !PROVIDER_BY_ID.has(id))
        if (unknown.length > 0) {
          sendJson(res, 400, { error: msg('unknownService', { id: unknown[0] }) })
          return
        }
        const before = new Set(state.config.services)
        state.config.services = normalizeServices(body.services, state.config.services)
        // 新启用的服务立刻查一次,否则用户要等一整个刷新周期才能看到数字。
        for (const id of state.config.services) {
          if (!before.has(id)) void refreshOne(PROVIDER_BY_ID.get(id))
        }
      }
      if (typeof body.autoRefresh === 'boolean') state.config.autoRefresh = body.autoRefresh
      if (typeof body.injectBalances === 'boolean') state.config.injectBalances = body.injectBalances
      dirty = true
      touch()
      await save()
      schedule()
      // 开/关立刻反映到提示词上,不用等下一次刷新。
      syncPromptSection()
      sendJson(res, 200, await snapshot())
      return
    }

    if (route === '/key') {
      const provider = PROVIDER_BY_ID.get(body.service)
      if (provider === undefined) {
        sendJson(res, 400, { error: msg('unknownService', { id: String(body.service ?? '') }) })
        return
      }
      const raw = typeof body.key === 'string' ? body.key.trim() : ''
      if (raw.length > 512) {
        sendJson(res, 400, { error: msg('keyTooLong') })
        return
      }
      const outcome = await setKey(provider, raw)
      // 换 Key 后旧结果立刻作废,避免看板显示上一个账号的余额。
      delete state.results[provider.id]
      touch()
      refreshAfterInflight(provider)
      sendJson(res, 200, { ...(await snapshot()), outcome })
      return
    }

    if (route === '/refresh') {
      const target = body.service
      if (target !== undefined && !PROVIDER_BY_ID.has(target)) {
        sendJson(res, 400, { error: msg('unknownService', { id: String(target) }) })
        return
      }
      const providers = target === undefined ? enabledProviders() : [PROVIDER_BY_ID.get(target)]
      // 立刻回包,让看板用 refreshing 列表显示进度;客户端随后轮询 /state。
      void Promise.all(
        providers.filter((p) => state.config.services.includes(p.id)).map((p) => refreshOne(p, { force: true })),
      )
        .then(async () => {
          state.lastRefreshAt = new Date().toISOString()
          touch()
          await save()
        })
        .catch((error) => warn('manual refresh failed:', error?.message ?? error))
      sendJson(res, 202, { started: true, services: providers.map((p) => p.id), revision })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  const handler = async (req, res) => {
    try {
      if (!hostAllowed(req) || !originAllowed(req)) {
        sendJson(res, 403, { error: msg('forbiddenHost') })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      await handleApi(req, res, url)
    } catch (error) {
      warn('request failed:', error?.message ?? error)
      try {
        sendJson(res, 500, { error: 'internal error' })
      } catch {
        /* 响应已发出 */
      }
    }
  }

  // ── 挂载 ──────────────────────────────────────────────────────────────────

  ctx.effect(() => {
    disposed = false
    return () => {
      disposed = true
      clearTimer()
      disposeSection()
      if (saveTimer !== null) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      if (startupTimer !== null) clearTimeout(startupTimer)
      startupTimer = null
    }
  }, 'service-monitor: lifecycle')

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_BASE, handler }),
    'service-monitor: api route',
  )
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: MOUNT_PATH, handler }), 'service-monitor: api entry')

  void (async () => {
    await load()
    log(`mounted at ${API_BASE}; interval ${state.config.intervalMinutes} min; services: ${state.config.services.join(', ') || 'none'}`)
    // 持久化里如果开着注入,启动时就把段落挂上。
    syncPromptSection()
    schedule()
    startupTimer = setTimeout(() => {
      startupTimer = null
      void refreshAll().catch((error) => warn('startup refresh failed:', error?.message ?? error))
    }, STARTUP_REFRESH_DELAY_MS)
    startupTimer.unref?.()
    // 首次运行(或服务列表变化)时,别让用户对着空看板发呆。
    if (dirty) await save()
  })().catch((error) => warn('initialization failed:', error?.message ?? error))
}
