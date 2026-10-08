/**
 * 状态文件的形状与位置,以及「存下来的东西」如何与「cordis.patch.yml 里的
 * bootConfig」合并。
 *
 * 全是纯函数(文件路径除外),所以合并规则可以在 test/ 里直接喂数据验证。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_INTERVAL_MINUTES,
  INJECT_NOTE_MAX_LENGTH,
  INTERVAL_CHOICES,
  PLUGIN_ID,
  STATE_VERSION,
} from './constants.js'
import { PROVIDERS, PROVIDER_BY_ID } from './providers/index.js'
import { isObject } from './util.js'

/** $DSH_HOME 的解析规则与 @deepseek-ai/dsh-home-paths 一致。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

export const stateDir = () => join(resolveDshHome(), 'storages', PLUGIN_ID)
export const stateFile = () => join(stateDir(), 'state.json')

export const emptyState = () => ({
  version: STATE_VERSION,
  config: {
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    services: PROVIDERS.map((p) => p.id),
    autoRefresh: true,
    // 默认关闭:往用户每一轮对话里塞东西,必须是用户主动开的事。
    injectBalances: false,
    // 注入的额外指导文案。null = 用内置默认(messages 里的 promptNoteDefault),
    // 所以「从没写过」和「清空了」是同一件事:都回到默认文案。
    injectNote: null,
  },
  keys: {},
  results: {},
  lastRefreshAt: null,
})

export function normalizeServices(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw === 'string' && PROVIDER_BY_ID.has(raw)) seen.add(raw)
  }
  return PROVIDERS.map((p) => p.id).filter((id) => seen.has(id))
}

export function normalizeInterval(value, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return INTERVAL_CHOICES.includes(n) ? n : fallback
}

/**
 * 注入用的补充说明:只有「非空的、不超长的字符串」才算设置过。
 * 空串、超长、非字符串一律退回 fallback(null 表示用内置默认文案)。
 */
export function normalizeInjectNote(value, fallback = null) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > INJECT_NOTE_MAX_LENGTH) return fallback
  return trimmed
}

/**
 * 合并优先级:状态文件 → bootConfig → 默认值。
 *
 * 状态文件优先是刻意的:用户在界面上的选择比配置文件里的初值更接近意图,
 * 而 bootConfig 只在「这次是第一次运行」或字段缺失时起作用。
 */
export function mergeState(raw, bootConfig) {
  const base = emptyState()
  const boot = isObject(bootConfig) ? bootConfig : {}
  const saved = isObject(raw) ? raw : {}
  const savedConfig = isObject(saved.config) ? saved.config : {}
  const config = {
    intervalMinutes: normalizeInterval(
      savedConfig.intervalMinutes ?? boot.intervalMinutes,
      normalizeInterval(boot.intervalMinutes, base.config.intervalMinutes),
    ),
    services: normalizeServices(
      savedConfig.services ?? boot.services,
      normalizeServices(boot.services, base.config.services),
    ),
    autoRefresh:
      typeof savedConfig.autoRefresh === 'boolean'
        ? savedConfig.autoRefresh
        : typeof boot.autoRefresh === 'boolean'
          ? boot.autoRefresh
          : base.config.autoRefresh,
    injectBalances:
      typeof savedConfig.injectBalances === 'boolean'
        ? savedConfig.injectBalances
        : typeof boot.injectBalances === 'boolean'
          ? boot.injectBalances
          : base.config.injectBalances,
  }
  const keys = {}
  if (isObject(saved.keys)) {
    for (const [id, value] of Object.entries(saved.keys)) {
      if (PROVIDER_BY_ID.has(id) && typeof value === 'string' && value.length > 0) keys[id] = value
    }
  }
  const results = {}
  if (isObject(saved.results)) {
    for (const [id, value] of Object.entries(saved.results)) {
      if (PROVIDER_BY_ID.has(id) && isObject(value)) results[id] = value
    }
  }
  return {
    version: STATE_VERSION,
    config,
    keys,
    results,
    lastRefreshAt: typeof saved.lastRefreshAt === 'string' ? saved.lastRefreshAt : null,
  }
}
