/**
 * SerpAPI:本月剩余搜索次数,`GET /account.json` —— 认证只走 query 参数。
 */

import { MonitorError, fetchJson, requireOk } from '../net.js'
import { clampText, isObject, num } from '../util.js'

export const serpapi = {
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
}

/** SerpAPI `GET /account.json` 的响应归一化。 */
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
