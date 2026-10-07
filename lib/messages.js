/**
 * 用户可见的服务端文案(zh/en),随宿主语言选择。
 *
 * 只放宿主侧产生的文案:客户端自己那份字典在 client.js 里 —— 浏览器半边
 * 是单文件加载,拿不到相对导入,两边无法共享这一张表。
 */

const MESSAGES = {
  zh: {
    noKey: '尚未配置 API Key',
    unauthorized: 'API Key 无效或已过期(HTTP {status})',
    forbidden: '该 API Key 无权访问余额接口(HTTP {status})',
    noCredits: '额度已用尽(HTTP 402):请到厂商控制台充值',
    rateLimited: '请求过于频繁(HTTP 429),请稍后重试',
    http: '接口返回 HTTP {status}',
    network: '网络请求失败:{message}',
    dnsFailed: '域名解析失败({host}):本机 DNS 可能被污染或未联网',
    unreachable: '连不上 {host}(超时或被拒绝):该服务在当前网络下可能不可达;如走代理,请为 DSH 进程配置代理',
    timeout: '请求超时({ms} 毫秒未响应)',
    parse: '响应不是预期的 JSON 结构',
    unknownService: '未知的服务:{id}',
    badInterval: '刷新间隔只能是 1、5、10、30 分钟',
    badBody: '请求体不是合法 JSON',
    forbiddenHost: '请求来源不被信任',
    keyTooLong: 'API Key 过长',
    keyEmpty: 'API Key 不能为空',
    cleared: 'API Key 已移除',
    // 注入上下文用的文案
    promptTitle: '第三方服务余额',
    promptMeta: '每 {interval} 分钟刷新 · 更新于 {time}',
    promptMetaPending: '每 {interval} 分钟刷新 · 尚未取到数据',
    promptAmount: '剩余 {amount}{unit}',
    promptNoReading: '暂无数值',
    promptDepleted: '已耗尽',
    promptNoKey: '未配置 API Key',
    promptFailed: '查询失败 —— {message}',
    unitCredits: '额度',
    unitRequests: '次',
    unitUsd: '美元',
    unitCny: '元',
  },
  en: {
    noKey: 'No API key configured yet',
    unauthorized: 'API key is invalid or expired (HTTP {status})',
    forbidden: 'This API key may not read the usage endpoint (HTTP {status})',
    noCredits: 'Credits exhausted (HTTP 402) — top up in the vendor console',
    rateLimited: 'Rate limited (HTTP 429), try again later',
    http: 'Endpoint returned HTTP {status}',
    network: 'Network request failed: {message}',
    dnsFailed: 'DNS lookup failed for {host}: the local resolver may be poisoned or offline',
    unreachable: 'Could not reach {host} (timeout or refused): the service may be unreachable on this network; configure a proxy for the DSH process if you use one',
    timeout: 'Request timed out (no response within {ms} ms)',
    parse: 'Response was not the expected JSON shape',
    unknownService: 'Unknown service: {id}',
    badInterval: 'Refresh interval must be 1, 5, 10 or 30 minutes',
    badBody: 'Request body is not valid JSON',
    forbiddenHost: 'Request origin is not trusted',
    keyTooLong: 'API key is too long',
    keyEmpty: 'API key must not be empty',
    cleared: 'API key removed',
    // copy for the injected context block
    promptTitle: 'Third-party service balances',
    promptMeta: 'refreshed every {interval} min · as of {time}',
    promptMetaPending: 'refreshed every {interval} min · no reading yet',
    promptAmount: '{amount}{unit} remaining',
    promptNoReading: 'no readable value',
    promptDepleted: 'depleted',
    promptNoKey: 'no API key configured',
    promptFailed: 'query failed — {message}',
    unitCredits: 'credits',
    unitRequests: 'requests',
    unitUsd: 'USD',
    unitCny: 'CNY',
  },
}

/**
 * 渲染一条文案。纯函数,所以注入上下文的文本能在 test/ 里直接断言 ——
 * 那段文字会进入每一轮模型请求,值得有个测试盯着。
 */
export function message(lang, key, params = {}) {
  const dict = MESSAGES[lang] ?? MESSAGES.en
  const template = dict[key] ?? MESSAGES.en[key] ?? key
  return String(template).replace(/\{(\w+)\}/g, (_, name) => (name in params ? String(params[name]) : `{${name}}`))
}
