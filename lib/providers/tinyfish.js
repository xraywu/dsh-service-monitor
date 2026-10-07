/**
 * TinyFish:预付费钱包余额,`GET /v1/wallet`。
 */

import { MonitorError, fetchJson, requireOk } from '../net.js'
import { isObject, num } from '../util.js'

export const tinyfish = {
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
