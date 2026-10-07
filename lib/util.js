/**
 * 与具体厂商无关的小工具。
 *
 * 这个模块不 import 任何东西,是整棵树的最底层,任何模块都可以依赖它。
 */

export const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 数字字段的宽容读取:很多网关把数字以字符串返回("10820856.78")。 */
export const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim().length > 0) {
    const parsed = Number(v)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export const clampText = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : null)
