/**
 * 查询调度:手动刷新、定时刷新、并发去重与失败归类。
 *
 * 几条不显眼但重要的规则都集中在这里:
 *   - 同一个服务同一时刻只允许一次查询在途(否则旧 Key 的结果会覆盖新结果);
 *   - 一次瞬时网络失败不清空看板,而是保留上次读数并标 stale;
 *   - 失败也写进缓存(status:'error'),界面才有话可讲。
 */

import { REQUEST_TIMEOUT_MS } from './constants.js'
import { MonitorError } from './net.js'
import { PROVIDERS } from './providers/index.js'

export function createRefresher({ store, credentials, warn, msg }) {
  const inflight = new Map()
  let timer = null
  let disposed = false

  function errorResult(error) {
    const code = error instanceof MonitorError ? error.code : 'unknown'
    const status = error instanceof MonitorError ? error.httpStatus : null
    let message
    switch (code) {
      case 'unauthorized':
      case 'forbidden':
      case 'rate-limited':
      case 'no-credits':
      case 'http':
        message = msg(
          code === 'no-credits'
            ? 'noCredits'
            : code === 'rate-limited'
              ? 'rateLimited'
              : code === 'forbidden'
                ? 'forbidden'
                : code === 'unauthorized'
                  ? 'unauthorized'
                  : 'http',
          { status: status ?? '?' },
        )
        break
      case 'timeout':
        message = msg('timeout', { ms: REQUEST_TIMEOUT_MS })
        break
      case 'dns':
        message = msg('dnsFailed', { host: error?.host ?? '?' })
        break
      case 'unreachable':
        message = msg('unreachable', { host: error?.host ?? '?' })
        break
      case 'network':
        message = msg('network', { message: error?.message ?? 'unknown' })
        break
      case 'parse':
        message = msg('parse')
        break
      default:
        message = error?.message ? String(error.message) : String(error)
    }
    return { status: 'error', code, message, httpStatus: status, fetchedAt: new Date().toISOString() }
  }

  /** 查询单个服务:结果写进缓存,失败也写进缓存(status:'error')。 */
  function refreshOne(provider, { force = false } = {}) {
    if (inflight.has(provider.id)) return inflight.get(provider.id)
    const job = (async () => {
      const state = store.state
      const startedAt = Date.now()
      const previous = state.results[provider.id] ?? null
      const found = await credentials.keyOf(provider)
      if (found === null) {
        state.results[provider.id] = {
          status: 'unconfigured',
          message: msg('noKey'),
          fetchedAt: new Date().toISOString(),
          latencyMs: 0,
          stale: false,
        }
        store.touch()
        return state.results[provider.id]
      }
      try {
        const data = await provider.query(found.value)
        state.results[provider.id] = {
          status: 'ok',
          ...data,
          keySource: found.source,
          fetchedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          stale: false,
        }
      } catch (error) {
        const failed = { ...errorResult(error), keySource: found.source, latencyMs: Date.now() - startedAt }
        // 一次瞬时失败不该让看板从「有余额」变成「全空」:保留上次的数字并标记 stale。
        const transient = ['network', 'timeout', 'dns', 'unreachable'].includes(error?.code)
        if (previous && previous.status === 'ok' && transient) {
          state.results[provider.id] = { ...previous, stale: true, staleSince: failed.fetchedAt, lastError: failed.message }
        } else {
          state.results[provider.id] = failed
        }
        if (!force) warn(`${provider.id} refresh failed:`, failed.message)
      }
      store.touch()
      return state.results[provider.id]
    })().finally(() => inflight.delete(provider.id))
    inflight.set(provider.id, job)
    return job
  }

  function enabledProviders() {
    return PROVIDERS.filter((p) => store.state.config.services.includes(p.id))
  }

  /**
   * 立刻重查一个服务,但若它恰有一次查询在途,先等它结束 —— 否则在途那次
   * (用的是旧 Key)会在我们之后落地,把新结果覆盖掉。
   */
  function refreshAfterInflight(provider) {
    const pending = inflight.get(provider.id)
    if (pending === undefined) {
      void refreshOne(provider, { force: true })
      return
    }
    void pending.finally(() => refreshOne(provider, { force: true }))
  }

  async function refreshAll({ force = false } = {}) {
    const targets = enabledProviders()
    if (targets.length === 0) return
    await Promise.all(targets.map((p) => refreshOne(p, { force })))
    store.state.lastRefreshAt = new Date().toISOString()
    store.touch()
    await store.save()
  }

  /** 快照用:哪些服务正在查询中。 */
  const refreshingIds = () => [...inflight.keys()]

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function nextRefreshAt() {
    const state = store.state
    if (!state.config.autoRefresh) return null
    return new Date(Date.now() + state.config.intervalMinutes * 60_000).toISOString()
  }

  function schedule() {
    clearTimer()
    const state = store.state
    if (disposed || !state.config.autoRefresh) return
    timer = setTimeout(async () => {
      timer = null
      try {
        await refreshAll()
      } catch (error) {
        warn('scheduled refresh failed:', error?.message ?? error)
      }
      schedule()
    }, state.config.intervalMinutes * 60_000)
    timer.unref?.()
  }

  /** 卸载:停掉定时器,不再安排新的刷新。 */
  function dispose() {
    disposed = true
    clearTimer()
  }

  return {
    refreshOne,
    refreshAll,
    enabledProviders,
    refreshAfterInflight,
    refreshingIds,
    nextRefreshAt,
    schedule,
    dispose,
  }
}
