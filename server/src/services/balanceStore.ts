import { sqlite } from '../db/index.js'
import { getAdapter, listProviderMeta, runAdapter } from './balance.js'

/**
 * 余额监控的数据访问层。
 * routes/ai.ts 与 scheduler 都从这里取，避免调度器反向依赖路由模块。
 */

export interface ProfileRow {
  id: number
  name: string
  base_url: string
  api_key: string
  model: string
  enabled: number
  provider: string
  auth_style: string
  api_secret: string
  balance_path: string
  balance_enabled: number
}

export interface RunOutcome {
  profileId: number
  profileName: string
  status: 'ok' | 'error' | 'unsupported'
  error?: string
}

export function nowLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function mask(secret: string): string {
  if (!secret) return ''
  if (secret.length <= 10) return '••••••'
  return `${secret.slice(0, 6)}••••${secret.slice(-4)}`
}

export function selectProfiles(): ProfileRow[] {
  return sqlite.prepare('SELECT * FROM model_profiles ORDER BY id').all() as ProfileRow[]
}

/** 出参统一走这里：绝不把 api_key / api_secret 原文发给前端 */
export function toProfileDTO(r: ProfileRow) {
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    baseUrl: r.base_url,
    model: r.model,
    enabled: !!r.enabled,
    authStyle: r.auth_style,
    balancePath: r.balance_path,
    balanceEnabled: !!r.balance_enabled,
    hasApiKey: !!r.api_key,
    apiKeyMasked: mask(r.api_key),
    hasApiSecret: !!r.api_secret,
    apiSecretMasked: mask(r.api_secret),
  }
}

export function readSetting<T>(key: string, fallback: T): T {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

function latestSnapshotRow(profileId: number) {
  return sqlite
    .prepare('SELECT * FROM balance_snapshots WHERE profile_id = ? ORDER BY id DESC LIMIT 1')
    .get(profileId) as Record<string, unknown> | undefined
}

function quotasFor(snapshotId: unknown) {
  if (typeof snapshotId !== 'number') return []
  return sqlite
    .prepare('SELECT * FROM quota_windows WHERE snapshot_id = ? ORDER BY id')
    .all(snapshotId) as Record<string, unknown>[]
}

/** 组装「配置 + 最新快照 + 配额窗口 + 设置」，供余额页一次拿全 */
export function buildBalanceView() {
  const profiles = selectProfiles()
  const latest = profiles.map((p) => {
    const snap = latestSnapshotRow(p.id)
    return { profileId: p.id, snapshot: snap ?? null, quotas: snap ? quotasFor(snap.id) : [] }
  })
  return {
    providers: listProviderMeta(),
    profiles: profiles.map(toProfileDTO),
    latest,
    settings: {
      intervalMin: readSetting<number>('balance.intervalMin', 30),
      lowThreshold: readSetting<number>('balance.lowThreshold', 10),
      channels: readSetting<string[]>('balance.channels', ['browser']),
    },
  }
}

/** 逐个跑适配器并落库快照；单个失败不影响其余 */
export async function refreshProfiles(rows: ProfileRow[]): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = []
  for (const row of rows) {
    // 来源标签取自适配器本身，而不是抓取结果——逆向平台即使抓成功也必须标成 reverse
    const adapter = getAdapter(row.provider)
    const source = adapter?.source ?? 'manual'
    const result = await runAdapter({
      provider: row.provider,
      apiKey: row.api_key,
      apiSecret: row.api_secret,
      baseUrl: row.base_url,
      balancePath: row.balance_path,
      authStyle: row.auth_style,
    })
    const capturedAt = nowLocal()
    const raw = JSON.stringify(result.raw ?? null).slice(0, 4000)
    const b = result.balance
    const info = sqlite
      .prepare(
        `INSERT INTO balance_snapshots
           (profile_id, captured_at, source, status, currency, total, granted, topped_up, available, error, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        capturedAt,
        source,
        result.status,
        b?.currency ?? 'CNY',
        b?.total ?? null,
        b?.granted ?? null,
        b?.toppedUp ?? null,
        b?.available ?? null,
        result.error ?? '',
        raw,
      )
    const snapshotId = Number(info.lastInsertRowid)
    for (const q of result.quotas ?? []) {
      sqlite
        .prepare(
          `INSERT INTO quota_windows
             (profile_id, snapshot_id, captured_at, label, type, limit_value, used_value, remaining, percentage, reset_at, raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
        )
        .run(row.id, snapshotId, capturedAt, q.label, q.type, q.limitValue, q.usedValue, q.remaining, q.percentage, q.resetAt)
    }
    outcomes.push({ profileId: row.id, profileName: row.name, status: result.status, error: result.error })
  }
  return outcomes
}

/** 每个 profile 只保留最近 200 条快照，避免无限增长 */
export function pruneSnapshots(): void {
  sqlite.exec(`
    DELETE FROM balance_snapshots WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY id DESC) AS rn FROM balance_snapshots
      ) WHERE rn <= 200
    );
    DELETE FROM quota_windows WHERE snapshot_id IS NOT NULL AND snapshot_id NOT IN (SELECT id FROM balance_snapshots);
  `)
}

export interface LowBalanceHit {
  profileId: number
  name: string
  currency: string
  available: number
  threshold: number
}

/**
 * 找出余额低于阈值的配置。
 * 只认 status='ok' 且 available 有值的快照；逆向端点失败时不会误报低余额。
 */
export function findLowBalances(): LowBalanceHit[] {
  const threshold = readSetting<number>('balance.lowThreshold', 10)
  const rows = selectProfiles().filter((p) => p.balance_enabled)
  const hits: LowBalanceHit[] = []
  for (const p of rows) {
    const snap = latestSnapshotRow(p.id)
    if (!snap || snap.status !== 'ok') continue
    const available = typeof snap.available === 'number' ? snap.available : null
    if (available === null) continue
    if (available < threshold) {
      hits.push({
        profileId: p.id,
        name: p.name,
        currency: typeof snap.currency === 'string' ? snap.currency : 'CNY',
        available,
        threshold,
      })
    }
  }
  return hits
}

// ==================== 趋势与消耗分析 ====================

interface SnapshotRow {
  id: number
  profile_id: number
  captured_at: string
  source: string
  status: string
  currency: string
  total: number | null
  granted: number | null
  topped_up: number | null
  available: number | null
  error: string
}

export interface HistoryPoint {
  t: string
  total: number | null
  available: number | null
  status: string
}

export interface HistorySeries {
  profileId: number
  name: string
  provider: string
  currency: string
  points: HistoryPoint[]
}

export interface BurnStat {
  profileId: number
  name: string
  currency: string
  /** 最新可用余额 */
  available: number | null
  /** 区间内净消耗（首 - 末），负数代表期间有充值 */
  spent: number | null
  /** 参与计算的快照跨度（小时） */
  spanHours: number
  /** 日均消耗 */
  dailyBurn: number | null
  /** 按当前速度预计还能用几天 */
  daysLeft: number | null
  /** 无法估算时的原因，直接展示给用户 */
  reason: string
}

/** 估算日均消耗所需的最小时间跨度：不够就宁可不算，也不要用几分钟的窗口推出荒谬结论 */
const MIN_SPAN_HOURS = 6

function localDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 00:00:00`
}

function parseLocal(s: string): number {
  return new Date(s.replace(' ', 'T')).getTime()
}

export function buildBalanceHistory(days = 30): { days: number; series: HistorySeries[]; stats: BurnStat[] } {
  const cutoff = localDaysAgo(days)
  const rows = sqlite
    .prepare('SELECT * FROM balance_snapshots WHERE captured_at >= ? ORDER BY captured_at ASC, id ASC')
    .all(cutoff) as SnapshotRow[]
  const profiles = selectProfiles()

  const series: HistorySeries[] = []
  const stats: BurnStat[] = []

  for (const p of profiles) {
    const mine = rows.filter((r) => r.profile_id === p.id)
    if (!mine.length) continue
    const currency = mine[mine.length - 1].currency || 'CNY'

    // 趋势图只画成功抓到的点；失败点单列，客户端可据此显示断点
    series.push({
      profileId: p.id,
      name: p.name,
      provider: p.provider,
      currency,
      points: mine.map((r) => ({ t: r.captured_at, total: r.total, available: r.available, status: r.status })),
    })

    const ok = mine.filter((r) => r.status === 'ok' && typeof r.available === 'number')
    const base: BurnStat = {
      profileId: p.id,
      name: p.name,
      currency,
      available: ok.length ? (ok[ok.length - 1].available as number) : null,
      spent: null,
      spanHours: 0,
      dailyBurn: null,
      daysLeft: null,
      reason: '',
    }

    if (ok.length < 2) {
      stats.push({ ...base, reason: '快照不足 2 个成功样本，暂时无法估算消耗速度' })
      continue
    }
    const first = ok[0]
    const last = ok[ok.length - 1]
    const spanHours = (parseLocal(last.captured_at) - parseLocal(first.captured_at)) / 3600000
    base.spanHours = Number(spanHours.toFixed(1))
    if (spanHours < MIN_SPAN_HOURS) {
      stats.push({ ...base, reason: `观测窗口仅 ${base.spanHours} 小时，累计到 ${MIN_SPAN_HOURS} 小时以上再估算更可靠` })
      continue
    }
    const spent = Number(((first.available as number) - (last.available as number)).toFixed(4))
    base.spent = spent
    if (spent <= 0) {
      // 期间充过值（或余额未变），用净差值算消耗会得出负速度
      stats.push({ ...base, reason: '区间内余额未下降（可能充过值），无法估算消耗速度' })
      continue
    }
    const dailyBurn = Number((spent / (spanHours / 24)).toFixed(4))
    base.dailyBurn = dailyBurn
    base.daysLeft = dailyBurn > 0 && base.available !== null ? Number((base.available / dailyBurn).toFixed(1)) : null
    stats.push(base)
  }

  return { days, series, stats }
}
