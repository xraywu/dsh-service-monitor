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

  const lang = () => {
    try {
      const active = ctx.get('locale')?.getSnapshot?.().active
      return typeof active === 'string' && active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    } catch {
      return 'en'
    }
  }
  const msg = (key, params = {}) => message(lang(), key, params)

  // ── 接线 ──────────────────────────────────────────────────────────────────
  //
  // 每个模块都是一个工厂:自己造闭包、自己管内部状态,只通过返回值暴露能力。

  const store = createStore({ bootConfig, warn })
  const credentials = createCredentials({ ctx, store, warn, msg })
  const refresher = createRefresher({ store, credentials, warn, msg })
  const promptSection = createPromptSection({ ctx, store, lang, warn })
  const handler = createApiHandler({ store, credentials, refresher, promptSection, msg, trustedHosts, warn })

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
