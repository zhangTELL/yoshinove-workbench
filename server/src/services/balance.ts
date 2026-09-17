import { createHash, createHmac, randomUUID } from 'node:crypto'

/**
 * AI 平台账户余额 / 套餐额度适配器。
 *
 * 设计要点（详见 开发计划.md 第五节）：
 * - `source` 区分 official / reverse / manual：逆向端点随时可能失效，UI 必须能区分，不能当权威。
 * - `capabilities` 做能力协商：有的平台只有余额没有套餐（如 DeepSeek），不要假设两者都有。
 * - `credentials` 声明需要几个凭据：多数平台只有 Key，火山/阿里云要 Key + Secret。
 * - 未知或无法查询时返回 `unsupported` 而不是抛错——前端据此展示「可手工录入」。
 */

export type BalanceSource = 'official' | 'reverse' | 'manual'
export type AuthStyle = 'bearer' | 'raw' | 'volc-sign' | 'aliyun-rpc'
export type Capability = 'balance' | 'quota'

export interface BalanceContext {
  apiKey: string
  apiSecret: string
  baseUrl: string
  balancePath: string
  /** 认证方式由数据决定，不写死在适配器里 */
  authStyle: AuthStyle
}

export interface BalanceResult {
  currency: string
  /** 总余额（含赠送） */
  total: number | null
  /** 赠送 / 代金券余额 */
  granted: number | null
  /** 充值 / 现金余额 */
  toppedUp: number | null
  /** 真正可用的额度 */
  available: number | null
  /** 供 UI 展示的附加指标 */
  extra?: Record<string, string | number>
}

export interface QuotaWindow {
  label: string
  type: 'TOKENS_LIMIT' | 'TIME_LIMIT' | 'COUNT' | 'CREDIT'
  limitValue: number | null
  usedValue: number | null
  remaining: number | null
  percentage: number | null
  resetAt: string | null
}

export interface AdapterResult {
  status: 'ok' | 'error' | 'unsupported'
  error?: string
  balance?: BalanceResult | null
  quotas?: QuotaWindow[]
  raw?: unknown
}

export interface BalanceAdapter {
  id: string
  label: string
  source: BalanceSource
  capabilities: Capability[]
  credentials: ('key' | 'secret')[]
  /** 默认余额端点所在基址（同时作为新建 profile 时的 base_url 建议值） */
  defaultBaseUrl: string
  /** 是否在 AI 实验区主界面默认展示 */
  isDefault: boolean
  /** 给用户看的注意事项，展示在「添加平台」弹窗里 */
  note: string
  fetch(ctx: BalanceContext): Promise<AdapterResult>
}

// ==================== 通用工具 ====================

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '')
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** 从若干候选字段里取第一个可解析为数字的值 */
function pick(node: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    if (k in node) {
      const n = num(node[k])
      if (n !== null) return n
    }
  }
  return null
}

interface HttpResult {
  status: number
  body: unknown
  text: string
}

/** 带超时的 JSON 请求；不抛错，把 HTTP 层错误交给调用方判断 */
async function request(url: string, init: RequestInit = {}, timeoutMs = 12000): Promise<HttpResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      /* 非 JSON 响应（如 HTML 登录页）保持 null，由调用方报错 */
    }
    return { status: res.status, body, text }
  } catch (e) {
    const err = e as Error
    const msg = err.name === 'AbortError' ? `请求超时（${timeoutMs / 1000}s）` : err.message
    return { status: 0, body: null, text: `请求失败：${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 把失败响应压成一句可读的错误（截断，避免把 HTML 整页塞进库） */
function describeFailure(r: HttpResult, what: string): string {
  const snippet = r.text.replace(/\s+/g, ' ').slice(0, 180)
  if (r.status === 0) return `${what} 请求失败：${snippet}`
  return `${what} 返回 HTTP ${r.status}${snippet ? `：${snippet}` : ''}`
}

/** 按 authStyle 拼认证头：bearer 要带前缀，raw 是裸 Key（智谱逆向端点），签名类自己构造 */
function authHeaders(ctx: BalanceContext): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (!ctx.apiKey) return headers
  if (ctx.authStyle === 'raw') headers.Authorization = ctx.apiKey
  else headers.Authorization = `Bearer ${ctx.apiKey}`
  return headers
}

/** 余额里是否解析出至少一个有意义的数值——防止 200 + 空壳响应被当成成功 */
function hasBalanceValue(b: BalanceResult | null | undefined): boolean {
  if (!b) return false
  return b.total !== null || b.available !== null || b.granted !== null || b.toppedUp !== null
}

/**
 * 识别「HTTP 200 但业务失败」的响应。
 * 逆向端点很常见：令牌失效时返回 200 + {code:401,msg:'...',success:false}，
 * 不识别的话会被当成「查到了但没有数据」。
 */
function softError(body: unknown): string | null {
  const d = asRecord(body)
  const msg = typeof d.msg === 'string' ? d.msg : typeof d.message === 'string' ? d.message : ''
  if (typeof d.code === 'number' && d.code !== 0 && d.code !== 200) return msg || `业务码 ${d.code}`
  if (typeof d.code === 'string' && d.code !== '0' && d.code !== '200') return msg || `业务码 ${d.code}`
  if (d.success === false) return msg || 'success=false'
  return null
}

// ==================== 火山引擎签名（HMAC-SHA256，类 SigV4） ====================

function hmac256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/** 生成火山引擎 OpenAPI 的 Authorization 头 */
function volcAuthorization(opts: {
  accessKey: string
  secretKey: string
  action: string
  version: string
  region: string
  service: string
  host: string
  xDate: string
  payloadHash: string
}): string {
  const { accessKey, secretKey, action, version, region, service, host, xDate, payloadHash } = opts
  const shortDate = xDate.slice(0, 8)

  const query: Record<string, string> = { Action: action, Version: version }
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join('&')

  const canonicalHeaders =
    `content-type:application/x-www-form-urlencoded\n` + `host:${host}\n` + `x-content-sha256:${payloadHash}\n` + `x-date:${xDate}\n`
  const signedHeaders = 'content-type;host;x-content-sha256;x-date'

  const canonicalRequest = ['GET', '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const credentialScope = `${shortDate}/${region}/${service}/request`
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')

  const kSigning = hmac256(hmac256(hmac256(hmac256(secretKey, shortDate), region), service), 'request')
  const signature = hmac256(kSigning, stringToSign).toString('hex')

  return `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

// ==================== 阿里云 RPC 签名（HMAC-SHA1） ====================

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~')
}

/** 生成阿里云 OpenAPI 的完整查询串（含 Signature） */
function aliyunSignedQuery(accessKey: string, secretKey: string, params: Record<string, string>): string {
  const common: Record<string, string> = {
    Format: 'JSON',
    AccessKeyId: accessKey,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...params,
  }
  const canonical = Object.keys(common)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(common[k])}`)
    .join('&')
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`
  const signature = createHmac('sha1', `${secretKey}&`).update(stringToSign, 'utf8').digest('base64')
  return `${canonical}&Signature=${percentEncode(signature)}`
}

// ==================== 各平台适配器 ====================

const deepseek: BalanceAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  source: 'official',
  capabilities: ['balance'],
  credentials: ['key'],
  defaultBaseUrl: 'https://api.deepseek.com',
  isDefault: true,
  note: '官方提供，这里只能看到余额',
  async fetch(ctx) {
    const url = ctx.balancePath || `${trimSlash(ctx.baseUrl)}/user/balance`
    const r = await request(url, { headers: authHeaders(ctx) })
    if (r.status !== 200) return { status: 'error', error: describeFailure(r, 'DeepSeek 余额接口') }
    const d = asRecord(r.body)
    const infos = Array.isArray(d.balance_infos) ? d.balance_infos : []
    const info = asRecord(infos[0])
    const total = pick(info, ['total_balance'])
    return {
      status: 'ok',
      raw: d,
      balance: {
        currency: typeof info.currency === 'string' ? info.currency : 'CNY',
        total,
        granted: pick(info, ['granted_balance']),
        toppedUp: pick(info, ['topped_up_balance']),
        available: d.is_available === false ? 0 : total,
        extra: { 账户状态: d.is_available === false ? '余额不足' : '可用' },
      },
      quotas: [],
    }
  },
}

const moonshot: BalanceAdapter = {
  id: 'moonshot',
  label: 'Kimi（Moonshot）',
  source: 'official',
  capabilities: ['balance'],
  credentials: ['key'],
  defaultBaseUrl: 'https://api.moonshot.cn',
  isDefault: true,
  note: '官方提供。国内站和国际站的 Key 不能混用，填错了会提示登录失败',
  async fetch(ctx) {
    const url = ctx.balancePath || `${trimSlash(ctx.baseUrl)}/v1/users/me/balance`
    const r = await request(url, { headers: authHeaders(ctx) })
    if (r.status !== 200) return { status: 'error', error: describeFailure(r, 'Kimi 余额接口') }
    const d = asRecord(r.body)
    const data = asRecord(d.data)
    const available = pick(data, ['available_balance'])
    return {
      status: 'ok',
      raw: d,
      balance: {
        currency: 'CNY',
        total: available,
        granted: pick(data, ['voucher_balance']),
        toppedUp: pick(data, ['cash_balance']),
        available,
      },
      quotas: [],
    }
  },
}

/** 智谱官方文档没有任何余额接口，以下为社区逆向端点，随时可能失效 */
const ZHIPU_BALANCE_URL = 'https://www.bigmodel.cn/api/biz/account/query-customer-account-report'
const ZHIPU_QUOTA_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'

const zhipuQuotaLabels: Record<string, string> = {
  TOKENS_LIMIT: 'Token 额度',
  TIME_LIMIT: '时间额度',
  COUNT: '次数额度',
  CREDIT: '额度',
}

const zhipu: BalanceAdapter = {
  id: 'zhipu',
  label: '智谱 GLM',
  source: 'reverse',
  capabilities: ['balance', 'quota'],
  credentials: ['key'],
  defaultBaseUrl: 'https://open.bigmodel.cn',
  isDefault: true,
  note: '⚠ 官方没有公开余额查询，这里用的是社区常见做法，可能随时失效；Key 直接粘贴，不要加 Bearer 前缀',
  async fetch(ctx) {
    // 两个端点在不同 host，balancePath 只能覆盖余额那一个
    const balanceUrl = ctx.balancePath || ZHIPU_BALANCE_URL
    const headers = authHeaders(ctx)
    const [balRes, quotaRes] = await Promise.all([
      request(balanceUrl, { headers }),
      request(ZHIPU_QUOTA_URL, { headers }),
    ])

    let balance: BalanceResult | null = null
    const errors: string[] = []

    if (balRes.status === 200) {
      const d = asRecord(balRes.body)
      // 逆向接口的包裹层不固定，两种形态都兜住
      const node = Object.keys(asRecord(d.data)).length ? asRecord(d.data) : d
      const total = pick(node, ['balance', 'availableBalance', 'totalBalance'])
      const frozen = pick(node, ['frozenBalance'])
      const spend = pick(node, ['totalSpendAmount'])
      const candidate: BalanceResult = {
        currency: 'CNY',
        total,
        granted: pick(node, ['giveAmount']),
        toppedUp: pick(node, ['rechargeAmount']),
        available: pick(node, ['availableBalance']) ?? total,
        extra: {
          ...(frozen !== null ? { 冻结: frozen } : {}),
          ...(spend !== null ? { 累计消费: spend } : {}),
        },
      }
      // 逆向端点失效时常返回 200 + 登录页/错误体，这里必须确认真的解析出了数字
      if (hasBalanceValue(candidate)) balance = candidate
      else errors.push(`智谱余额（逆向）返回 200 但未解析出余额字段，接口可能已变更：${balRes.text.replace(/\s+/g, ' ').slice(0, 140)}`)
    } else {
      errors.push(describeFailure(balRes, '智谱余额（逆向）'))
    }

    const quotas: QuotaWindow[] = []
    if (quotaRes.status === 200) {
      const d = asRecord(quotaRes.body)
      const data = asRecord(d.data)
      const limits = Array.isArray(data.limits) ? data.limits : []
      const seen: Record<string, number> = {}
      for (const raw of limits) {
        const it = asRecord(raw)
        const type = typeof it.type === 'string' ? it.type : 'CREDIT'
        seen[type] = (seen[type] ?? 0) + 1
        const base = zhipuQuotaLabels[type] ?? type
        quotas.push({
          label: seen[type] > 1 ? `${base} #${seen[type]}` : base,
          type: (type in zhipuQuotaLabels ? type : 'CREDIT') as QuotaWindow['type'],
          limitValue: pick(it, ['usage', 'limit']),
          usedValue: pick(it, ['currentValue', 'used']),
          remaining: pick(it, ['remaining']),
          percentage: pick(it, ['percentage', 'percent']),
          resetAt: typeof it.nextResetTime === 'string' ? it.nextResetTime : null,
        })
      }
      // 200 + 业务失败（令牌失效最常见）时提示，别让用户以为「套餐就是没数据」
      if (!limits.length) {
        const soft = softError(quotaRes.body)
        if (soft) errors.push(`智谱套餐额度（逆向）业务失败：${soft}`)
      }
      if (typeof data.level === 'string') {
        balance = balance ?? { currency: 'CNY', total: null, granted: null, toppedUp: null, available: null }
        balance.extra = { ...(balance.extra ?? {}), 套餐等级: data.level }
      }
    } else {
      errors.push(describeFailure(quotaRes, '智谱套餐额度（逆向）'))
    }

    if (!balance && !quotas.length) {
      return { status: 'error', error: errors.join('；') || '智谱逆向接口均未返回可用数据' }
    }
    return { status: 'ok', balance, quotas, raw: { balance: balRes.body, quota: quotaRes.body }, error: errors.join('；') || undefined }
  },
}

const openrouter: BalanceAdapter = {
  id: 'openrouter',
  label: 'OpenRouter',
  source: 'official',
  capabilities: ['balance'],
  credentials: ['key'],
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  isDefault: false,
  note: '需要用管理密钥（management key）；普通 API Key 会提示没有权限',
  async fetch(ctx) {
    const url = ctx.balancePath || `${trimSlash(ctx.baseUrl)}/credits`
    const r = await request(url, { headers: authHeaders(ctx) })
    if (r.status !== 200) return { status: 'error', error: describeFailure(r, 'OpenRouter credits 接口') }
    const d = asRecord(r.body)
    const data = asRecord(d.data)
    const total = pick(data, ['total_credits'])
    const used = pick(data, ['total_usage'])
    const extra: Record<string, string | number> = {}
    if (used !== null) extra['累计已用'] = used
    return {
      status: 'ok',
      raw: d,
      balance: {
        currency: 'USD',
        total,
        granted: null,
        toppedUp: total,
        available: total !== null && used !== null ? Number((total - used).toFixed(4)) : total,
        extra,
      },
      quotas: [],
    }
  },
}

const siliconflow: BalanceAdapter = {
  id: 'siliconflow',
  label: '硅基流动',
  source: 'reverse',
  capabilities: ['balance'],
  credentials: ['key'],
  defaultBaseUrl: 'https://api.siliconflow.cn/v1',
  isDefault: false,
  note: '⚠ 官方文档里没有这个查询方式，属于社区用法，可能随时失效',
  async fetch(ctx) {
    const url = ctx.balancePath || `${trimSlash(ctx.baseUrl)}/user/info`
    const r = await request(url, { headers: authHeaders(ctx) })
    if (r.status !== 200) return { status: 'error', error: describeFailure(r, '硅基流动 user/info 接口') }
    const d = asRecord(r.body)
    const data = asRecord(d.data)
    const total = pick(data, ['totalBalance'])
    return {
      status: 'ok',
      raw: d,
      balance: {
        currency: 'CNY',
        total,
        granted: pick(data, ['balance']),
        toppedUp: pick(data, ['chargeBalance']),
        available: total,
      },
      quotas: [],
    }
  },
}

const volcengine: BalanceAdapter = {
  id: 'volcengine',
  label: '火山引擎方舟',
  source: 'official',
  capabilities: ['balance'],
  credentials: ['key', 'secret'],
  defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  isDefault: false,
  note: '需要 AccessKey 和 SecretKey。只能查账户余额；免费额度和套餐额度请到官网控制台查看',
  async fetch(ctx) {
    if (!ctx.apiKey || !ctx.apiSecret) return { status: 'unsupported', error: '缺少 AccessKey / SecretKey' }
    const host = 'open.volcengineapi.com'
    const region = 'cn-north-1'
    const service = 'billing'
    const version = '2022-01-01'
    const action = 'QueryBalanceAcct'
    const xDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
    const payloadHash = sha256Hex('')
    const authorization = volcAuthorization({
      accessKey: ctx.apiKey,
      secretKey: ctx.apiSecret,
      action,
      version,
      region,
      service,
      host,
      xDate,
      payloadHash,
    })
    const url = `https://${host}/?Action=${action}&Version=${version}`
    const r = await request(url, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Host: host,
        'X-Date': xDate,
        'X-Content-Sha256': payloadHash,
        Authorization: authorization,
      },
    })
    if (r.status !== 200) return { status: 'error', error: describeFailure(r, '火山引擎 QueryBalanceAcct') }
    const d = asRecord(r.body)
    const result = asRecord(d.Result)
    const available = pick(result, ['AvailableBalance'])
    return {
      status: 'ok',
      raw: d,
      balance: {
        currency: typeof result.Currency === 'string' ? result.Currency : 'CNY',
        total: available,
        granted: null,
        toppedUp: pick(result, ['CashBalance']),
        available,
        extra: {
          ...(pick(result, ['ArrearsBalance']) ? { 欠费: pick(result, ['ArrearsBalance']) as number } : {}),
          ...(pick(result, ['FreezeAmount']) ? { 冻结: pick(result, ['FreezeAmount']) as number } : {}),
        },
      },
      quotas: [],
    }
  },
}

const aliyun: BalanceAdapter = {
  id: 'aliyun',
  label: '阿里云百炼',
  source: 'official',
  capabilities: ['balance'],
  credentials: ['key', 'secret'],
  defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  isDefault: false,
  note: '需要阿里云 AccessKey 和 SecretKey，并给账号开通账单查询权限（bss:DescribeAcccount 或 AliyunBSSReadOnlyAccess）。免费额度的剩余 Token 请到控制台查看',
  async fetch(ctx) {
    if (!ctx.apiKey || !ctx.apiSecret) return { status: 'unsupported', error: '缺少 AccessKey / SecretKey' }
    const query = aliyunSignedQuery(ctx.apiKey, ctx.apiSecret, {
      Action: 'QueryAccountBalance',
      Version: '2017-12-14',
      RegionId: 'cn-hangzhou',
    })
    const r = await request(`https://business.aliyuncs.com/?${query}`, { headers: { Accept: 'application/json' } })
    if (r.status !== 200) return { status: 'error', error: describeFailure(r, '阿里云 QueryAccountBalance') }
    const d = asRecord(r.body)
    if (d.Code && String(d.Code) !== '200') {
      return { status: 'error', error: `阿里云返回 ${d.Code}：${String(d.Message ?? d.Code)}（常见原因：AccessKey 错误或 RAM 未授权 bss 只读权限）` }
    }
    const data = asRecord(d.Data)
    const available = pick(data, ['AvailableAmount'])
    return {
      status: 'ok',
      raw: d,
      balance: {
        currency: typeof data.Currency === 'string' ? data.Currency : 'CNY',
        total: pick(data, ['AvailableAmount']),
        granted: pick(data, ['CreditAmount']),
        toppedUp: pick(data, ['AvailableCashAmount']),
        available,
      },
      quotas: [],
    }
  },
}

/** MiniMax 官方不提供余额查询接口，只能手工录入 */
const minimax: BalanceAdapter = {
  id: 'minimax',
  label: 'MiniMax',
  source: 'manual',
  capabilities: ['balance'],
  credentials: ['key'],
  defaultBaseUrl: 'https://api.minimaxi.com/v1',
  isDefault: false,
  note: '官方只能到官网控制台查看，无法自动获取——添加后请手动填写余额',
  async fetch() {
    return { status: 'unsupported', error: '该平台无公开余额接口，请使用「手工录入」' }
  },
}

/** 兜底：自定义 OpenAI 兼容平台，无统一余额接口，走手工录入 */
const custom: BalanceAdapter = {
  id: 'custom',
  label: '自定义平台',
  source: 'manual',
  capabilities: ['balance'],
  credentials: ['key'],
  defaultBaseUrl: '',
  isDefault: false,
  note: '自定义平台无法自动获取余额，请手动填写',
  async fetch() {
    return { status: 'unsupported', error: '自定义平台无统一余额接口，请使用「手工录入」' }
  },
}

// ==================== 注册表 ====================

const ADAPTERS: BalanceAdapter[] = [deepseek, moonshot, zhipu, openrouter, siliconflow, volcengine, aliyun, minimax, custom]

const REGISTRY = new Map<string, BalanceAdapter>(ADAPTERS.map((a) => [a.id, a]))

export function getAdapter(provider: string): BalanceAdapter | undefined {
  return REGISTRY.get(provider)
}

export function listAdapters(): BalanceAdapter[] {
  return ADAPTERS
}

/** 供 /api/ai/providers 输出的平台目录（函数字段不外泄） */
export interface ProviderMeta {
  id: string
  label: string
  source: BalanceSource
  capabilities: Capability[]
  credentials: ('key' | 'secret')[]
  defaultBaseUrl: string
  isDefault: boolean
  note: string
}

export function listProviderMeta(): ProviderMeta[] {
  return ADAPTERS.map(({ id, label, source, capabilities, credentials, defaultBaseUrl, isDefault, note }) => ({
    id,
    label,
    source,
    capabilities,
    credentials,
    defaultBaseUrl,
    isDefault,
    note,
  }))
}

/** 执行一次余额抓取；适配器缺失或未实现时统一返回 unsupported，不抛错 */
export async function runAdapter(profile: {
  provider: string
  apiKey: string
  apiSecret: string
  baseUrl: string
  balancePath: string
  authStyle: string
}): Promise<AdapterResult> {
  const adapter = getAdapter(profile.provider)
  if (!adapter) {
    return { status: 'unsupported', error: `未知平台「${profile.provider}」，可在该配置里手工录入余额` }
  }
  let result: AdapterResult
  try {
    result = await adapter.fetch({
      apiKey: profile.apiKey,
      apiSecret: profile.apiSecret,
      baseUrl: profile.baseUrl,
      balancePath: profile.balancePath,
      authStyle: (profile.authStyle || 'bearer') as AuthStyle,
    })
  } catch (e) {
    return { status: 'error', error: `适配器异常：${(e as Error).message}` }
  }

  // 兜底防线：接口返回成功但一个数字都没解析出来，说明字段变了或返回了错误体，
  // 这种情况绝不能记成 ok，否则界面上会出现一张「全空但绿色」的卡片
  if (result.status === 'ok' && !hasBalanceValue(result.balance) && !(result.quotas?.length ?? 0)) {
    return {
      status: 'error',
      error: result.error || '接口返回成功但未解析出余额或额度字段，接口可能已变更',
      raw: result.raw,
    }
  }
  return result
}
