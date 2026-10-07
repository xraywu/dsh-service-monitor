/**
 * Firecrawl:计费周期内剩余额度,`GET /team/credit-usage`(v2 优先,回落 v1)。
 */

import { MonitorError, fetchJson, providerMessage, requireOk } from '../net.js'
import { clampText, isObject, num } from '../util.js'

export const firecrawl = {
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
