/**
 * ScrapingBee: 网页抓取额度, `GET /api/v1/usage`。
 */

import { MonitorError, fetchJson, requireOk } from '../net.js'
import { clampText, isObject, num } from '../util.js'

export const scrapingbee = {
  id: 'scrapingbee',
  label: { zh: 'ScrapingBee 抓取', en: 'ScrapingBee' },
  unit: 'credits',
  envs: ['SCRAPINGBEE_API_KEY'],
  keyHint: null,
  consoleUrl: 'https://app.scrapingbee.com/account/register',
  quotaNote: { zh: '计费周期内剩余额度', en: 'API credits left this cycle' },
  async query(key) {
    const body = requireOk(
      await fetchJson('https://app.scrapingbee.com/api/v1/usage', {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      }),
    )
    return normalizeScrapingbee(body)
  },
}

/**
 * ScrapingBee `GET /api/v1/usage`
 * 响应结构:
 * {
 *   max_api_credit: 20000000,
 *   used_api_credit: 3704332,
 *   max_concurrency: 200,
 *   current_concurrency: 1,
 *   renewal_subscription_date: "2022-04-18T10:05:58.134716"
 * }
 */
export function normalizeScrapingbee(body) {
  if (!isObject(body)) throw new MonitorError('parse', 'unexpected ScrapingBee payload')
  const total = num(body.max_api_credit)
  const used = num(body.used_api_credit)
  if (total === null && used === null) {
    throw new MonitorError('parse', 'missing ScrapingBee credit figures')
  }

  const remaining = total !== null && used !== null ? Math.max(0, total - used) : null
  const extra = []
  const maxConcurrency = num(body.max_concurrency)
  if (maxConcurrency !== null) extra.push({ key: 'maxConcurrency', value: String(maxConcurrency) })
  const currentConcurrency = num(body.current_concurrency)
  if (currentConcurrency !== null) extra.push({ key: 'currentConcurrency', value: String(currentConcurrency) })

  return {
    remaining,
    total,
    used,
    unit: 'credits',
    plan: null,
    resetsAt: clampText(body.renewal_subscription_date, 40),
    extra,
  }
}
