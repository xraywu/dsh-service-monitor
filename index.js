/**
 * dsh-service-monitor — 宿主半边 / host half。
 *
 * 单一 Loader 行(见 cordis.patch.yml)挂载本模块,它只做三件事:
 *   1. 声明插件契约(name / inject);
 *   2. 造出各模块并接线;
 *   3. 注册生命周期与 HTTP 路由。
 *
 * 实现按职责拆在 lib/ 下:状态与持久化(lib/store.js)、API Key
 * (lib/credentials.js)、查询与调度(lib/refresh.js)、提示词注入
 * (lib/prompt.js)、HTTP API(lib/api.js)、五个厂商适配器
 * (lib/providers/*)。依赖方向严格单向,见各文件头部;lib/ 内部的模块
 * 都能脱离本文件单独 import 并喂假依赖测试。
 *
 * 只使用 Node 内建能力与 ctx 服务,不 import 任何 @deepseek-ai/* 运行时包:
 * 插件安装在 profile 的 node_modules 下,那里没有这些包。因此 credential ref
 * 只按名字构造(credentialRef 在运行时就是原字符串)。
 */

import { API_BASE, MOUNT_PATH, STARTUP_REFRESH_DELAY_MS } from './lib/constants.js'
import { createApiHandler } from './lib/api.js'
import { createCredentials } from './lib/credentials.js'
import { createPromptSection } from './lib/prompt.js'
import { createRefresher } from './lib/refresh.js'
import { createStore } from './lib/store.js'
import { message } from './lib/messages.js'

export const name = 'service-monitor'

/** `webServer` 是硬依赖:没有 HTTP 载体就没有这个插件。 */
export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件所属上下文。
 * @param {Record<string, unknown>} [bootConfig] cordis.patch.yml 里该行的 config。
 */
export function apply(ctx, bootConfig = {}) {
  const log = (...args) => ctx.logger?.info?.('[service-monitor]', ...args)
  const warn = (...args) => ctx.logger?.warn?.('[service-monitor]', ...args)
  const trustedHosts = new Set(
    (Array.isArray(bootConfig?.trustedHosts) ? bootConfig.trustedHosts : [])
      .filter((h) => typeof h === 'string' && h.length > 0)
      .map((h) => h.toLowerCase()),
  )

  // 宿主侧没有 `locale` 服务：locale 是浏览器半边的插件，宿主只持久化偏好。
  // 语言决策优先级：
  // 1. 用户显式选过界面语言时，读取宿主 settings 服务的 `locale.preference`（优先）；
  // 2. 前端客户端上报的当前活动语言（Web 页面交互时上报）；
  // 3. 宿主系统的本地化语言环境（Intl / process.env.LANG，在中文系统下默认使用中文）。
  const LOCALE_SETTINGS_NS = 'locale'
  const LOCALE_PREFERENCE_FIELD = 'preference'

  const readLocalePreference = () => {
    try {
      const settings = ctx.get?.('settings')
      if (!settings || typeof settings.describe !== 'function') return undefined
      const rows = settings.describe()
      if (!Array.isArray(rows)) return undefined
      const row =
        rows.find((entry) => entry?.ns === LOCALE_SETTINGS_NS) ??
        rows.find((entry) => typeof entry?.ns === 'string' && entry.ns.endsWith(`/${LOCALE_SETTINGS_NS}`))
      const preference = row?.value?.[LOCALE_PREFERENCE_FIELD]
      return typeof preference === 'string' ? preference : undefined
    } catch {
      return undefined
    }
  }

  const detectSystemZh = () => {
    try {
      const loc = Intl.DateTimeFormat().resolvedOptions().locale
      if (typeof loc === 'string' && loc.toLowerCase().startsWith('zh')) return true
    } catch {}
    try {
      const env = process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE
      if (typeof env === 'string' && env.toLowerCase().startsWith('zh')) return true
    } catch {}
    return false
  }

  let clientLang = undefined

  /** @returns {'zh' | 'en'} 宿主文案与提示词注入使用的语言。 */
  const lang = () => {
    const preference = readLocalePreference()
    if (typeof preference === 'string' && preference.length > 0) {
      return preference.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }
    if (clientLang === 'zh' || clientLang === 'en') {
      return clientLang
    }
    return detectSystemZh() ? 'zh' : 'en'
  }
  const msg = (key, params = {}) => message(lang(), key, params)

  const onClientLang = (nextLang) => {
    if (typeof nextLang === 'string') {
      const normalized = nextLang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      if (clientLang !== normalized) {
        clientLang = normalized
        promptSection?.sync?.()
      }
    }
  }

  // ── 接线 ──────────────────────────────────────────────────────────────────
  //
  // 每个模块都是一个工厂:自己造闭包、自己管内部状态,只通过返回值暴露能力。

  const store = createStore({ bootConfig, warn })
  const credentials = createCredentials({ ctx, store, warn, msg })
  const refresher = createRefresher({ store, credentials, warn, msg })
  const promptSection = createPromptSection({ ctx, store, lang, warn })
  const handler = createApiHandler({ store, credentials, refresher, promptSection, msg, trustedHosts, onClientLang, warn })

  let startupTimer = null

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  ctx.effect(() => {
    return () => {
      // 卸载顺序无所谓,四个 dispose 互不依赖。都没有返回值,所以不会拦住退出。
      store.dispose()
      refresher.dispose()
      promptSection.dispose()
      if (startupTimer !== null) clearTimeout(startupTimer)
      startupTimer = null
    }
  }, 'service-monitor: lifecycle')

  // ── 挂载 ──────────────────────────────────────────────────────────────────

  // MOUNT_PATH 收一个精确路由,是为了让客户端「探测插件是否在」时不必依赖
  // 前缀匹配的行为;真正的 API 都挂在 API_BASE 前缀下。
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_BASE, handler }),
    'service-monitor: api route',
  )
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: MOUNT_PATH, handler }), 'service-monitor: api entry')

  void (async () => {
    await store.load()
    log(
      `mounted at ${API_BASE}; interval ${store.state.config.intervalMinutes} min; services: ${store.state.config.services.join(', ') || 'none'}`,
    )
    // 持久化里如果开着注入,启动时就把段落挂上。
    promptSection.sync()
    refresher.schedule()
    startupTimer = setTimeout(() => {
      startupTimer = null
      void refresher.refreshAll().catch((error) => warn('startup refresh failed:', error?.message ?? error))
    }, STARTUP_REFRESH_DELAY_MS)
    startupTimer.unref?.()
    // 首次运行(或服务列表变化)时,别让用户对着空看板发呆。
    if (store.dirty) await store.save()
  })().catch((error) => warn('initialization failed:', error?.message ?? error))
}
