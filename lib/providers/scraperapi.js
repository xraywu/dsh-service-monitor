/**
 * ScraperAPI: 网页抓取请求量, `GET /account`。
 */

import { MonitorError, fetchJson, requireOk } from '../net.js'
import { isObject, num } from '../util.js'

export const scraperapi = {
  id: 'scraperapi',
  label: { zh: 'ScraperAPI 抓取', en: 'ScraperAPI' },
  unit: 'requests',
  envs: ['SCRAPERAPI_API_KEY', 'SCRAPER_API_KEY'],
  keyHint: null,
  consoleUrl: 'https://dashboard.scraperapi.com/signup',
  quotaNote: { zh: '本周期剩余请求数', en: 'Requests left this billing cycle' },
  async query(key) {
    const url = `https://api.scraperapi.com/account?api_key=${encodeURIComponent(key)}`
    const body = requireOk(await fetchJson(url, { headers: { accept: 'application/json' } }))
    return normalizeScraperapi(body)
  },
}

/**
 * ScraperAPI `GET https://api.scraperapi.com/account?api_key=...`
 * 响应结构:
 * {
 *   requestCount: 100,
 *   failedRequestCount: 2,
 *   requestLimit: 5000,
 *   concurrencyLimit: 5
 * }
 */
export function normalizeScraperapi(body) {
  if (!isObject(body)) throw new MonitorError('parse', 'unexpected ScraperAPI payload')
  const used = num(body.requestCount)
  const total = num(body.requestLimit)
  if (total === null && used === null) {
    throw new MonitorError('parse', 'missing ScraperAPI request count figures')
  }

  const remaining = total !== null && used !== null ? Math.max(0, total - used) : null
  const extra = []
  const concurrency = num(body.concurrencyLimit)
  if (concurrency !== null) extra.push({ key: 'concurrencyLimit', value: String(concurrency) })
  const failed = num(body.failedRequestCount)
  if (failed !== null && failed > 0) extra.push({ key: 'failedRequests', value: String(failed) })

  return {
    remaining,
    total,
    used,
    unit: 'requests',
    plan: null,
    resetsAt: null,
    extra,
  }
}
