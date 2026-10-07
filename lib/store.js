/**
 * 状态仓库:进程内的配置与缓存结果,持久化只是它的投影。
 *
 * 这里刻意保持「唯一可变对象」的形态 —— 所有模块通过 `store.state` 读到同一
 * 个对象并就地修改,只有 load() 会替换对象身份(所以外部必须用 getter 读,
 * 不能把 state 提前缓存到本地变量里)。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import { emptyState, mergeState, stateDir, stateFile } from './config.js'

export function createStore({ bootConfig, warn }) {
  let state = emptyState()
  let revision = 0
  let dirty = false
  let saveChain = Promise.resolve()
  let saveTimer = null
  let disposed = false

  async function load() {
    try {
      const text = await readFile(stateFile(), 'utf8')
      state = mergeState(JSON.parse(text), bootConfig)
    } catch (error) {
      if (error?.code !== 'ENOENT') warn('state file unreadable, starting from defaults:', error?.message ?? error)
      state = mergeState(null, bootConfig)
      dirty = true
    }
  }

  /** 原子写:先落临时文件再 rename,避免半截 JSON 被下次启动读到。 */
  function save() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (disposed) return saveChain
    dirty = false
    const snapshot = JSON.stringify(state, null, 2)
    saveChain = saveChain
      .then(async () => {
        await mkdir(stateDir(), { recursive: true })
        const tmp = stateFile() + '.tmp'
        await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 })
        await rename(tmp, stateFile())
      })
      .catch((error) => {
        dirty = true
        warn('could not persist state:', error?.message ?? error)
      })
    return saveChain
  }

  /**
   * 合并短时间内的多次改动再落盘:一次 refreshAll 会连改 5 次 state,
   * 每次都写文件既无必要也伤盘。真正需要「回包前已持久化」的调用点
   * (配置、密钥)自己 await save()。
   */
  function scheduleSave() {
    if (saveTimer !== null || disposed) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (dirty) void save()
    }, 300)
    saveTimer.unref?.()
  }

  /** 标记读数已变,让客户端能区分「同一份数据」与「新数据」。 */
  function touch() {
    revision += 1
    dirty = true
    scheduleSave()
  }

  /** 卸载:停掉防抖写盘,不再接受新的持久化。 */
  function dispose() {
    disposed = true
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  return {
    /** 读值而非缓存引用:load() 会整块替换这个对象。 */
    get state() {
      return state
    },
    get revision() {
      return revision
    },
    /** 首次运行时为 true —— 调用方据此把默认配置落一次盘。 */
    get dirty() {
      return dirty
    },
    load,
    save,
    scheduleSave,
    touch,
    dispose,
  }
}
