/**
 * SearchApi.io: 搜索额度与使用量, `GET /api/v1/me`。
 */

import { MonitorError, fetchJson, requireOk } from '../net.js'
import { clampText, isObject, num } from '../util.js'

export const searchapi = {
  id: 'searchapi',
  label: { zh: 'SearchApi 搜索', en: 'SearchApi' },
  unit: 'requests',
  envs: ['SEARCHAPI_API_KEY', 'SEARCH_API_KEY'],
  keyHint: null,
  consoleUrl: 'https://www.searchapi.io/users/sign_up',
  quotaNote: { zh: '本月剩余搜索额度', en: 'Search credits left this month' },
  async query(key) {
    const body = requireOk(
      await fetchJson('https://www.searchapi.io/api/v1/me', {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      }),
    )
    return normalizeSearchapi(body)
  },
}

/**
 * SearchApi `GET /api/v1/me`
 * 响应结构:
 * {
 *   account: { current_month_usage, monthly_allowance, remaining_credits },
 *   api_usage: { searches_this_hour, hourly_rate_limit },
 *   subscription: { period_start, period_end }
 * }
 */
export function normalizeSearchapi(body) {
  if (!isObject(body)) throw new MonitorError('parse', 'unexpected SearchApi payload')
  const account = isObject(body.account) ? body.account : {}
  const apiUsage = isObject(body.api_usage) ? body.api_usage : {}
  const subscription = isObject(body.subscription) ? body.subscription : {}

  const remaining = num(account.remaining_credits)
  const total = num(account.monthly_allowance)
  const used = num(account.current_month_usage)

  if (remaining === null && total === null && used === null) {
    throw new MonitorError('parse', 'missing SearchApi account usage figures')
  }

  const extra = []
  const hourly = num(apiUsage.hourly_rate_limit)
  if (hourly !== null) extra.push({ key: 'rateLimitPerHour', value: String(hourly) })
  const searchesHour = num(apiUsage.searches_this_hour)
  if (searchesHour !== null) extra.push({ key: 'searchesThisHour', value: String(searchesHour) })
  if (subscription.period_start) extra.push({ key: 'billingPeriodStart', value: clampText(subscription.period_start, 40), kind: 'date' })
  if (subscription.period_end) extra.push({ key: 'billingPeriodEnd', value: clampText(subscription.period_end, 40), kind: 'date' })

  return {
    remaining: remaining !== null ? remaining : total !== null && used !== null ? Math.max(0, total - used) : null,
    total,
    used,
    unit: 'requests',
    plan: null,
    resetsAt: clampText(subscription.period_end, 40),
    extra,
  }
}
