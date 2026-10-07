/**
 * 把余额写进系统提示词末尾的那一段。
 *
 * 这是插件唯一一处会影响模型输入的行为,所以它有两个刻意的形状:
 *   - 文本由一个纯函数生成,测试可以直接喂数据断言;
 *   - 段落只在开关打开时注册,关掉时连空段落都不留。
 */

import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER } from './constants.js'
import { message } from './messages.js'
import { PROVIDERS } from './providers/index.js'

/** 注入文本里的金额格式,跟界面保持一致的写法。 */
function promptAmount(value, unit) {
  if (value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (unit === 'usd') return `$${n.toFixed(2)}`
  if (unit === 'cny') return `¥${n.toFixed(2)}`
  return String(Math.round(n * 100) / 100)
}

const unitWord = (lang, unit) =>
  message(lang, `unit${unit === 'usd' ? 'Usd' : unit === 'cny' ? 'Cny' : unit === 'requests' ? 'Requests' : 'Credits'}`)

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

/**
 * 管理提示词段落的注册与注销。
 *
 * systemPrompt 是可选服务:组合里没有它时,这个开关就静静地什么都不做,
 * 而不是让整个插件挂掉。用嵌套 inject 等它出现。
 *
 * @param {{ctx: object, store: object, lang: () => 'zh'|'en', warn: Function}} deps
 * @returns {{sync: () => void, dispose: () => void}}
 */
export function createPromptSection({ ctx, store, lang, warn }) {
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
  function sync() {
    const state = store.state
    if (promptCtx === null || state.config.injectBalances !== true) {
      disposeSection()
      return
    }
    if (sectionDisposer !== null) return
    const snapshot = () => ({
      lang: lang(),
      intervalMinutes: store.state.config.intervalMinutes,
      lastRefreshAt: store.state.lastRefreshAt,
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        unit: p.unit,
        enabled: store.state.config.services.includes(p.id),
      })),
      results: store.state.results,
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
    sync()
    return () => {
      promptCtx = null
      disposeSection()
    }
  })

  return { sync, dispose: disposeSection }
}
