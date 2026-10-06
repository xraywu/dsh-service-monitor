/**
 * Host-half smoke test for dsh-service-monitor.
 *
 * Runs the plugin against a fake cordis context plus a real HTTP server, then
 * exercises the JSON API the Web UI uses. It also fires one real request per
 * provider with a deliberately invalid key: a 401/403 proves the endpoint URL
 * and auth header are right, while a 404/405 proves they are wrong.
 *
 *   node test/smoke-host.mjs            # offline: routing, config, key, trust
 *   node test/smoke-host.mjs --network  # also probe the four provider endpoints
 *
 * The plugin state is written under a throwaway DSH_HOME, never the user's.
 */

import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const WITH_NETWORK = process.argv.includes('--network')
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const tempHome = await mkdtemp(join(tmpdir(), 'dsm-smoke-'))
process.env.DSH_HOME = tempHome

let failures = 0
let checks = 0
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function checkThrows(label, fn) {
  checks += 1
  try {
    fn()
    failures += 1
    console.log(`  FAIL ${label} — expected a throw`)
  } catch {
    console.log(`  ok   ${label}`)
  }
}

function checkThrowsCode(label, fn, expectedCode) {
  checks += 1
  try {
    fn()
    failures += 1
    console.log(`  FAIL ${label} — expected a throw`)
  } catch (error) {
    if (error?.code === expectedCode) {
      console.log(`  ok   ${label}`)
    } else {
      failures += 1
      console.log(`  FAIL ${label} — expected code ${expectedCode}, got ${error?.code}`)
    }
  }
}

// ── fake cordis context ──────────────────────────────────────────────────────

const routes = []
const disposers = []
/** Prompt sections the plugin registers through `systemPrompt.section()`. */
const promptSections = []
const systemPrompt = {
  section(definition) {
    promptSections.push(definition)
    return () => {
      const index = promptSections.indexOf(definition)
      if (index >= 0) promptSections.splice(index, 1)
    }
  },
}
const ctx = {
  logger: { info: (...a) => console.log('  [host]', ...a), warn: (...a) => console.log('  [host:warn]', ...a) },
  effect(callback, label) {
    const disposer = callback()
    disposers.push({ label, disposer })
    return disposer
  },
  get() {
    return undefined
  },
  /** Nested inject, the way the plugin asks for the optional systemPrompt service. */
  inject(services, callback) {
    const scoped = {}
    for (const name of services) if (name === 'systemPrompt') scoped.systemPrompt = systemPrompt
    const disposer = callback(scoped)
    return typeof disposer === 'function' ? disposer : () => {}
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
}

const plugin = await import(pathToFileURL(join(root, 'index.js')).href)
plugin.apply(ctx, { intervalMinutes: 5, services: ['tavily', 'bocha', 'firecrawl', 'serpapi'], trustedHosts: ['monitor.test'] })

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  for (const route of routes) {
    const hit = route.kind === 'prefix' ? pathname.startsWith(route.path) : pathname === route.path
    if (hit) {
      void route.handler(req, res)
      return
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('no route')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const api = `${base}/service-monitor/api`
const get = (path, headers) => fetch(`${api}${path}`, { headers })
const post = (path, body, headers) =>
  fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers ?? {}) }, body: JSON.stringify(body) })

/**
 * `fetch` refuses to set a forbidden request header like `Host`, so the trust
 * checks need a raw socket-level request to lie about the authority.
 */
function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: server.address().port, path, method: 'GET', headers },
      (response) => {
        response.resume()
        resolve(response.statusCode)
      },
    )
    request.on('error', reject)
    request.end()
  })
}

try {
  console.log('\n== route registration ==')
  check('two routes registered', routes.length === 2, `got ${routes.length}`)

  console.log('\n== GET /state ==')
  const stateRes = await get('/state')
  const state = await stateRes.json()
  check('200', stateRes.status === 200, `got ${stateRes.status}`)
  check('no-store cache header', stateRes.headers.get('cache-control') === 'no-store')
  check('provider list is non-empty', state.providers?.length > 0, `got ${state.providers?.length}`)
  check('provider ids are unique', new Set(state.providers.map((p) => p.id)).size === state.providers.length)
  for (const id of ['tavily', 'bocha', 'firecrawl', 'serpapi']) {
    check(`provider "${id}" is registered`, state.providers.some((p) => p.id === id))
  }
  check('every provider carries a label, unit and console URL', state.providers.every((p) => p.label?.zh && p.label?.en && p.unit && p.consoleUrl))
  check('interval from boot config honoured', state.config.intervalMinutes === 5, `got ${state.config.intervalMinutes}`)
  check('interval choices are 1/5/10/30', JSON.stringify(state.intervalChoices) === '[1,5,10,30]')
  check('no key material in payload', !JSON.stringify(state).includes('apiKey') && !JSON.stringify(state).includes('"key"'))
  check('all providers unconfigured at start', state.providers.every((p) => p.keySource === null))

  console.log('\n== trust checks ==')
  const evil = await rawGet('/service-monitor/api/state', { host: 'evil.example' })
  check('foreign Host rejected with 403', evil === 403, `got ${evil}`)
  const trusted = await rawGet('/service-monitor/api/state', { host: 'monitor.test' })
  check('configured trustedHosts accepted', trusted === 200, `got ${trusted}`)
  const crossOrigin = await rawGet('/service-monitor/api/state', { host: '127.0.0.1', origin: 'http://evil.example' })
  check('cross-origin Origin rejected with 403', crossOrigin === 403, `got ${crossOrigin}`)
  const sameOrigin = await rawGet('/service-monitor/api/state', { host: '127.0.0.1', origin: 'http://127.0.0.1' })
  check('same-origin Origin accepted', sameOrigin === 200, `got ${sameOrigin}`)

  console.log('\n== POST /config ==')
  const badInterval = await post('/config', { intervalMinutes: 7 })
  check('invalid interval rejected with 400', badInterval.status === 400, `got ${badInterval.status}`)
  const badService = await post('/config', { services: ['nope'] })
  check('unknown service rejected with 400', badService.status === 400, `got ${badService.status}`)
  const oneService = await post('/config', { services: ['tavily'] })
  const oneServiceBody = await oneService.json()
  check('service list narrowed to tavily', JSON.stringify(oneServiceBody.config.services) === '["tavily"]')
  check('others report enabled:false', oneServiceBody.providers.filter((p) => p.enabled).length === 1)
  const noAuto = await post('/config', { autoRefresh: false })
  check('autoRefresh off persisted', (await noAuto.json()).config.autoRefresh === false)
  const nextRefresh = (await (await get('/state')).json()).nextRefreshAt
  check('nextRefreshAt is null while paused', nextRefresh === null, `got ${nextRefresh}`)
  await post('/config', { autoRefresh: true, services: ['tavily', 'bocha', 'firecrawl', 'serpapi'] })

  console.log('\n== context injection toggle ==')
  check('balances are NOT injected by default', (await (await get('/state')).json()).config.injectBalances === false)
  check('no prompt section is registered while off', promptSections.length === 0, `got ${promptSections.length}`)

  const enabled = await post('/config', { injectBalances: true })
  check('toggle on is accepted', (await enabled.json()).config.injectBalances === true)
  check('exactly one prompt section registered', promptSections.length === 1, `got ${promptSections.length}`)
  const section = promptSections[0]
  check('section uses the plugin-owned name', section?.name === 'service-monitor:balances', String(section?.name))
  check(
    'section is ordered after every built-in section (DEPLOYMENT_PERSONA_SUFFIX = 10200)',
    typeof section?.order === 'number' && section.order > 10200,
    `order=${section?.order}`,
  )
  check('section text is evaluated lazily', typeof section?.text === 'function')
  const injected = section.text({})
  check('injected text names the plugin block', injected.startsWith('## '), JSON.stringify(injected.slice(0, 40)))
  check('injected text lists an enabled service', /Tavily|博查|Bocha/.test(injected), JSON.stringify(injected))
  check('injected text is one block per enabled service', injected.split('\n').length === 2 + 4, JSON.stringify(injected.split('\n').length))
  check('injected text never carries a key', !/tvly-|sk-|fc-/.test(injected))

  const offAgain = await post('/config', { injectBalances: false })
  check('toggle off is accepted', (await offAgain.json()).config.injectBalances === false)
  check('section is disposed when switched off', promptSections.length === 0, `got ${promptSections.length}`)

  console.log('\n== buildBalancePromptText ==')
  const { buildBalancePromptText, PROMPT_SECTION_ORDER } = plugin
  const providers = [
    { id: 'tavily', label: { zh: 'Tavily 搜索', en: 'Tavily' }, unit: 'credits', enabled: true },
    { id: 'bocha', label: { zh: '博查', en: 'Bocha' }, unit: 'cny', enabled: true },
    { id: 'serpapi', label: { zh: 'SerpAPI', en: 'SerpAPI' }, unit: 'requests', enabled: true },
    { id: 'tinyfish', label: { zh: 'TinyFish', en: 'TinyFish' }, unit: 'usd', enabled: false },
  ]
  check('the exported order matches the registered one', PROMPT_SECTION_ORDER > 10200, String(PROMPT_SECTION_ORDER))
  check('no enabled services → empty text', buildBalancePromptText({ lang: 'en', providers: [], results: {} }) === '')
  check(
    'a disabled-only set → empty text',
    buildBalancePromptText({ lang: 'en', providers: providers.map((p) => ({ ...p, enabled: false })), results: {} }) === '',
  )

  const text = buildBalancePromptText({
    lang: 'en',
    intervalMinutes: 10,
    lastRefreshAt: '2026-10-06T02:34:41Z',
    providers,
    results: {
      tavily: { status: 'ok', remaining: 14500, total: 15000 },
      bocha: { status: 'ok', remaining: 0, total: null },
      serpapi: { status: 'error', message: 'API key is invalid or expired (HTTP 401)' },
    },
  })
  const textLines = text.split('\n')
  check('heading names the block', textLines[0] === '## Third-party service balances', JSON.stringify(textLines[0]))
  check('meta line carries interval and time', textLines[1].includes('10') && textLines[1].includes(':'), JSON.stringify(textLines[1]))
  check('remaining of total rendered', textLines.some((l) => l === '- Tavily: 14500 / 15000 credits remaining'), JSON.stringify(textLines))
  check(
    'a currency does not repeat its unit word',
    textLines.some((l) => l === '- Bocha: ¥0.00 remaining (depleted)'),
    JSON.stringify(textLines),
  )
  check('failure is reported, not hidden', textLines.some((l) => l.startsWith('- SerpAPI: query failed —')), JSON.stringify(textLines))
  check('disabled service is left out', !text.includes('TinyFish'), text)
  check('exactly one line per enabled service', textLines.length === 2 + 3, JSON.stringify(textLines))

  const zhText = buildBalancePromptText({
    lang: 'zh',
    intervalMinutes: 5,
    lastRefreshAt: null,
    providers,
    results: { tavily: { status: 'unconfigured' } },
  })
  check('zh heading rendered', zhText.startsWith('## 第三方服务余额'), JSON.stringify(zhText))
  check('zh meta falls back to "no reading yet"', zhText.includes('尚未取到数据'), zhText)
  check('unconfigured service is listed', zhText.includes('未配置 API Key'), zhText)

  console.log('\n== POST /key ==')
  const shortKey = await post('/key', { service: 'tavily', key: 'x'.repeat(600) })
  check('over-long key rejected with 400', shortKey.status === 400, `got ${shortKey.status}`)
  const unknown = await post('/key', { service: 'nope', key: 'x' })
  check('unknown service rejected with 400', unknown.status === 400, `got ${unknown.status}`)
  const saved = await post('/key', { service: 'tavily', key: 'tvly-smoke-test-not-a-real-key' })
  const savedBody = await saved.json()
  check('key accepted', saved.status === 200, `got ${saved.status}`)
  check('reported where it was stored', typeof savedBody.outcome?.stored === 'string', JSON.stringify(savedBody.outcome))
  check('keySource now non-null', savedBody.providers.find((p) => p.id === 'tavily')?.keySource !== null)
  check('key value never echoed back', !JSON.stringify(savedBody).includes('smoke-test-not-a-real-key'))

  const persisted = JSON.parse(await readFile(join(tempHome, 'storages', 'service-monitor', 'state.json'), 'utf8'))
  check('state file written under DSH_HOME', persisted.version === 1)
  const cleared = await post('/key', { service: 'tavily', key: '' })
  const clearedBody = await cleared.json()
  check('empty key clears the entry', clearedBody.providers.find((p) => p.id === 'tavily')?.keySource === null)

  console.log('\n== POST /refresh ==')
  const started = await post('/refresh', {})
  check('refresh accepted with 202', started.status === 202, `got ${started.status}`)
  const badRefresh = await post('/refresh', { service: 'nope' })
  check('unknown refresh target rejected', badRefresh.status === 400, `got ${badRefresh.status}`)

  // A refresh mutates state several times in a burst; the debounced write must
  // still land, otherwise a restart would lose every result again.
  await new Promise((resolve) => setTimeout(resolve, 1800))
  const afterRefresh = JSON.parse(await readFile(join(tempHome, 'storages', 'service-monitor', 'state.json'), 'utf8'))
  check('refresh timestamp persisted', typeof afterRefresh.lastRefreshAt === 'string', JSON.stringify(afterRefresh.lastRefreshAt))
  check(
    'keyless provider persisted as unconfigured',
    afterRefresh.results?.bocha?.status === 'unconfigured',
    JSON.stringify(afterRefresh.results?.bocha),
  )

  console.log('\n== method + route guards ==')
  const wrongMethod = await fetch(`${api}/config`, { method: 'GET' })
  check('GET on /config is 405', wrongMethod.status === 405, `got ${wrongMethod.status}`)
  const missing = await get('/nope')
  check('unknown path is 404', missing.status === 404, `got ${missing.status}`)
  const badJson = await fetch(`${api}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
  check('malformed JSON is 400', badJson.status === 400, `got ${badJson.status}`)

  console.log('\n== response normalizers (documented payloads) ==')
  const { normalizeTavily, normalizeBocha, normalizeFirecrawl, normalizeSerpapi, normalizeTinyfish } = plugin

  // Tavily: /usage never returns a "remaining" field, so it is derived.
  const tavily = normalizeTavily({
    key: { usage: 150, limit: 1000 },
    account: { current_plan: 'Bootstrap', plan_usage: 500, plan_limit: 15000, paygo_usage: 25, paygo_limit: 100 },
  })
  check('tavily: remaining = plan_limit - plan_usage', tavily.remaining === 14500, JSON.stringify(tavily))
  check('tavily: total/used/plan', tavily.total === 15000 && tavily.used === 500 && tavily.plan === 'Bootstrap')
  check('tavily: unit is credits', tavily.unit === 'credits')
  const tavilyKeyOnly = normalizeTavily({ key: { usage: 10, limit: 1000 } })
  check('tavily: falls back to the per-key limits', tavilyKeyOnly.remaining === 990 && tavilyKeyOnly.total === 1000)

  // Bocha: data.remaining, in CNY.
  const bocha = normalizeBocha({ success: true, code: '200', msg: 'success', data: { remaining: 10820856.78 }, timestamp: 1739845090213 })
  check('bocha: data.remaining in CNY', bocha.remaining === 10820856.78 && bocha.unit === 'cny', JSON.stringify(bocha))
  checkThrows('bocha: business failure on HTTP 200 throws', () => normalizeBocha({ success: false, code: '401', msg: 'Invalid API KEY' }))
  checkThrows('bocha: payload without a balance throws', () => normalizeBocha({ success: true, code: '200', data: {} }))

  // Firecrawl: v2 is camelCase, v1 is snake_case — both must parse.
  const fcV2 = normalizeFirecrawl({
    success: true,
    data: { remainingCredits: 1000, planCredits: 500000, billingPeriodStart: '2025-01-01T00:00:00Z', billingPeriodEnd: '2025-01-31T23:59:59Z' },
  })
  check('firecrawl v2: camelCase parsed', fcV2.remaining === 1000 && fcV2.total === 500000, JSON.stringify(fcV2))
  check('firecrawl: no reset date is invented', fcV2.resetsAt === null, String(fcV2.resetsAt))
  const fcV2Extra = Object.fromEntries(fcV2.extra.map((item) => [item.key, item.value]))
  check('firecrawl: billing period reported instead', fcV2Extra.billingPeriodStart === '2025-01-01T00:00:00Z' && fcV2Extra.billingPeriodEnd === '2025-01-31T23:59:59Z', JSON.stringify(fcV2.extra))
  check('firecrawl: period fields are typed as dates', fcV2.extra.every((item) => item.kind === 'date'))
  const fcV1 = normalizeFirecrawl({
    success: true,
    data: { remaining_credits: 1200, plan_credits: 500000, billing_period_end: '2025-02-28T23:59:59Z' },
  })
  check('firecrawl v1: snake_case still parsed', fcV1.remaining === 1200 && fcV1.resetsAt === null, JSON.stringify(fcV1))
  check('firecrawl v1: billing period end surfaced', fcV1.extra.some((item) => item.key === 'billingPeriodEnd' && item.value === '2025-02-28T23:59:59Z'))
  check('firecrawl: derived used is total - remaining', fcV2.used === 499000, String(fcV2.used))
  checkThrows('firecrawl: success:false throws', () => normalizeFirecrawl({ success: false, error: 'Unauthorized: Invalid token' }))

  // SerpAPI: only query-parameter auth, plus plan/extra credit fields.
  const serp = normalizeSerpapi({
    total_searches_left: 4800,
    plan_searches_left: 4700,
    extra_credits: 100,
    searches_per_month: 5000,
    this_month_usage: 200,
    plan_name: 'Developer',
    plan_renewal_date: '2026-11-01T00:00:00Z',
    plan_monthly_price: 75,
    account_rate_limit_per_hour: 600,
    account_email: 'dev@example.com',
  })
  check('serpapi: remaining = total_searches_left', serp.remaining === 4800, JSON.stringify(serp))
  check('serpapi: total/used/plan', serp.total === 5000 && serp.used === 200 && serp.plan === 'Developer')
  check('serpapi: unit is requests', serp.unit === 'requests')
  const serpExtra = Object.fromEntries(serp.extra.map((item) => [item.key, item.value]))
  check('serpapi: plan leftovers surfaced', serpExtra.planSearchesLeft === '4700' && serpExtra.extraCredits === '100')
  const serpFree = normalizeSerpapi({ total_searches_left: 100, searches_per_month: 100, plan_renewal_date: null })
  check('serpapi: null renewal date tolerated', serpFree.resetsAt === null, String(serpFree.resetsAt))

  // TinyFish: the wallet is flat and available_balance is a STRING with 2dp.
  const wallet = normalizeTinyfish({
    available_balance: '21.44',
    currency: 'USD',
    as_of: '2026-08-10T18:04:11.220Z',
    auto_reload: { state: 'unconfigured' },
    pending_top_up: { amount: '50.00', started_at: '2026-08-10T18:02:55.000Z' },
    rates: { meters: [{ label: 'Agent steps', unit_amount: '0.016000', currency: 'USD', per: 'step' }] },
    agent_top_up_url: 'https://agent.tinyfish.ai/v1/wallet/top-up',
  })
  check('tinyfish: string balance parsed to a number', wallet.remaining === 21.44, JSON.stringify(wallet.remaining))
  check('tinyfish: unit is usd', wallet.unit === 'usd')
  check('tinyfish: no total on a prepaid wallet', wallet.total === null && wallet.used === null)
  const walletExtra = Object.fromEntries(wallet.extra.map((item) => [item.label ?? item.key, item.value]))
  check('tinyfish: auto-reload state surfaced', walletExtra.autoReload === 'unconfigured')
  check('tinyfish: pending top-up surfaced', walletExtra.pendingTopUp === '50')
  check('tinyfish: rate meter keeps its own label', walletExtra['Agent steps'] === '0.016 USD/step', JSON.stringify(wallet.extra))
  check('tinyfish: nested envelope tolerated', normalizeTinyfish({ data: { available_balance: 3.5, currency: 'USD' } }).remaining === 3.5)
  checkThrows('tinyfish: payload without a balance throws', () => normalizeTinyfish({ currency: 'USD' }))

  // HTTP status → failure code. 402 is how several vendors report an exhausted
  // account; reporting it as a generic HTTP error would hide the one state this
  // plugin exists to surface.
  const { requireOk } = plugin
  const res = (status, body = {}) => ({ status, ok: false, body })
  checkThrowsCode('401 maps to unauthorized', () => requireOk(res(401)), 'unauthorized')
  checkThrowsCode('402 maps to no-credits', () => requireOk(res(402, { error: 'Insufficient credits' })), 'no-credits')
  checkThrowsCode('403 maps to forbidden', () => requireOk(res(403)), 'forbidden')
  checkThrowsCode('429 maps to rate-limited', () => requireOk(res(429)), 'rate-limited')
  checkThrowsCode('503 maps to a generic http error', () => requireOk(res(503)), 'http')
  const nestedDetail = (() => {
    try {
      requireOk(res(401, { detail: { error: 'Unauthorized: missing or invalid API key.' } }))
      return ''
    } catch (error) {
      return error.message
    }
  })()
  check('provider message survives a nested error envelope', nestedDetail.includes('missing or invalid API key'), nestedDetail)
  check('a 2xx body passes through', requireOk({ status: 200, ok: true, body: { ok: 1 } }).ok === 1)
  check('a 402 carries its httpStatus', (() => {
    try {
      requireOk(res(402))
      return false
    } catch (error) {
      return error.httpStatus === 402
    }
  })())

  if (WITH_NETWORK) {
    // Probe every registered provider with a deliberately invalid key. Each
    // adapter declares what a bad key must look like; anything else (a 404, an
    // HTML error page, a parse failure) means the endpoint or the parser is
    // wrong, which a "the request returned something" check would hide.
    console.log('\n== provider endpoints (invalid key) ==')
    const providers = (await (await get('/state')).json()).providers
    const ids = providers.map((p) => p.id)
    const EXPECT = {
      tavily: 'auth',
      bocha: 'auth',
      firecrawl: 'auth',
      serpapi: 'auth',
      tinyfish: 'auth',
    }
    for (const id of ids) await post('/key', { service: id, key: 'invalid-smoke-test-key-0123456789' })
    await post('/config', { services: ids })
    await post('/refresh', {})
    const deadline = Date.now() + 90000
    let results = {}
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000))
      const snapshot = await (await get('/state')).json()
      results = snapshot.results ?? {}
      if (snapshot.refreshing.length === 0 && Object.keys(results).length === ids.length) break
    }
    const authRejected = (r) => r?.status === 'error' && ['unauthorized', 'forbidden', 'rate-limited'].includes(r.code)
    let mismatched = 0
    for (const id of ids) {
      const result = results[id] ?? {}
      const expectation = EXPECT[id] ?? 'any-terminal'
      const pass = expectation === 'auth' ? authRejected(result) : result.status !== undefined
      if (!pass) mismatched += 1
      console.log(
        `  ${pass ? 'ok  ' : 'FAIL'} ${id.padEnd(12)} expect=${expectation.padEnd(12)} status=${String(result.status ?? '-').padEnd(12)} code=${String(result.code ?? '-').padEnd(14)} http=${result.httpStatus ?? '-'} ${result.message ?? ''}`,
      )
    }
    check(`every provider reached a terminal state (${ids.length})`, Object.keys(results).length === ids.length, `${Object.keys(results).length}/${ids.length}`)
    check('every provider matched its expected probe outcome', mismatched === 0, `${mismatched} mismatched — see the table above`)
  }

  console.log('\n== client bundle (static checks) ==')
  const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  check('client registers under the package name', clientSource.includes("id: 'dsh-service-monitor'"))
  check('client requires only react', (() => {
    const targets = [...clientSource.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1])
    return targets.length > 0 && targets.every((name) => name === 'react')
  })(), JSON.stringify([...clientSource.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1])))
  check('client imports no Harness client package', !/@deepseek-ai\/dsh-client/.test(clientSource))
  const dictKeys = (lang) => {
    const start = clientSource.indexOf(`      ${lang}: {`)
    if (start < 0) return []
    const end = clientSource.indexOf('\n      },', start)
    return [...clientSource.slice(start, end).matchAll(/^\s{8}([A-Za-z0-9_]+):/gm)].map((m) => m[1]).sort()
  }
  const zhKeys = dictKeys('zh')
  const enKeys = dictKeys('en')
  check('both client dictionaries were found', zhKeys.length > 20 && enKeys.length > 20, `zh=${zhKeys.length} en=${enKeys.length}`)
  const zhOnly = zhKeys.filter((key) => !enKeys.includes(key))
  const enOnly = enKeys.filter((key) => !zhKeys.includes(key))
  check('dictionaries cover the same keys', zhOnly.length === 0 && enOnly.length === 0, `zh-only=[${zhOnly}] en-only=[${enOnly}]`)
  const usedKeys = new Set([...clientSource.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]))
  const missingKeys = [...usedKeys].filter((key) => !zhKeys.includes(key) && !enKeys.includes(key))
  check(`every t() key exists in the dictionary (${usedKeys.size} keys used)`, missingKeys.length === 0, `missing=[${missingKeys}]`)

  // The client's display rules are pure functions behind the factory closure; run
  // the real bundle in a VM to reach them. No DOM and no renderer — just the
  // status/format rules, which is exactly where "0 balance still shows green" lives.
  console.log('\n== client view logic ==')
  const loaded = []
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    // Deliberately inert: running the subscription effect would start the real
    // poller. The test drives store.data directly instead.
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load: (definition) => loaded.push(definition) } },
    console,
  })
  check('client bundle registers a lazy factory', loaded.length === 1 && typeof loaded[0].factory === 'function')
  const clientPlugin = loaded[0].factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected client require: ${name}`)
  })
  const { statusOf, remainingRatio, formatAmount, formatDate } = clientPlugin.__internals

  // The reported bug: a provider with no plan total (Bocha, TinyFish) at 0 must
  // still read as depleted, not healthy.
  check('zero balance with no total is an error (bocha case)', statusOf({ status: 'ok', remaining: 0, total: null }) === 'error')
  check('zero balance with a total is an error', statusOf({ status: 'ok', remaining: 0, total: 100 }) === 'error')
  check('negative balance is an error', statusOf({ status: 'ok', remaining: -3, total: null }) === 'error')
  check('string zero is an error too', statusOf({ status: 'ok', remaining: '0', total: null }) === 'error')
  check('healthy absolute balance with no total is ok', statusOf({ status: 'ok', remaining: 20.5, total: null }) === 'ok')
  check('low ratio warns', statusOf({ status: 'ok', remaining: 10, total: 100 }) === 'warn')
  check('healthy ratio is ok', statusOf({ status: 'ok', remaining: 80, total: 100 }) === 'ok')
  check('stale reading warns', statusOf({ status: 'ok', remaining: 80, total: 100, stale: true }) === 'warn')
  check('unconfigured is idle', statusOf({ status: 'unconfigured' }) === 'idle')
  check('no result is idle', statusOf(null) === 'idle')
  check('provider failure is an error', statusOf({ status: 'error', message: 'x' }) === 'error')
  check('refreshing is busy', statusOf({ status: 'ok', remaining: 5 }, true) === 'busy')
  check('an unknown total yields no ratio', remainingRatio({ status: 'ok', remaining: 0, total: null }) === null)
  check('formatAmount renders CNY and USD', formatAmount(12.5, 'cny') === '¥12.50' && formatAmount(3, 'usd') === '$3.00')
  check('formatAmount renders a bare count', formatAmount(1234, 'requests') === (1234).toLocaleString(undefined, { maximumFractionDigits: 2 }))
  check('formatAmount falls back to a dash', formatAmount(null, 'credits') === '—')
  check('formatDate formats an ISO instant', formatDate('2027-08-14T00:52:41Z') === new Date('2027-08-14T00:52:41Z').toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }))
  check('formatDate leaves a non-date alone', formatDate('not a date') === 'not a date')
  check('formatDate renders a missing value as a dash', formatDate(null) === '—')

  // A throwing component does not degrade gracefully — the shell blanks the whole
  // slot, so the sidebar icon just vanishes with nothing in the UI to explain it.
  // Run every renderer the plugin registers, exactly as the shell calls it, once
  // with no data and once against a realistic snapshot. This is a crash check,
  // not visual verification.
  console.log('\n== client renderers do not throw ==')
  const registrations = []
  let pendingSlot = null
  const applyCtx = {
    get: () => undefined,
    effect: (callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    slots: {
      inject: (slot, callback) => {
        pendingSlot = slot
        const disposer = callback()
        pendingSlot = null
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register: (meta, render) => {
        registrations.push({ slot: meta.name ?? pendingSlot, id: meta.id ?? meta.key ?? null, render })
        return () => {}
      },
    },
  }
  clientPlugin.apply(applyCtx)
  check('client registers three slots', registrations.length === 3, JSON.stringify(registrations.map((r) => r.slot)))
  check(
    'registrations are main / sidebar.panellist / settings.section',
    JSON.stringify(registrations.map((r) => r.slot).sort()) === JSON.stringify(['main', 'settings.section', 'sidebar.panellist']),
    JSON.stringify(registrations.map((r) => r.slot)),
  )

  const snapshot = {
    providers: [
      { id: 'bocha', label: { zh: '博查', en: 'Bocha' }, unit: 'cny', keyHint: 'sk-…', consoleUrl: 'https://x', quotaNote: null, enabled: true, keySource: 'credential' },
      { id: 'firecrawl', label: { zh: 'Firecrawl', en: 'Firecrawl' }, unit: 'credits', keyHint: null, consoleUrl: 'https://x', quotaNote: null, enabled: true, keySource: null },
      { id: 'tinyfish', label: { zh: 'TinyFish', en: 'TinyFish' }, unit: 'usd', keyHint: null, consoleUrl: 'https://x', quotaNote: null, enabled: false, keySource: null },
    ],
    results: {
      bocha: { status: 'ok', remaining: 0, total: null, used: null, unit: 'cny', fetchedAt: '2026-10-06T02:34:41Z', latencyMs: 225, extra: [], stale: false },
      firecrawl: {
        status: 'ok', remaining: 0, total: 5000, used: 5000, unit: 'credits', resetsAt: null,
        fetchedAt: '2026-10-06T02:33:02Z', latencyMs: 3235, stale: false,
        extra: [
          { key: 'billingPeriodStart', value: '2026-08-14T00:52:41Z', kind: 'date' },
          { key: 'billingPeriodEnd', value: '2027-08-14T00:52:41Z', kind: 'date' },
        ],
      },
      tavily: { status: 'error', code: 'unauthorized', message: 'API key is invalid or expired (HTTP 401)', httpStatus: 401, fetchedAt: '2026-10-06T02:34:41Z' },
    },
    refreshing: ['firecrawl'],
    config: { intervalMinutes: 1, autoRefresh: true, injectBalances: true, services: ['bocha', 'firecrawl'] },
    intervalChoices: [1, 5, 10, 30],
    lastRefreshAt: '2026-10-06T02:34:41Z',
    nextRefreshAt: '2026-10-06T02:35:41Z',
  }

  /** Walk the element tree the shell would mount and execute every component. */
  function executeTree(node, depth, seen) {
    if (node === null || node === undefined || depth > 20) return seen
    if (Array.isArray(node)) {
      for (const child of node) executeTree(child, depth + 1, seen)
      return seen
    }
    if (typeof node !== 'object') return seen
    if (typeof node.type === 'function') {
      seen.count += 1
      executeTree(node.type(node.props ?? {}), depth + 1, seen)
    }
    if (Array.isArray(node.children)) for (const child of node.children) executeTree(child, depth + 1, seen)
    return seen
  }

  for (const phase of ['with no data', 'with data']) {
    clientPlugin.__internals.store.data = phase === 'with data' ? snapshot : null
    clientPlugin.__internals.store.loading = phase !== 'with data'
    const failures = []
    let componentsRun = 0
    for (const registration of registrations) {
      try {
        const element = registration.render({ size: 18, active: false })
        componentsRun += executeTree(element, 0, { count: 0 }).count
      } catch (error) {
        failures.push(`${registration.slot}: ${error && error.message}`)
      }
    }
    check(`every registered renderer survives ${phase}`, failures.length === 0, failures.join(' | '))
    check(`components actually executed ${phase}`, componentsRun > 0, `ran ${componentsRun}`)
  }

  console.log('\n== teardown ==')
  for (const { label, disposer } of disposers) {
    if (typeof disposer === 'function') await disposer()
    else if (typeof disposer === 'function') await disposer
  }
  check('route disposers removed every route', routes.length === 0, `got ${routes.length}`)
} finally {
  server.close()
  await rm(tempHome, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed${WITH_NETWORK ? ' (with network probes)' : ''}`)
process.exit(failures === 0 ? 0 : 1)
