/**
 * dsh-service-monitor — 客户端半边 / client half.
 *
 * 由 __ModuleLoader__ 懒加载,id 与包名一致。只用 react(来自浏览器的模块表)
 * 与自带 CSS,不 import 任何 Harness Client 包:那些包会随时改名,而一个抛错的
 * 组件会把整个槽位渲染成空白。
 *
 * 三处注册,一个身份(panel id = 'service-monitor'):
 *   - main(keyed)            : 主面板看板,侧边栏点选后由外壳渲染;
 *   - sidebar.panellist(list): 侧边栏状态图标,外壳负责按钮、标签与选中态;
 *   - settings.section(list)  : 「设置 → 服务余额监控」同一页,便于找到填 Key 的入口。
 *
 * 数据面:宿主在同源 {MOUNT}/api 上暴露 JSON 接口。三个注册共用模块级 store,
 * 因此无论挂载几个界面,同一时刻只有一个轮询器。
 */
window.__ModuleLoader__.load({
  id: 'dsh-service-monitor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'service-monitor'
    const PANEL_ID = 'service-monitor'
    const API = '/service-monitor/api'

    // ── 文案 ──────────────────────────────────────────────────────────────

    const DICT = {
      zh: {
        panelTitle: '服务余额监控',
        panelSubtitle: '查询常用 AI Agent 外部服务的剩余额度，按设定间隔自动刷新。',
        sidebarLabel: '服务余额',
        refreshNow: '立即刷新',
        refreshing: '查询中…',
        autoRefresh: '定时刷新',
        injectLabel: '注入余额到上下文',
        injectHint: '开启后，已启用服务的余额会作为系统提示词的最后一段注入（在用户消息之前）。易变的数据放在末尾，变化只影响尾部缓存，前面的提示词前缀依然命中。',
        intervalLabel: '刷新间隔',
        intervalWarn: '1 分钟间隔会频繁请求各服务接口，可能触发对方的频率限制。',
        minutes: '{n} 分钟',
        lastRefresh: '上次刷新',
        nextRefresh: '下次刷新',
        never: '尚未刷新',
        paused: '已暂停',
        enable: '启用',
        disable: '停用',
        remaining: '剩余',
        used: '已用',
        total: '总额度',
        plan: '套餐',
        resetsAt: '重置时间',
        latency: '耗时 {ms} 毫秒',
        staleNote: '最近一次查询失败,下面显示的是更早的数据:',
        unconfigured: '尚未配置 API Key',
        keySourceLabel: '密钥来源',
        sourceCredential: 'DSH 凭据库',
        sourceFile: '插件状态文件',
        sourceEnv: '环境变量',
        setKey: '填写密钥',
        changeKey: '更换密钥',
        clearKey: '移除',
        confirmClear: '确认移除?',
        save: '保存',
        cancel: '取消',
        saving: '保存中…',
        keyPlaceholder: '粘贴您的 API Key({hint})',
        getKey: '获取密钥',
        keySavedCredential: '已存入 DSH 凭据库',
        keySavedFile: '已存入插件状态文件(凭据库不可写)',
        keyCleared: '密钥已移除',
        emptyTitle: '还没有启用任何服务',
        emptyHint: '在下面的列表里启用至少一个服务,然后填入对应的 API Key。',
        availableTitle: '可启用的服务',
        allEnabled: '所有服务都已启用。',
        loadError: '无法连接插件后台:{message}',
        retry: '重试',
        unitCredits: '额度',
        unitRequests: '次',
        unitUsd: '美元',
        unitCny: '元',
        updatedAt: '更新于 {time}',
        loading: '加载中…',
        noData: '暂无数据',
        refreshingOne: '查询中',
        quotaNoteFallback: '剩余额度',
        expandDetails: '明细',
        autoReload: '自动充值',
        pendingTopUp: '充值处理中',
        billingPeriodStart: '计费周期开始',
        billingPeriodEnd: '计费周期结束',
        keyPlaceholderPlain: '粘贴您的 API Key',
        searchUsage: '搜索用量',
        extractUsage: '提取用量',
        paygoUsage: '按量付费用量',
        keyUsage: '本密钥用量',
        planSearchesLeft: '套餐剩余',
        extraCredits: '额外额度',
        rateLimitPerHour: '每小时上限',
        planMonthlyPrice: '月费',
        accountEmail: '账号',
        currency: '币种',
        giftBalance: '赠送余额',
      },
      en: {
        panelTitle: 'Service balances',
        panelSubtitle: 'Remaining quota for Tavily, Bocha, Firecrawl and SerpAPI, refreshed on your schedule.',
        sidebarLabel: 'Service balances',
        refreshNow: 'Refresh now',
        refreshing: 'Querying…',
        autoRefresh: 'Scheduled refresh',
        injectLabel: 'Inject balances into context',
        injectHint: 'When on, enabled services’ balances are injected as the last system-prompt section (just before the user message). Volatile data sits at the very end, so a change only invalidates the tail of the prompt cache.',
        intervalLabel: 'Interval',
        intervalWarn: 'A 1-minute interval queries each provider very often and may hit their rate limits.',
        minutes: '{n} min',
        lastRefresh: 'Last refresh',
        nextRefresh: 'Next refresh',
        never: 'not yet',
        paused: 'paused',
        enable: 'Enable',
        disable: 'Disable',
        remaining: 'Remaining',
        used: 'Used',
        total: 'Total',
        plan: 'Plan',
        resetsAt: 'Resets',
        latency: '{ms} ms',
        staleNote: 'The most recent query failed; showing the earlier reading:',
        unconfigured: 'No API key configured',
        keySourceLabel: 'Key source',
        sourceCredential: 'DSH credential store',
        sourceFile: 'plugin state file',
        sourceEnv: 'environment variable',
        setKey: 'Enter key',
        changeKey: 'Replace key',
        clearKey: 'Remove',
        confirmClear: 'Remove it?',
        save: 'Save',
        cancel: 'Cancel',
        saving: 'Saving…',
        keyPlaceholder: 'Paste your API key ({hint})',
        getKey: 'Get a key',
        keySavedCredential: 'Saved to the DSH credential store',
        keySavedFile: 'Saved to the plugin state file (credential store not writable)',
        keyCleared: 'API key removed',
        emptyTitle: 'No service enabled yet',
        emptyHint: 'Enable at least one service below, then paste its API key.',
        availableTitle: 'Available services',
        allEnabled: 'All four services are enabled.',
        loadError: 'Cannot reach the plugin backend: {message}',
        retry: 'Retry',
        unitCredits: 'credits',
        unitRequests: 'requests',
        unitUsd: 'USD',
        unitCny: 'CNY',
        updatedAt: 'updated {time}',
        loading: 'Loading…',
        noData: 'no data',
        refreshingOne: 'querying',
        quotaNoteFallback: 'Remaining quota',
        expandDetails: 'Details',
        autoReload: 'Auto reload',
        pendingTopUp: 'Pending top-up',
        billingPeriodStart: 'Billing period start',
        billingPeriodEnd: 'Billing period end',
        keyPlaceholderPlain: 'Paste your API key',
        searchUsage: 'Search usage',
        extractUsage: 'Extract usage',
        paygoUsage: 'Pay-as-you-go usage',
        keyUsage: 'This key',
        planSearchesLeft: 'Plan searches left',
        extraCredits: 'Extra credits',
        rateLimitPerHour: 'Rate limit / hour',
        planMonthlyPrice: 'Monthly price',
        accountEmail: 'Account',
        currency: 'Currency',
        giftBalance: 'Gift balance',
      },
    }

    const interpolate = (template, params) =>
      String(template).replace(/\{(\w+)\}/g, (_, name) => (params && name in params ? String(params[name]) : `{${name}}`))

    let activeLang = 'en'
    const detectLang = () => {
      try {
        const id = String(navigator.language || navigator.userLanguage || 'en').toLowerCase()
        return id.startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }
    let t = (key, params) => interpolate((DICT[activeLang] ?? DICT.en)[key] ?? DICT.en[key] ?? key, params)

    // ── 样式(仅用 --dsw-alias-* 主题令牌) ────────────────────────────────

    const CSS = `
.dsm-root{display:flex;flex-direction:column;min-height:0;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.dsm-root--fill{height:100%}
.dsm-scroll{min-height:0;padding:20px 24px 32px}
.dsm-root--fill .dsm-scroll{flex:1 1 auto;overflow-y:auto}
.dsm-head{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:16px}
.dsm-head-main{flex:1 1 220px;min-width:0}
.dsm-h1{margin:0;font-size:17px;font-weight:600}
.dsm-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsm-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-btn{appearance:none;font-family:inherit;font-size:12px;line-height:1.7;padding:4px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.dsm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsm-btn:disabled{opacity:.5;cursor:default}
.dsm-btn--primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
/* 主按钮 hover 必须自己兜住:上面的 .dsm-btn:hover 会把背景换成 bg-layer-2(浅色主题下近乎白),
   而 --primary 的文字是 #fff,叠在一起就成了白底白字。用品牌色 + 亮度微调做反馈。 */
.dsm-btn--primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff;filter:brightness(1.14)}
.dsm-btn--ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dsm-btn--ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsm-btn--danger{color:var(--dsw-alias-state-error-primary)}
.dsm-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsm-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.dsm-seg button{appearance:none;font-family:inherit;font-size:12px;padding:4px 10px;border:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsm-seg button:last-child{border-right:0}
.dsm-seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
/* 关闭态不能用 bg-layer-2 当轨道:它就是"嵌套表面"色,在本主题下与页面底色几乎一致,
   只剩白色圆钮可见(看起来像"只有一个圆框")。改用专门表示"非激活"的 state-idle-primary,
   并给圆钮加投影,保证浅色/深色主题下轨道与圆钮都有边界。 */
.dsm-switch{position:relative;flex:none;width:34px;height:19px;padding:0;border-radius:999px;border:1px solid transparent;background:var(--dsw-alias-state-idle-primary);cursor:pointer;transition:background .15s ease}
.dsm-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.dsm-switch > i{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.32);transition:transform .15s ease}
.dsm-switch[aria-checked="true"] > i{transform:translateX(15px)}
.dsm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(266px,1fr));gap:12px}
.dsm-card{display:flex;flex-direction:column;gap:9px;min-width:0;padding:13px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsm-card--off{opacity:.6}
.dsm-card-head{display:flex;align-items:center;gap:8px;min-width:0}
.dsm-card-name{flex:1 1 auto;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-big{font-size:25px;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.dsm-big--error{color:var(--dsw-alias-state-error-primary)}
.dsm-unit{margin-left:6px;font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.dsm-sub2{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsm-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dsm-bar > i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary)}
.dsm-bar--warn > i{background:var(--dsw-alias-state-warn-primary)}
.dsm-bar--over > i{background:var(--dsw-alias-state-error-primary)}
.dsm-meta{display:flex;flex-wrap:wrap;gap:2px 14px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dsm-meta b{font-weight:600;color:var(--dsw-alias-label-primary)}
.dsm-err{font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dsm-note{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dsm-note--ok{color:var(--dsw-alias-state-success-primary)}
.dsm-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dsm-dot--ok{background:var(--dsw-alias-state-success-primary)}
.dsm-dot--warn{background:var(--dsw-alias-state-warn-primary)}
.dsm-dot--error{background:var(--dsw-alias-state-error-primary)}
.dsm-dot--busy{background:var(--dsw-alias-state-warn-primary);animation:dsm-pulse 1s ease-in-out infinite}
@keyframes dsm-pulse{0%,100%{opacity:1}50%{opacity:.28}}
.dsm-keyrow{display:flex;gap:6px;flex-wrap:wrap}
.dsm-input{flex:1 1 150px;min-width:0;font-family:inherit;font-size:12px;padding:4px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dsm-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsm-rowbtns{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsm-link{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:11.5px}
.dsm-link:hover{text-decoration:underline}
.dsm-empty{padding:22px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dsm-empty b{display:block;margin-bottom:4px;color:var(--dsw-alias-label-primary);font-size:14px}
.dsm-banner{margin-bottom:14px;padding:9px 12px;border-radius:10px;border:1px solid var(--dsw-alias-state-error-primary);font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dsm-avail{margin-top:20px}
.dsm-avail h2{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsm-avail-list{display:flex;flex-wrap:wrap;gap:8px}
.dsm-avail-item{display:flex;align-items:center;gap:8px;padding:7px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dsm-sb{position:relative;display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;color:currentColor}
.dsm-sb-dot{position:absolute;right:0;bottom:0;width:7px;height:7px;border-radius:50%;box-shadow:0 0 0 2px var(--dsw-specific-sidebar-fill);background:var(--dsw-alias-state-idle-primary)}
.dsm-sb-dot--ok{background:var(--dsw-alias-state-success-primary)}
.dsm-sb-dot--warn{background:var(--dsw-alias-state-warn-primary)}
.dsm-sb-dot--error{background:var(--dsw-alias-state-error-primary)}
.dsm-sb-dot--busy{background:var(--dsw-alias-state-warn-primary);animation:dsm-pulse 1s ease-in-out infinite}
.dsm-spin{display:inline-block;animation:dsm-spin 1s linear infinite}
@keyframes dsm-spin{to{transform:rotate(360deg)}}
`

    // ── 模块级 store(三个注册共用,只有一个轮询器) ────────────────────────

    const store = {
      version: 0,
      data: null,
      error: null,
      loading: true,
      inflightFetch: false,
      timer: null,
      subscribers: new Set(),
      emit() {
        this.version += 1
        for (const fn of [...this.subscribers]) {
          try {
            fn()
          } catch (error) {
            console.error('[service-monitor] subscriber failed', error)
          }
        }
      },
      subscribe(fn) {
        this.subscribers.add(fn)
        this.ensurePolling()
        if (this.data === null && !this.inflightFetch) void this.fetchNow()
        return () => {
          this.subscribers.delete(fn)
          if (this.subscribers.size === 0 && this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
          }
        }
      },
      ensurePolling() {
        if (this.timer !== null || this.subscribers.size === 0) return
        const delay = this.data && Array.isArray(this.data.refreshing) && this.data.refreshing.length > 0 ? 1200 : 8000
        this.timer = setTimeout(() => {
          this.timer = null
          void this.tick()
        }, delay)
      },
      async tick() {
        let hidden = false
        try {
          hidden = Boolean(document.hidden)
        } catch {
          hidden = false
        }
        if (!hidden) await this.fetchNow()
        this.ensurePolling()
      },
      async fetchNow() {
        if (this.inflightFetch) return
        this.inflightFetch = true
        try {
          const res = await fetch(`${API}/state`, { headers: { accept: 'application/json' } })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          this.data = await res.json()
          this.error = null
        } catch (error) {
          this.error = String(error && error.message ? error.message : error)
        } finally {
          this.inflightFetch = false
          this.loading = false
          this.emit()
        }
      },
      applySnapshot(snapshot) {
        if (snapshot && typeof snapshot === 'object' && snapshot.providers) {
          this.data = snapshot
          this.error = null
          this.loading = false
          this.emit()
        }
      },
    }

    /** POST 一个动作。成功时用返回的快照刷新界面,失败时把原因抛给调用方。 */
    async function post(path, body) {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      let payload = null
      try {
        payload = await res.json()
      } catch {
        payload = null
      }
      if (!res.ok) throw new Error((payload && payload.error) || `HTTP ${res.status}`)
      return payload
    }

    const actions = {
      async setIntervalMinutes(minutes) {
        store.applySnapshot(await post('/config', { intervalMinutes: minutes }))
      },
      async setAutoRefresh(autoRefresh) {
        store.applySnapshot(await post('/config', { autoRefresh }))
      },
      async setInjectBalances(injectBalances) {
        store.applySnapshot(await post('/config', { injectBalances }))
      },
      async setServiceEnabled(id, enabled) {
        const current = store.data?.config?.services ?? []
        const next = enabled ? [...new Set([...current, id])] : current.filter((x) => x !== id)
        store.applySnapshot(await post('/config', { services: next }))
      },
      async setKey(id, key) {
        const payload = await post('/key', { service: id, key })
        store.applySnapshot(payload)
        return payload && payload.outcome ? payload.outcome : null
      },
      async refreshNow(id) {
        await post('/refresh', id ? { service: id } : {})
        // 立刻拉一次,让 refreshing 列表尽早反映在界面上。
        await store.fetchNow()
      },
    }

    // ── 展示辅助 ──────────────────────────────────────────────────────────

    function formatAmount(value, unit) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
      const n = Number(value)
      if (unit === 'usd') return `$${n.toFixed(2)}`
      if (unit === 'cny') return `¥${n.toFixed(2)}`
      return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
    }

    const UNIT_KEY = { credits: 'unitCredits', requests: 'unitRequests', usd: 'unitUsd', cny: 'unitCny' }
    const unitLabel = (unit) => t(UNIT_KEY[unit] ?? 'unitCredits')

    /** 日期字段按本地习惯显示;不是日期就原样返回,免得把一句说明吃掉。 */
    function formatDate(value) {
      if (value === null || value === undefined) return '—'
      if (typeof value !== 'string' || value.length === 0) return String(value)
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
    }

    /** 剩余比例,用于进度条与告警级别;总额未知时为 null。 */
    function remainingRatio(result) {
      if (!result || result.status !== 'ok') return null
      const total = Number(result.total)
      const remaining = Number(result.remaining)
      if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(remaining)) return null
      return Math.max(0, Math.min(1, remaining / total))
    }

    function statusOf(result, busy) {
      if (busy) return 'busy'
      if (!result) return 'idle'
      if (result.status === 'unconfigured') return 'idle'
      if (result.status !== 'ok') return 'error'
      if (result.stale) return 'warn'
      // 「余额为 0」本身就是最要紧的状态,不能因为厂家不给总额(博查、TinyFish
      // 这类只有余额没有套餐量的接口)就算不出比例、于是显示成一切正常。
      const remaining = Number(result.remaining)
      if (Number.isFinite(remaining) && remaining <= 0) return 'error'
      const ratio = remainingRatio(result)
      if (ratio !== null) {
        if (ratio <= 0.15) return 'warn'
      }
      return 'ok'
    }

    function timeText(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return t('never')
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return t('never')
      return date.toLocaleTimeString()
    }

    function sourceLabel(source) {
      if (source === 'credential') return t('sourceCredential')
      if (source === 'file') return t('sourceFile')
      if (source === 'env') return t('sourceEnv')
      return null
    }

    // ── 基础控件 ──────────────────────────────────────────────────────────

    function Dot({ status }) {
      return h('span', { className: `dsm-dot dsm-dot--${status}`, 'aria-hidden': true })
    }

    function Switch({ checked, onChange, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          title: label,
          className: 'dsm-switch',
          onClick: () => onChange(!checked),
        },
        h('i'),
      )
    }

    function RefreshIcon({ spinning }) {
      return h(
        'svg',
        {
          className: spinning ? 'dsm-spin' : undefined,
          width: 13,
          height: 13,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          'aria-hidden': true,
          style: { verticalAlign: '-2px', marginRight: 4 },
        },
        h('path', { d: 'M20 12a8 8 0 1 1-2.3-5.6' }),
        h('path', { d: 'M20 4v5h-5' }),
      )
    }

    // ── 密钥编辑 ──────────────────────────────────────────────────────────

    function KeyEditor({ provider, onSaved }) {
      const [open, setOpen] = useState(false)
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const [error, setError] = useState(null)
      const [confirmClear, setConfirmClear] = useState(false)
      const inputRef = useRef(null)

      useEffect(() => {
        if (open && inputRef.current) inputRef.current.focus()
      }, [open])

      const configured = provider.keySource !== null && provider.keySource !== undefined

      const submit = async () => {
        if (draft.trim().length === 0) {
          setError(provider.keyHint ? t('keyPlaceholder', { hint: provider.keyHint }) : t('keyPlaceholderPlain'))
          return
        }
        setBusy(true)
        setError(null)
        try {
          const outcome = await actions.setKey(provider.id, draft.trim())
          setDraft('')
          setOpen(false)
          setNote(outcome && outcome.stored === 'credential' ? t('keySavedCredential') : t('keySavedFile'))
          onSaved?.()
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        } finally {
          setBusy(false)
        }
      }

      const clear = async () => {
        setBusy(true)
        setError(null)
        try {
          await actions.setKey(provider.id, '')
          setConfirmClear(false)
          setNote(t('keyCleared'))
          onSaved?.()
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        } finally {
          setBusy(false)
        }
      }

      const rows = []
      if (!open) {
        rows.push(
          h(
            'div',
            { className: 'dsm-rowbtns', key: 'closed' },
            h(
              'button',
              { type: 'button', className: 'dsm-btn', onClick: () => { setOpen(true); setNote(null) } },
              configured ? t('changeKey') : t('setKey'),
            ),
            configured && !confirmClear
              ? h('button', { type: 'button', className: 'dsm-btn dsm-btn--ghost dsm-btn--danger', onClick: () => setConfirmClear(true) }, t('clearKey'))
              : null,
            configured && confirmClear
              ? h(
                  'span',
                  { className: 'dsm-rowbtns' },
                  h('span', { className: 'dsm-note' }, t('confirmClear')),
                  h('button', { type: 'button', className: 'dsm-btn dsm-btn--danger', disabled: busy, onClick: clear }, t('save')),
                  h('button', { type: 'button', className: 'dsm-btn dsm-btn--ghost', onClick: () => setConfirmClear(false) }, t('cancel')),
                )
              : null,
            h('a', { className: 'dsm-link', href: provider.consoleUrl, target: '_blank', rel: 'noreferrer noopener' }, t('getKey')),
          ),
        )
      } else {
        rows.push(
          h('div', { className: 'dsm-keyrow', key: 'open' }, [
            h('input', {
              key: 'input',
              ref: inputRef,
              className: 'dsm-input',
              type: 'password',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: provider.keyHint ? t('keyPlaceholder', { hint: provider.keyHint }) : t('keyPlaceholderPlain'),
              value: draft,
              disabled: busy,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void submit()
                if (event.key === 'Escape') setOpen(false)
              },
            }),
            h('button', { key: 'save', type: 'button', className: 'dsm-btn dsm-btn--primary', disabled: busy, onClick: submit }, busy ? t('saving') : t('save')),
            h('button', { key: 'cancel', type: 'button', className: 'dsm-btn', disabled: busy, onClick: () => { setOpen(false); setError(null) } }, t('cancel')),
          ]),
        )
      }
      if (configured && !open) {
        rows.push(h('div', { className: 'dsm-note', key: 'src' }, `${t('keySourceLabel')}: ${sourceLabel(provider.keySource)}`))
      }
      if (error !== null) rows.push(h('div', { className: 'dsm-err', key: 'err' }, error))
      if (note !== null) rows.push(h('div', { className: 'dsm-note dsm-note--ok', key: 'note' }, note))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, rows)
    }

    // ── 服务卡片 ──────────────────────────────────────────────────────────

    function ServiceCard({ provider, result, busy }) {
      const status = statusOf(result, busy)
      const ratio = remainingRatio(result)
      const ok = result && result.status === 'ok'
      const barClass = ratio === null ? 'dsm-bar' : ratio <= 0.15 ? 'dsm-bar dsm-bar--over' : ratio <= 0.35 ? 'dsm-bar dsm-bar--warn' : 'dsm-bar'
      const meta = []
      if (ok) {
        if (result.total !== null && result.total !== undefined) {
          meta.push(h('span', { key: 'total' }, `${t('total')} `, h('b', null, formatAmount(result.total, result.unit))))
        }
        if (result.used !== null && result.used !== undefined) {
          meta.push(h('span', { key: 'used' }, `${t('used')} `, h('b', null, formatAmount(result.used, result.unit))))
        }
        if (result.plan) meta.push(h('span', { key: 'plan' }, `${t('plan')} `, h('b', null, result.plan)))
        if (result.resetsAt) meta.push(h('span', { key: 'reset' }, `${t('resetsAt')} `, h('b', null, formatDate(result.resetsAt))))
        if (Number.isFinite(Number(result.latencyMs))) {
          meta.push(h('span', { key: 'lat' }, t('latency', { ms: result.latencyMs })))
        }
        for (const item of Array.isArray(result.extra) ? result.extra : []) {
          const shown = item.kind === 'date' ? formatDate(item.value) : String(item.value)
          meta.push(h('span', { key: `x-${item.key}-${meta.length}` }, `${item.label ?? t(item.key)} `, h('b', null, shown)))
        }
      }

      let body
      if (busy && !ok) {
        body = h('div', { className: 'dsm-sub2' }, t('refreshingOne'))
      } else if (!ok && result && result.status === 'unconfigured') {
        body = h('div', { className: 'dsm-sub2' }, t('unconfigured'))
      } else if (!ok && result) {
        body = h('div', { className: 'dsm-err' }, result.message ?? t('noData'))
      } else if (!ok) {
        body = h('div', { className: 'dsm-sub2' }, t('loading'))
      }

      return h(
        'div',
        { className: `dsm-card${result && result.status === 'unconfigured' ? ' dsm-card--off' : ''}` },
        h(
          'div',
          { className: 'dsm-card-head' },
          h(Dot, { status }),
          h('span', { className: 'dsm-card-name', title: provider.label.zh + ' / ' + provider.label.en }, activeLang === 'zh' ? provider.label.zh : provider.label.en),
          h(
            'button',
            {
              type: 'button',
              className: 'dsm-btn dsm-btn--ghost',
              title: t('refreshNow'),
              'aria-label': t('refreshNow'),
              disabled: busy,
              onClick: () => void actions.refreshNow(provider.id).catch(() => {}),
            },
            h(RefreshIcon, { spinning: busy }),
          ),
          h(Switch, {
            checked: provider.enabled,
            label: provider.enabled ? t('disable') : t('enable'),
            onChange: (next) => void actions.setServiceEnabled(provider.id, next).catch(() => {}),
          }),
        ),
        ok
          ? h(
              'div',
              null,
              h(
                'div',
                // 余额耗尽时把数字本身也染红:只有一个小圆点变红,在扫一眼的时候
                // 太容易被当成「正常」放过去。
                { className: `dsm-big${status === 'error' ? ' dsm-big--error' : ''}` },
                formatAmount(result.remaining, result.unit),
                h('span', { className: 'dsm-unit' }, unitLabel(result.unit)),
              ),
              ratio !== null
                ? h('div', { className: barClass, style: { marginTop: 6 } }, h('i', { style: { width: `${Math.round(ratio * 100)}%` } }))
                : null,
            )
          : body,
        result && result.stale === true
          ? h('div', { className: 'dsm-note' }, t('staleNote') + ' ' + (result.lastError ?? ''))
          : null,
        meta.length > 0 ? h('div', { className: 'dsm-meta' }, meta) : null,
        ok ? h('div', { className: 'dsm-note' }, t('updatedAt', { time: timeText(result.fetchedAt) })) : null,
        provider.enabled ? h(KeyEditor, { provider, onSaved: () => {} }) : null,
      )
    }

    // ── 主界面 ────────────────────────────────────────────────────────────

    function useStore() {
      const [, bump] = useState(0)
      useEffect(() => {
        const unsubscribe = store.subscribe(() => bump((v) => v + 1))
        return unsubscribe
      }, [])
      return store
    }

    function Toolbar({ data, disabled }) {
      const interval = data?.config?.intervalMinutes ?? 10
      const choices = Array.isArray(data?.intervalChoices) && data.intervalChoices.length > 0 ? data.intervalChoices : [1, 5, 10, 30]
      const auto = data?.config?.autoRefresh !== false
      return h(
        'div',
        { className: 'dsm-toolbar' },
        h('span', null, t('intervalLabel')),
        h(
          'span',
          { className: 'dsm-seg', role: 'group', 'aria-label': t('intervalLabel') },
          choices.map((minutes) =>
            h(
              'button',
              {
                key: minutes,
                type: 'button',
                'aria-pressed': minutes === interval ? 'true' : 'false',
                disabled,
                onClick: () => void actions.setIntervalMinutes(minutes).catch(() => {}),
              },
              t('minutes', { n: minutes }),
            ),
          ),
        ),
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, t('autoRefresh'), h(Switch, {
          checked: auto,
          label: t('autoRefresh'),
          onChange: (next) => void actions.setAutoRefresh(next).catch(() => {}),
        })),
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 6 }, title: t('injectHint') },
          t('injectLabel'),
          h(Switch, {
            checked: data?.config?.injectBalances === true,
            label: t('injectLabel'),
            onChange: (next) => void actions.setInjectBalances(next).catch(() => {}),
          }),
        ),
        h('span', null, `${t('lastRefresh')}: ${timeText(data?.lastRefreshAt)}`),
        h('span', null, `${t('nextRefresh')}: ${auto ? timeText(data?.nextRefreshAt) : t('paused')}`),
        interval === 1 ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, t('intervalWarn')) : null,
      )
    }

    function MonitorPage({ surface }) {
      const state = useStore()
      const data = state.data
      const refreshing = Array.isArray(data?.refreshing) ? data.refreshing : []
      const providers = Array.isArray(data?.providers) ? data.providers : []
      const enabled = providers.filter((p) => p.enabled)
      const disabled = providers.filter((p) => !p.enabled)
      const anyBusy = refreshing.length > 0

      const header = h(
        'div',
        { className: 'dsm-head' },
        h(
          'div',
          { className: 'dsm-head-main' },
          h('h1', { className: 'dsm-h1' }, t('panelTitle')),
          h('p', { className: 'dsm-sub' }, t('panelSubtitle')),
        ),
        h(
          'div',
          { className: 'dsm-head-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              disabled: state.loading || anyBusy,
              onClick: () => void actions.refreshNow().catch(() => {}),
            },
            h(RefreshIcon, { spinning: anyBusy }),
            anyBusy ? t('refreshing') : t('refreshNow'),
          ),
        ),
      )

      const content = []
      content.push(header)
      if (state.error !== null) {
        content.push(
          h(
            'div',
            { className: 'dsm-banner' },
            t('loadError', { message: state.error }),
            ' ',
            h('button', { type: 'button', className: 'dsm-btn dsm-btn--ghost', onClick: () => void store.fetchNow() }, t('retry')),
          ),
        )
      }
      if (data) content.push(h(Toolbar, { data, disabled: state.loading }))

      if (state.loading) {
        content.push(h('div', { className: 'dsm-note' }, t('loading')))
      } else if (enabled.length === 0) {
        content.push(h('div', { className: 'dsm-empty' }, h('b', null, t('emptyTitle')), t('emptyHint')))
      } else {
        content.push(
          h(
            'div',
            { className: 'dsm-grid' },
            enabled.map((provider) =>
              h(ServiceCard, {
                key: provider.id,
                provider,
                result: data?.results?.[provider.id] ?? null,
                busy: refreshing.includes(provider.id),
              }),
            ),
          ),
        )
      }

      if (disabled.length > 0) {
        content.push(
          h(
            'div',
            { className: 'dsm-avail' },
            h('h2', null, t('availableTitle')),
            h(
              'div',
              { className: 'dsm-avail-list' },
              disabled.map((provider) =>
                h(
                  'span',
                  { className: 'dsm-avail-item', key: provider.id },
                  h(Dot, { status: 'idle' }),
                  h('span', null, activeLang === 'zh' ? provider.label.zh : provider.label.en),
                  h(
                    'button',
                    { type: 'button', className: 'dsm-btn', onClick: () => void actions.setServiceEnabled(provider.id, true).catch(() => {}) },
                    t('enable'),
                  ),
                ),
              ),
            ),
          ),
        )
      } else if (providers.length > 0) {
        content.push(h('div', { className: 'dsm-avail' }, h('h2', null, t('availableTitle')), h('div', { className: 'dsm-note' }, t('allEnabled'))))
      }

      return h(
        'div',
        { className: `dsm-root${surface === 'panel' ? ' dsm-root--fill' : ''}` },
        h('style', { key: 'dsm-style' }, CSS),
        h('div', { className: 'dsm-scroll' }, content),
      )
    }

    function SidebarIcon(props) {
      useStore()
      const data = store.data
      // 这里必须是 id 数组:下面要按服务判断谁在查询中。早先误写成布尔值再调
      // .includes(),组件一抛错,外壳就把整个 sidebar.panellist 槽位清空 ——
      // 侧边栏图标整块消失,而且不会在界面上留下任何提示。
      const refreshingIds = Array.isArray(data?.refreshing) ? data.refreshing : []
      const providers = Array.isArray(data?.providers) ? data.providers : []
      const enabled = providers.filter((p) => p.enabled)
      const results = data?.results ?? {}
      // 侧边栏角标和卡片用同一套判定 —— 两处各写一份正是「卡片红了、图标还是绿的」
      // 这类不一致的来源。
      const statuses = enabled.map((p) => statusOf(results[p.id] ?? null, refreshingIds.includes(p.id)))
      let status = 'idle'
      if (statuses.length > 0) {
        if (statuses.includes('error')) status = 'error'
        else if (statuses.includes('warn')) status = 'warn'
        else if (statuses.includes('busy')) status = 'busy'
        else if (statuses.every((s) => s === 'ok')) status = 'ok'
        else status = 'warn'
      }
      const size = Number.isFinite(Number(props?.size)) ? Number(props.size) : 18
      return h(
        'span',
        { className: 'dsm-sb', title: t('sidebarLabel') },
        h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
          h('path', { d: 'M3.4 16.6a9 9 0 1 1 17.2 0' }),
          h('path', { d: 'M12 16.6 16.4 10.2' }),
          h('circle', { cx: 12, cy: 16.6, r: 1.8, fill: 'currentColor', stroke: 'none' }),
        ),
        h('span', { className: `dsm-sb-dot dsm-sb-dot--${status}`, 'aria-hidden': true }),
      )
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────

    return {
      name: NS,
      inject: ['slots'],
      // 纯展示逻辑(状态判定、比例、金额/日期格式)与那一个模块级 store 暴露给
      // test/ 用;cordis 只读 name/inject/apply,多出来的键它不看。这些规则全在
      // 闭包里,不这样开个口子就没法测 —— 而「余额为 0 却显示正常」「侧边栏图标
      // 整个消失」正是这类代码出错的两种典型后果。
      __internals: { statusOf, remainingRatio, formatAmount, formatDate, store },
      apply(ctx) {
        // 语言:优先走宿主的 locale 服务(dsh-client-locale);拿不到就退回内置字典。
        let locale = undefined
        try {
          locale = ctx.get('locale')
        } catch {
          locale = undefined
        }
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          try {
            ctx.effect(() => {
              const offZh = locale.register(NS, 'zh', DICT.zh)
              const offEn = locale.register(NS, 'en', DICT.en)
              return () => {
                if (typeof offZh === 'function') offZh()
                if (typeof offEn === 'function') offEn()
              }
            }, 'service-monitor: dictionaries')
            const bound = locale.bind(NS)
            t = (key, params) => {
              try {
                const value = bound(key, params)
                return typeof value === 'string' && value.length > 0 && value !== key
                  ? value
                  : interpolate((DICT[activeLang] ?? DICT.en)[key] ?? key, params)
              } catch {
                return interpolate((DICT[activeLang] ?? DICT.en)[key] ?? key, params)
              }
            }
          } catch (error) {
            console.warn('[service-monitor] locale service unusable, using the built-in dictionary', error)
          }
        }
        const readLang = () => {
          try {
            const snapshot = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null
            const id = String(snapshot && snapshot.active ? snapshot.active : '').toLowerCase()
            return id.length > 0 ? (id.startsWith('zh') ? 'zh' : 'en') : detectLang()
          } catch {
            return detectLang()
          }
        }
        activeLang = readLang()
        if (locale && typeof locale.subscribe === 'function') {
          ctx.effect(
            () =>
              locale.subscribe(() => {
                const next = readLang()
                if (next !== activeLang) {
                  activeLang = next
                  store.emit()
                }
              }),
            'service-monitor: locale sync',
          )
        }

        // 主面板看板,与侧边栏图标同 id,外壳点选即切换。
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(MonitorPage, { surface: 'panel' })),
        )
        // 侧边栏图标:外壳负责按钮、标签、选中态与点击,这里只交图标和标签。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 25, label: () => t('sidebarLabel') },
            (props) => h(SidebarIcon, props ?? {}),
          ),
        )
        // 设置里同一页,方便只在「设置」里找入口的用户填 Key。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: PANEL_ID, order: 45, label: () => t('panelTitle') },
            () => h(MonitorPage, { surface: 'settings' }),
          ),
        )
      },
    }
  },
})
