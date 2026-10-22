# dsh-service-monitor

[English](README_EN.md) | [简体中文](README.md)

DeepSeek Harness plugin: Monitor remaining balances and quota for AI agent third-party services.

- Supported services: **Tavily**, **Bocha**, **Firecrawl**, **SerpAPI**, **SearchApi**, **ScrapingBee**, **ScraperAPI**, **TinyFish**
- Select services individually and configure API keys per service
- Scheduled refresh: **1 / 5 / 10 / 30 minutes**, with on-demand manual refresh anytime
- Presentation: **Dashboard panel** (via sidebar icon) + **Sidebar status icon** (with health dot indicator) + **Settings → Service balances** (same page for easy key configuration)
- Optional: **Inject balances into conversation context** (disabled by default)
- Bilingual interface (English & Chinese), dark/light theme adapts to host design tokens (`--dsw-alias-*`)

**Currently only services providing a balance query API are supported:** Popular services such as `Brave` that do not offer a balance check API cannot be monitored at this time.


## Installation

Install `dsh-service-monitor` directly from the DSH Plugin manager or via the command line:

```bash
dsh plugin add dsh-service-monitor
```

Requires DSH **0.2.1-rc.2** or a later 0.2.x release (`engines.dsh` = `>=0.2.1-rc.2 <0.3.0-0`; this release is verified against 0.2.1-rc.2 — the older 0.1.5 line is not covered).

Once installed, a "Service balances" icon appears on the sidebar, and a "Service balances" page appears under Settings. On first run, all services show as "No API key configured yet".

> For users upgrading from older versions: the state file retains your previously enabled service list. Newly introduced services will not be added to the refresh queue automatically; instead, they appear under "Available services" at the bottom of the dashboard. Click "Enable" to activate them — this prevents cluttering your dashboard with unconfigured cards or sending requests for services without keys.


## Usage

1. Open the dashboard (click the sidebar icon, or navigate to **Settings → Service balances**).
2. Click **Enter Key** on a service card, paste the corresponding API key, and hit Enter or click Save.
3. Use the toggle switch in the top-right corner of each card to enable/disable that service, and use the segmented control at the top of the dashboard to choose the refresh interval.
4. Click **Refresh now** anytime to fetch the latest usage; cards display remaining quota, total limit, progress bar, subscription plan, and latency.

Quota status turns yellow when below 15% and red when reaching 0, which is also reflected on the sidebar icon badge.


## Inject Balances into Conversation Context (Disabled by Default)

The dashboard includes an **Inject balances into context** toggle. When enabled, the balance information of all **enabled** services is injected as a system prompt section, visible to the model on every turn:

```markdown
## Third-party service balances
(refreshed every 10 min · as of 10:34:41)
- Tavily: 14500 / 15000 credits remaining
- Bocha: ¥0.00 remaining (depleted)
- SerpAPI: 557 / 1000 requests remaining (resets on 2026-11-01)

Before calling an external search or scraping service, check the balances above:
1. … (see "Additional Guidance" below)
```

### Additional Guidance (Editable)

When the toggle is enabled, an editable textarea appears at the top of the dashboard to instruct the agent on how to prioritize and switch between multiple services. **The default instructions appear as placeholder text (gray)**: leave it blank to use the default, or type custom instructions and click **Save**. Click **Reset to default** or save an empty string to restore the default text. Maximum length is 2000 characters.

Built-in default guidance (also the placeholder content):

> Before calling an external search or scraping service, check the balances above:
> 1. When several services can serve the same purpose, prefer the one with more headroom, so that every quota is consumed evenly and none of them runs out early.
> 2. If a service has a "resets on" time that is close and still has credit left, prefer it — the leftover credit is wasted at the reset.
> 3. Do not call a service whose balance is 0 or depleted; use another available service instead.

The guidance is appended directly below the balance items in the same prompt section: balances sit at the top (dynamic upon refresh) while guidance sits at the bottom (static), ensuring that prompt cache invalidation only occurs when balances actually change.

### Important Notes

- **Disabled by default:** Keep this feature disabled unless you actively use these services and want your agent to make quota-aware routing decisions.
- **Cache-friendly:** The prompt section is injected after all core system prompts and before user messages, preventing dynamic query results from invalidating preceding prompt caches.
- **Enabled services only:** Only services that are currently enabled are included in the injected text.
- **Balances ≤ 0 labeled "depleted":** Ensures the agent avoids calling depleted services.
- **Reset time injected synchronously (if available):** If a service provides a reset date (such as SerpAPI), it is appended at the end of the line (e.g., `(resets on 2026-11-01)` / `(重置时间: 2026-11-01)`), enabling the agent to prioritize quota near reset as recommended in rule #2.
- **Injection language follows the settings choice:** The injected block and host-side texts (such as error messages) use the interface language **explicitly selected** under Settings → General (persisted as `locale.preference`). When no choice was ever made, the browser still picks a language from the system automatically, but the host cannot see that automatic pick — the injected block then falls back to English.


## How Secure Are Stored API Keys?

The plugin resolves API keys in the following priority order. The "Key source" tag on each card indicates which source is actively used:

1. **DSH Credential Store** (default). Keys entered in the UI are stored in DSH-managed secure credential storage under each service's standard environment variable name (e.g., `TAVILY_API_KEY`):
   - Saving in UI calls `ctx.credentials.set('TAVILY_API_KEY', …)` to persist into DSH managed storage.
   - If overridden by a higher-priority source below (e.g., process environment variables), that source takes precedence.
2. **Plugin State File** `$DSH_HOME/storages/service-monitor/state.json` (fallback when credential store is unavailable; file mode 0600).
3. **Process Environment Variables**: `TAVILY_API_KEY` / `BOCHA_API_KEY` (or `BOCHA_KEY`) / `FIRECRAWL_API_KEY` / `SERPAPI_API_KEY` (or `SERP_API_KEY`) / `TINYFISH_API_KEY`.

API keys are **never** returned via HTTP endpoints: `/state` only reports whether a key is configured and what type of source it originates from.


## Service Balance Endpoints

| Service | Endpoint | Authentication | Field Mapping |
|---|---|---|---|
| Tavily | `GET https://api.tavily.com/usage` | `Authorization: Bearer` | `account.plan_limit - account.plan_usage` |
| Bocha | `GET https://api.bocha.cn/v1/fund/remaining` | `Authorization: Bearer` | `data.remaining` |
| Firecrawl | `GET https://api.firecrawl.dev/v2/team/credit-usage` (v1 falls back to `/v1/…`) | `Authorization: Bearer` | `remainingCredits` / `planCredits` |
| SerpAPI | `GET https://serpapi.com/account.json?api_key=…` | Query parameter | `total_searches_left`, `plan_searches_left`, `searches_per_month` |
| SearchApi | `GET https://www.searchapi.io/api/v1/me` | `Authorization: Bearer` | `account.remaining_credits`, `account.monthly_allowance` |
| ScrapingBee | `GET https://app.scrapingbee.com/api/v1/usage` | `Authorization: Bearer` | `max_api_credit`, `used_api_credit`, `renewal_subscription_date` |
| ScraperAPI | `GET https://api.scraperapi.com/account?api_key=…` | Query parameter | `requestLimit - requestCount`, `concurrencyLimit` |
| TinyFish | `GET https://agent.tinyfish.ai/v1/wallet` | `X-API-Key` | `available_balance`, `currency` |

> **Regarding Firecrawl's "Reset Date"**: Firecrawl's billing API **does not provide any quota reset timestamp**. In the v2 OpenAPI, `/team/credit-usage` only returns `remainingCredits` / `planCredits` / `billingPeriodStart` / `billingPeriodEnd`, `/team/token-usage` only returns billing period bounds, and `/team/credit-usage/historical` only returns `startDate` / `endDate` / `totalCredits`. For annual plans, `billingPeriodEnd` represents the annual plan expiration date, not the monthly credit reset date — therefore, the card accurately displays **Billing Period Start / End** rather than mislabeling it as a "reset date".
>
> **Regarding "Zero Balance"**: Status evaluation does not rely strictly on a "remaining / total" ratio. Services like Bocha and TinyFish only provide remaining balance without a plan ceiling, but any balance `<= 0` is unconditionally classified as depleted (red). The sidebar badge and card state use the exact same logic.


## Configuration

The plugin's `cordis.patch.yml` provides **initial defaults on first startup**. Subsequent user modifications made in the UI are written to the plugin state file mentioned above without overwriting the user profile, preserving configuration across plugin updates.

```yaml
- insert:
    - id: service-monitor
      name: dsh-service-monitor
      config:
        intervalMinutes: 10          # 1 | 5 | 10 | 30; other values fall back to 10
        services: [tavily, bocha, firecrawl, serpapi, searchapi, scrapingbee, scraperapi, tinyfish]
        autoRefresh: true
        trustedHosts: []             # Extra allowed Host headers (for reverse proxy setups)
```


## HTTP Endpoints

Mounted under `/service-monitor/api` (accessible only from loopback addresses and `trustedHosts`; requires matching `Origin` and `Host` when `Origin` is present):

| Method | Path | Description |
|---|---|---|
| GET | `/state` | Full state snapshot: config, service list, cached results, refresh progress |
| GET | `/health` | `{ ok: true }` |
| POST | `/config` | `{ intervalMinutes?, services?, autoRefresh? }` |
| POST | `/key` | `{ service, key }` (`key: ""` removes the key) |
| POST | `/refresh` | `{ service? }` (refreshes all enabled services if omitted) |


## Development

The test suite is **shipped with the git repository but excluded from the npm package** (saving roughly 25% install size). To run tests in a cloned repository:

```bash
node test/smoke-host.mjs              # Offline: routing, config, keys, trust validation, response parsing
node test/smoke-host.mjs --network    # Optional: live endpoint checks against vendors using invalid keys
```
