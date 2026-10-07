/**
 * 博查 Bocha:账户余额,单位为元,`GET /v1/fund/remaining`。
 */

import { MonitorError, fetchJson, requireOk } from '../net.js'
import { isObject, num } from '../util.js'

export const bocha = {
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
