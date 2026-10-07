/**
 * 服务注册表:五个厂商适配器的组装点。
 *
 * PROVIDERS 的顺序就是看板、注入文本与默认服务列表的顺序 —— 改它是有意的
 * 产品决定,不是内部细节。新增一个服务只要在这里加一行。
 */

import { bocha, normalizeBocha } from './bocha.js'
import { firecrawl, normalizeFirecrawl } from './firecrawl.js'
import { serpapi, normalizeSerpapi } from './serpapi.js'
import { tavily, normalizeTavily } from './tavily.js'
import { tinyfish, normalizeTinyfish } from './tinyfish.js'

/** 顺序敏感。 */
export const PROVIDERS = [tavily, bocha, firecrawl, serpapi, tinyfish]

export const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]))

// 归一化函数再导出一次:test/ 用厂商文档里的示例报文直接断言解析结果
// —— 用无效 Key 只能验证到 401,验证不到成功分支。
export { normalizeTavily, normalizeBocha, normalizeFirecrawl, normalizeSerpapi, normalizeTinyfish }
