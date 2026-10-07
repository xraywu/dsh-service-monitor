/**
 * Tavily:按月套餐额度,`GET /usage`。
 */

import { MonitorError, fetchJson, requireOk } from '../net.js'
import { clampText, isObject, num } from '../util.js'

export const tavily = {
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
}

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
