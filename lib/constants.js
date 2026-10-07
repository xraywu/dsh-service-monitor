/**
 * 插件身份、挂载点与各模块共用的运行参数。
 *
 * 这些值过去散落在 index.js 的常量区与各处使用点之间,集中在这里之后,
 * 一个数值只有一个定义,改挂载点或超时不用再全文搜索。
 */

export const PLUGIN_ID = 'service-monitor'
export const MOUNT_PATH = '/service-monitor'
export const API_BASE = MOUNT_PATH + '/api'
export const STATE_VERSION = 1
export const INTERVAL_CHOICES = [1, 5, 10, 30]
export const DEFAULT_INTERVAL_MINUTES = 10
export const REQUEST_TIMEOUT_MS = 15000
export const BODY_LIMIT_BYTES = 64 * 1024
export const STARTUP_REFRESH_DELAY_MS = 2500

/**
 * 注入用的系统提示词段落 order。
 *
 * 宿主把段落按 order 升序拼装,内置表 `SECTION_ORDERS` 里最大的一项是
 * `DEPLOYMENT_PERSONA_SUFFIX: 10200`,所以取一个更大的值就等于「所有系统
 * 段落之后、用户消息之前」—— 这正是要的位置:余额是会变的数据,放在系统
 * 提示词末尾,变化只影响尾部,前面那段稳定的前缀仍然命中提示词缓存。
 * 若将来宿主把这个数提到 10300 以上,这个值需要跟着调大。
 */
export const PROMPT_SECTION_ORDER = 10300

/** 会话上下文中该段落的稳定名字。 */
export const PROMPT_SECTION_NAME = 'service-monitor:balances'
