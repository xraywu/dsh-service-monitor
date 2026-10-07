/**
 * 同源 JSON API:客户端看板唯一的读写通道。
 *
 * 两道门禁在 handler 最外层:Host 白名单(默认只认 loopback)与 Origin 同源
 * 校验。带 Origin 的请求必须与 Host 完全一致,挡掉跨站表单与脚本;这是本地
 * 插件唯一可能被网页碰到的地方,所以校验失败一律 403。
 *
 * 注意:所有对 store.state 的读取都写在用它的那一刻,不提前存进局部变量 ——
 * store.load() 会整块替换状态对象,缓存引用会读到替换前的那一份。
 */

import { API_BASE, BODY_LIMIT_BYTES, INTERVAL_CHOICES, PLUGIN_ID } from './constants.js'
import { normalizeServices } from './config.js'
import { MonitorError } from './net.js'
import { PROVIDER_BY_ID, PROVIDERS } from './providers/index.js'
import { isObject } from './util.js'

/**
 * @param {{store: object, credentials: object, refresher: object, promptSection: object,
 *          msg: Function, trustedHosts: Set<string>, warn: Function}} deps
 * @returns {(req: object, res: object) => Promise<void>} HTTP handler
 */
export function createApiHandler({ store, credentials, refresher, promptSection, msg, trustedHosts, warn }) {
  function hostAllowed(req) {
    const host = req.headers?.host
    if (typeof host !== 'string' || host.length === 0) return false
    const authority = host.toLowerCase()
    const bare = authority.startsWith('[')
      ? authority.slice(1, authority.indexOf(']'))
      : authority.replace(/:\d+$/, '')
    if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') return true
    return trustedHosts.has(authority) || trustedHosts.has(bare)
  }

  /** 同源校验:带 Origin 的请求必须与 Host 完全一致,挡住跨站表单与脚本。 */
  function originAllowed(req) {
    const origin = req.headers?.origin
    if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return true
    try {
      return new URL(origin).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase()
    } catch {
      return false
    }
  }

  function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) throw new MonitorError('http', 'request body too large', 413)
      chunks.push(chunk)
    }
    if (size === 0) return {}
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return isObject(parsed) ? parsed : {}
    } catch {
      throw new MonitorError('parse', msg('badBody'))
    }
  }

  /** 面向前端的完整快照。不含任何 Key 材料。 */
  async function snapshot() {
    const providers = []
    for (const provider of PROVIDERS) {
      providers.push({
        id: provider.id,
        label: provider.label,
        unit: provider.unit,
        keyHint: provider.keyHint ?? null,
        consoleUrl: provider.consoleUrl,
        quotaNote: provider.quotaNote,
        envs: provider.envs,
        enabled: store.state.config.services.includes(provider.id),
        keySource: await credentials.keySourceOf(provider),
      })
    }
    return {
      revision: store.revision,
      pluginId: PLUGIN_ID,
      config: {
        intervalMinutes: store.state.config.intervalMinutes,
        services: store.state.config.services,
        autoRefresh: store.state.config.autoRefresh,
        injectBalances: store.state.config.injectBalances === true,
      },
      intervalChoices: INTERVAL_CHOICES,
      providers,
      results: store.state.results,
      refreshing: refresher.refreshingIds(),
      lastRefreshAt: store.state.lastRefreshAt,
      nextRefreshAt: refresher.nextRefreshAt(),
      serverTime: new Date().toISOString(),
    }
  }

  async function handleApi(req, res, url) {
    const raw = url.pathname.slice(API_BASE.length)
    const route = raw === '' || raw === '/' ? '/state' : raw
    const method = req.method ?? 'GET'

    // 路由与方法分开判定:未知路径在任何方法下都是 404,已知路径用错方法才是 405。
    if (route !== '/state' && route !== '/health' && route !== '/config' && route !== '/key' && route !== '/refresh') {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (route === '/state') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      sendJson(res, 200, await snapshot())
      return
    }
    if (route === '/health') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      sendJson(res, 200, { ok: true, plugin: PLUGIN_ID, revision: store.revision })
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { error: error?.code === 'parse' ? msg('badBody') : String(error?.message ?? error) })
      return
    }

    if (route === '/config') {
      if (body.intervalMinutes !== undefined) {
        const parsed = typeof body.intervalMinutes === 'number' ? body.intervalMinutes : Number.parseInt(String(body.intervalMinutes), 10)
        if (!INTERVAL_CHOICES.includes(parsed)) {
          sendJson(res, 400, { error: msg('badInterval') })
          return
        }
        store.state.config.intervalMinutes = parsed
      }
      if (body.services !== undefined) {
        if (!Array.isArray(body.services)) {
          sendJson(res, 400, { error: 'services must be an array of provider ids' })
          return
        }
        const unknown = body.services.filter((id) => typeof id === 'string' && !PROVIDER_BY_ID.has(id))
        if (unknown.length > 0) {
          sendJson(res, 400, { error: msg('unknownService', { id: unknown[0] }) })
          return
        }
        const before = new Set(store.state.config.services)
        store.state.config.services = normalizeServices(body.services, store.state.config.services)
        // 新启用的服务立刻查一次,否则用户要等一整个刷新周期才能看到数字。
        for (const id of store.state.config.services) {
          if (!before.has(id)) void refresher.refreshOne(PROVIDER_BY_ID.get(id))
        }
      }
      if (typeof body.autoRefresh === 'boolean') store.state.config.autoRefresh = body.autoRefresh
      if (typeof body.injectBalances === 'boolean') store.state.config.injectBalances = body.injectBalances
      store.touch()
      await store.save()
      refresher.schedule()
      // 开/关立刻反映到提示词上,不用等下一次刷新。
      promptSection.sync()
      sendJson(res, 200, await snapshot())
      return
    }

    if (route === '/key') {
      const provider = PROVIDER_BY_ID.get(body.service)
      if (provider === undefined) {
        sendJson(res, 400, { error: msg('unknownService', { id: String(body.service ?? '') }) })
        return
      }
      const value = typeof body.key === 'string' ? body.key.trim() : ''
      if (value.length > 512) {
        sendJson(res, 400, { error: msg('keyTooLong') })
        return
      }
      const outcome = await credentials.setKey(provider, value)
      // 换 Key 后旧结果立刻作废,避免看板显示上一个账号的余额。
      delete store.state.results[provider.id]
      store.touch()
      refresher.refreshAfterInflight(provider)
      sendJson(res, 200, { ...(await snapshot()), outcome })
      return
    }

    if (route === '/refresh') {
      const target = body.service
      if (target !== undefined && !PROVIDER_BY_ID.has(target)) {
        sendJson(res, 400, { error: msg('unknownService', { id: String(target) }) })
        return
      }
      const targets = target === undefined ? refresher.enabledProviders() : [PROVIDER_BY_ID.get(target)]
      // 立刻回包,让看板用 refreshing 列表显示进度;客户端随后轮询 /state。
      void Promise.all(
        targets
          .filter((p) => store.state.config.services.includes(p.id))
          .map((p) => refresher.refreshOne(p, { force: true })),
      )
        .then(async () => {
          store.state.lastRefreshAt = new Date().toISOString()
          store.touch()
          await store.save()
        })
        .catch((error) => warn('manual refresh failed:', error?.message ?? error))
      sendJson(res, 202, { started: true, services: targets.map((p) => p.id), revision: store.revision })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  return async function handler(req, res) {
    try {
      if (!hostAllowed(req) || !originAllowed(req)) {
        sendJson(res, 403, { error: msg('forbiddenHost') })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      await handleApi(req, res, url)
    } catch (error) {
      warn('request failed:', error?.message ?? error)
      try {
        sendJson(res, 500, { error: 'internal error' })
      } catch {
        /* 响应已发出 */
      }
    }
  }
}
