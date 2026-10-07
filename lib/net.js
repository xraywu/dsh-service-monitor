/**
 * 出网请求与错误分类:所有网络行为都经过这里,厂商适配器只负责拼 URL 和解析。
 *
 * 这一层存在的主要理由是「把失败讲清楚」:连不上、Key 不对、限流是三件不同
 * 的事,而 fetch 抛出来的原始错误对用户等于没说。
 */

import { REQUEST_TIMEOUT_MS } from './constants.js'
import { clampText, isObject } from './util.js'

/** 带 code 的查询失败,便于客户端区分「没配 Key」与「Key 失效」。 */
export class MonitorError extends Error {
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
export async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
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
export function providerMessage(body, depth = 0) {
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
