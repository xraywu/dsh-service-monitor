# dsh-service-monitor

DeepSeek Harness 插件：监控 AI Agent 常用第三方服务的**剩余余额 / 额度**。

- 服务：**Tavily**、**博查 Bocha**、**Firecrawl**、**SerpAPI**、**TinyFish**
- 自选服务、逐个录入 API Key
- 定时刷新：**1 / 5 / 10 / 30 分钟**，也可随时手动刷新
- 展示面：**主面板看板**（侧边栏图标点选）+ **侧边栏状态图标**（带健康状态圆点）+ **设置 → 服务余额监控**（同一页，便于填 Key）
- 可选：把余额**注入对话上下文**，默认关闭
- 界面中英双语，深浅色跟随宿主主题令牌 `--dsw-alias-*`

**暂时只支持提供了余额查询 API 的服务：** 还有一些常用服务如 `Brave` 等未提供余额查询 API，因此暂不支持监控。


## 安装

直接在 DSH 插件界面安装 `dsh-service-monitor` 或命令行安装：

```
dsh plugin add dsh-service-monitor
```

装好后：侧边栏出现「服务余额」图标，设置里出现「服务余额监控」页。首次进入所有服务都是「尚未配置 API Key」。

> 已经装过旧版的用户：状态文件里记着当时的服务列表，新加的服务不会自动加入刷新队列，而是出现在看板底部「可启用的服务」里，点一下「启用」即可 —— 这样不会凭空多出一堆「未配置」卡片，也不会对没配 Key 的服务发起请求。


## 使用

1. 打开看板（侧边栏图标，或「设置 → 服务余额监控」）。
2. 在卡片上点「填写密钥」，粘贴对应服务的 API Key，回车或点保存。
3. 用卡片右上角的开关启用 / 停用服务，用看板顶部的分段控件选择刷新间隔。
4. 点「立即刷新」可随时查询；卡片会显示剩余额度、总量、进度条、套餐、耗时。

额度低于 15% 转黄、为 0 转红，并在侧边栏图标的角标上体现。


## 注入余额到对话上下文（默认关闭）

看板顶部有一个「**注入余额到上下文**」开关。打开后，所有**已启用**服务的余额会作为一段系统提示词注入，每一轮模型请求都能看到，例如：

```
## 第三方服务余额
(refreshed every 10 min · as of 10:34:41)
- Tavily: 14500 / 15000 credits remaining
- Bocha: ¥0.00 remaining (depleted)
- SerpAPI: query failed — API key is invalid or expired (HTTP 401)

调用外部检索/抓取服务前，先参考上面的余额：
1. …（见下方「补充说明」）
```

### 补充说明（可编辑）

开关打开后，看板顶部会出现一个文本框，用来告诉 Agent 在多个服务之间怎么取舍。**默认文案以占位文字（灰色）显示**：留空即用默认，填写自己的文案后点「保存」，点「恢复默认」或清空后保存即回到默认。上限 2000 字符。

内置默认文案（也是占位文字的内容）：

> 调用外部检索/抓取服务前，先参考上面的余额：
> 1. 同一个目的有多个服务可用时，优先选剩余额度更充裕的那个，让各服务的额度均衡消耗，避免任何一项被提前用尽。
> 2. 某项服务有「重置时间」且即将重置、当前仍有剩余时，可以优先消耗它的额度（重置前的剩余不用就浪费了）。
> 3. 余额为 0 或已耗尽的服务不要调用，改用其它可用服务。

指导文案与余额块在同一段里：余额在上面（每次刷新都可能变），指导在下面（不变），所以提示词缓存只在余额真的变化时失效。

### 注意事项 ###

- **默认关闭：** 功能默认关闭，请确保你需要使用这些服务并需要动态监控服务余额时才打开。
- **保持缓存：** 相关提示词注入在所有系统提示词之后、用户消息之前，以避免动态查询的结果影响**提示词缓存**。
- **只注入已启用的服务**：只会对开启了监控的服务进行注入
- **余额 ≤ 0 标注「已耗尽」**：以确保 Agent 不会调用 Credit 已经耗尽的服务。


## API Key 存放是否安全？

插件按以下顺序获取密钥，服务卡片上的「密钥来源」会告诉您实际用的是哪一个：

1. **DSH 凭据库**（默认）。在界面上添加的密钥，以各服务自己的环境变量名存入 DSH 托管存储，例如 `TAVILY_API_KEY`：
   - 在界面上保存 → `ctx.credentials.set('TAVILY_API_KEY', …)`，写进 DSH 托管存储；
   - 若该名字已被下方其他来源覆盖（如进程环境变量），则使用下方来源。
2. **插件状态文件** `$DSH_HOME/storages/service-monitor/state.json`（凭据库不可写时的回落，文件权限 0600）。
3. **进程环境变量**：`TAVILY_API_KEY` / `BOCHA_API_KEY`(或 `BOCHA_KEY`) / `FIRECRAWL_API_KEY` / `SERPAPI_API_KEY`(或 `SERP_API_KEY`) / `TINYFISH_API_KEY`。

API Key **永远不会**通过 HTTP 接口回传给页面：`/state` 只返回「有没有配」「来源是哪一类」。


## 各服务余额接口

| 服务 | 端点 | 认证 | 字段说明 |
|---|---|---|---|
| Tavily | `GET https://api.tavily.com/usage` | `Authorization: Bearer` | `account.plan_limit - account.plan_usage` |
| 博查 | `GET https://api.bocha.cn/v1/fund/remaining` | `Authorization: Bearer` | `data.remaining` |
| Firecrawl | `GET https://api.firecrawl.dev/v2/team/credit-usage`（v1 回落到 `/v1/…`） | `Authorization: Bearer` | `remainingCredits` / `planCredits` |
| SerpAPI | `GET https://serpapi.com/account.json?api_key=…` | query 参数 | `total_searches_left`、`plan_searches_left`、`searches_per_month` |
| TinyFish | `GET https://agent.tinyfish.ai/v1/wallet` | `X-API-Key` | `available_balance`、`currency` |

> **关于 Firecrawl 的「重置时间」**：Firecrawl 的账单接口**没有任何额度重置字段**。v2 OpenAPI 里 `/team/credit-usage` 只有 `remainingCredits` / `planCredits` / `billingPeriodStart` / `billingPeriodEnd`，`/team/token-usage` 同样只有计费周期起止，`/team/credit-usage/historical` 只有 `startDate` / `endDate` / `totalCredits`。年付套餐的 `billingPeriodEnd` 是套餐到期日，与「每月额度重置」不是一回事 —— 所以卡片显示的是**计费周期起止**，而不是一个被标错成「重置时间」的日期。
>
> **关于「余额为 0」**：状态判定不依赖「剩余/总额」比例。像博查、TinyFish 这种只有余额没有套餐总量的接口算不出比例，但余额 `<= 0` 一律判为耗尽（红），侧边栏角标与卡片用同一套判定。


## 配置

插件的 `cordis.patch.yml` 只提供**首次启动的默认值**；之后用户在面板里的改动写在上面那个状态文件里，不会回写 profile，因此升级插件不会丢配置。

```yaml
- insert:
    - id: service-monitor
      name: dsh-service-monitor
      config:
        intervalMinutes: 10          # 1 | 5 | 10 | 30,其它值回落 10
        services: [tavily, bocha, firecrawl, serpapi, tinyfish]
        autoRefresh: true
        trustedHosts: []             # 额外允许的 Host 头(反代场景)
```


## HTTP 接口

同源前缀 `/service-monitor/api`（仅回环地址与 `trustedHosts` 可访问，带 `Origin` 时要求与 `Host` 同源）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/state` | 完整快照：配置、服务清单、缓存结果、刷新进度 |
| GET | `/health` | `{ ok: true }` |
| POST | `/config` | `{ intervalMinutes?, services?, autoRefresh? }` |
| POST | `/key` | `{ service, key }`，`key: ""` 表示移除 |
| POST | `/refresh` | `{ service? }`，不传则刷新全部启用的服务 |


## 开发

测试套件**随仓库提供，不打包进 npm 包**（`files` 里不含 `test/`，安装体积因此小约四分之一）；要跑就在克隆下来的仓库里执行：

```bash
node test/smoke-host.mjs              # 离线：路由、配置、密钥、信任校验、响应解析
node test/smoke-host.mjs --network    # 额外用无效 Key 实测每个厂商端点
```
