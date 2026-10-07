/**
 * API Key 的解析、写入与来源标注。
 *
 * 三条铁律:
 *   1. 解析顺序是 DSH 凭据库 → 插件状态文件 → 进程环境变量;
 *   2. 写入优先走凭据库,只有它不可写时才回落到状态文件;
 *   3. 对外只回答「Key 从哪来」,永远不把 Key 本身交给任何调用方。
 */

export function createCredentials({ ctx, store, warn, msg }) {
  /** 每次都重新取:凭据服务可能在插件加载之后才就绪。 */
  const credentialService = () => {
    try {
      const service = ctx.get('credentials')
      return service && typeof service.resolve === 'function' && typeof service.set === 'function' ? service : null
    } catch {
      return null
    }
  }

  /** 解析顺序:DSH 凭据库 → 插件状态文件 → 进程环境变量。 */
  async function keyOf(provider) {
    const credentials = credentialService()
    if (credentials) {
      try {
        const resolved = await credentials.resolve(provider.envs[0])
        if (resolved && typeof resolved.value === 'string' && resolved.value.length > 0) {
          return { value: resolved.value, source: resolved.source === 'env' ? 'env' : 'credential' }
        }
      } catch (error) {
        warn(`credential resolve failed for ${provider.id}:`, error?.message ?? error)
      }
    }
    const stored = store.state.keys[provider.id]
    if (typeof stored === 'string' && stored.length > 0) return { value: stored, source: 'file' }
    for (const envName of provider.envs) {
      const value = process.env[envName]
      if (typeof value === 'string' && value.length > 0) return { value, source: 'env' }
    }
    return null
  }

  /**
   * 写入 Key:优先 DSH 凭据库(需目标可写),否则回落到状态文件。
   * 空字符串表示清除。
   */
  async function setKey(provider, value) {
    const credentials = credentialService()
    if (value.length === 0) {
      if (credentials) {
        try {
          await credentials.unset(provider.envs[0])
        } catch (error) {
          warn(`credential unset failed for ${provider.id}:`, error?.message ?? error)
        }
      }
      delete store.state.keys[provider.id]
      await store.save()
      return { stored: 'cleared', message: msg('cleared') }
    }
    if (credentials) {
      try {
        const info = await credentials.describe(provider.envs[0])
        if (info?.writable) {
          await credentials.set(provider.envs[0], value)
          delete store.state.keys[provider.id]
          await store.save()
          return { stored: 'credential' }
        }
        warn(`credential "${provider.envs[0]}" is not writable; falling back to the plugin state file`)
      } catch (error) {
        warn(`credential write failed for ${provider.id}:`, error?.message ?? error)
      }
    }
    store.state.keys[provider.id] = value
    await store.save()
    return { stored: 'file' }
  }

  /** 该服务当前的 Key 来源,用于界面提示;绝不返回 Key 本身。 */
  async function keySourceOf(provider) {
    const found = await keyOf(provider)
    return found === null ? null : found.source
  }

  return { keyOf, setKey, keySourceOf }
}
