/** 共享类型定义：client / server 共用 */

// ===== 通用 =====
export interface ApiResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

// ===== 课表 =====
/** 节次时间配置：每节课的 {开始, 结束} 时刻 "HH:mm" */
export interface SectionTime {
  start: string
  end: string
}

export interface Semester {
  id: number
  name: string
  /** 第一周周一日期 YYYY-MM-DD */
  startDate: string
  /** 总周数 */
  totalWeeks: number
  /** 12 节课时间表 */
  sectionTimes: SectionTime[]
  isCurrent: boolean
  createdAt: string
}

/** 周次修饰 */
export type WeekParity = 'all' | 'odd' | 'even'

export interface CourseSession {
  id: number
  courseId: number
  semesterId: number
  /** 星期 1~7（周一~周日） */
  weekday: number
  startSection: number
  endSection: number
  /** 周次列表，如 [1,3,5,7] */
  weeks: number[]
  weekParity: WeekParity
  room: string
  note: string
}

export interface Course {
  id: number
  semesterId: number
  name: string
  teacher: string
  color: string
  credit: number
  examType: string
  note: string
}

export interface CourseCellInput {
  name: string
  teacher: string
  room: string
  credit: number
  examType: string
  weekday: number
  startSection: number
  endSection: number
  weeks: number[]
  weekParity: WeekParity
  note?: string
  /** 可选：手动指定课程颜色（自动导入时留空由系统分配） */
  color?: string
}

// ===== 通知 / 提醒 =====
export interface ReminderRule {
  /** 上课前多少分钟提醒 */
  minutesBefore: number
  /** 提醒内容模板，可用 {课程} {教室} {教师} {时间} */
  template: string
  channels: ('browser' | 'pushplus' | 'wecom')[]
  enabled: boolean
}

// ===== 学习通 =====
export interface ChaoxingHomework {
  id: number
  courseName: string
  title: string
  deadline: string | null
  url: string
  status: string
  /** 所属课程的「开课时间」YYYY-MM-DD；老数据（同步前的行）为 null */
  courseStart: string | null
  syncedAt: string
  remindedAt: string | null
}

/**
 * 由日期推断学期标签，按中国学年习惯（第 1 学期 = 秋季 7 月起，第 2 学期 = 春季）。
 * 例：2026-08-31 → "2026-2027第1学期"（与学期名同格式）；2026-03-01 → "2025-2026第2学期"。
 *
 * 为什么用它而不是课程名匹配：学习通的课程列表**不带结构化的学期字段**
 * （courseType/classState/term 参数全被忽略，li 上只有 courseId/clazzId/personId），
 * 但课程块里有「开课时间：YYYY-MM-DD～YYYY-MM-DD」，实测能准确区分本学期与往期。
 * 课程名匹配则不可靠（课表叫「大学体育(3)」、学习通叫「大学体育(3)-2026-2027-1排球」）。
 */
export function termOf(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null
  const m = /^(\d{4})-(\d{1,2})/.exec(dateStr)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  return mo >= 7 ? `${y}-${y + 1}第1学期` : `${y - 1}-${y}第2学期`
}

// ===== 笔记 =====
export interface NoteMeta {
  id: number
  title: string
  courseTag: string
  category: string
  updatedAt: string
}

// ===== AI 实验区 =====
/** 数据来源：官方接口可长期依赖，逆向端点随时失效，手工录入无接口 */
export type BalanceSource = 'official' | 'reverse' | 'manual'
/** 认证方式由数据决定，不写死在适配器里 */
export type AuthStyle = 'bearer' | 'raw' | 'volc-sign' | 'aliyun-rpc'
/** 能力协商：有的平台只有余额没有套餐额度 */
export type BalanceCapability = 'balance' | 'quota'

export interface ProviderMeta {
  id: string
  label: string
  source: BalanceSource
  capabilities: BalanceCapability[]
  credentials: ('key' | 'secret')[]
  defaultBaseUrl: string
  /** 是否在余额页默认展示（未配置时显示为「待配置」占位卡） */
  isDefault: boolean
  note: string
}

/** 出参形态：Key 只以掩码形式出现，原文永不出后端 */
export interface AiProfile {
  id: number
  name: string
  provider: string
  baseUrl: string
  model: string
  enabled: boolean
  authStyle: AuthStyle
  balancePath: string
  balanceEnabled: boolean
  hasApiKey: boolean
  apiKeyMasked: string
  hasApiSecret: boolean
  apiSecretMasked: string
}

export interface BalanceSnapshot {
  id: number
  profile_id: number
  captured_at: string
  source: BalanceSource
  status: 'ok' | 'error' | 'unsupported'
  currency: string
  total: number | null
  granted: number | null
  topped_up: number | null
  available: number | null
  error: string
}

export interface QuotaWindow {
  id: number
  profile_id: number
  snapshot_id: number | null
  captured_at: string
  label: string
  type: 'TOKENS_LIMIT' | 'TIME_LIMIT' | 'COUNT' | 'CREDIT'
  limit_value: number | null
  used_value: number | null
  remaining: number | null
  percentage: number | null
  reset_at: string | null
}

export interface BalanceView {
  providers: ProviderMeta[]
  profiles: AiProfile[]
  latest: { profileId: number; snapshot: BalanceSnapshot | null; quotas: QuotaWindow[] }[]
  settings: { intervalMin: number; lowThreshold: number; channels: string[] }
}

/** 余额趋势的一个采样点 */
export interface BalanceHistoryPoint {
  t: string
  total: number | null
  available: number | null
  status: string
}

export interface BalanceHistorySeries {
  profileId: number
  name: string
  provider: string
  currency: string
  points: BalanceHistoryPoint[]
}

/** 消耗速度分析：无法估算时 dailyBurn / daysLeft 为 null，原因在 reason 里 */
export interface BalanceBurnStat {
  profileId: number
  name: string
  currency: string
  available: number | null
  spent: number | null
  spanHours: number
  dailyBurn: number | null
  daysLeft: number | null
  reason: string
}

export interface BalanceHistory {
  days: number
  series: BalanceHistorySeries[]
  stats: BalanceBurnStat[]
}

export interface PromptCase {
  id: number
  input: string
  expected: string
}

export interface PromptRecord {
  id: number
  name: string
  content: string
  variables: string[]
  version: number
  updatedAt: string
  cases: PromptCase[]
}
