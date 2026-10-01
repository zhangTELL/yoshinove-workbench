import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { db, sqlite } from '../db/index.js'
import { settings } from '../db/schema.js'

/* ===== 敏感设置的掩码（2026-10-01 审查修复 #1）=====
   GET /api/settings 会把学习通 Cookie、PushPlus Token、企业微信 Secret 原样吐给页面。
   配合 CORS 白名单这已经是第二道防线：即便某个页面拿到了读取能力，拿到的也只是掩码。
   ⭐ 写入端必须配套：PUT 时识别出「掩码串」就跳过/还原——否则 PushChannelCard 这类
   "读出来 → 原样存回" 的组件会把掩码当成真值覆盖进库。真实凭据不会以 •••• 开头
   （pushplus 是 32 位 hex、企业微信 secret 是字母数字、cookie 是长 base64），误判概率为零。 */
const SECRET_KEYS = new Set(['chaoxing.cookie', 'notification.pushplusToken'])
const SECRET_NESTED: Record<string, readonly string[]> = { 'notification.wecom': ['secret'] }
const MASK_PREFIX = '••••'

function maskSecret(v: string): string {
  if (!v) return v
  return MASK_PREFIX + v.slice(-4)
}

const isMasked = (v: unknown): boolean => typeof v === 'string' && v.startsWith(MASK_PREFIX)

/** 深拷贝并对敏感字段打掩码（只处理上面登记的键，其它设置原样透出） */
function maskSettingsMap(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEYS.has(key) && typeof value === 'string') {
      out[key] = maskSecret(value)
      continue
    }
    const nested = SECRET_NESTED[key]
    if (nested && value && typeof value === 'object' && !Array.isArray(value)) {
      const copy = { ...(value as Record<string, unknown>) }
      for (const f of nested) if (typeof copy[f] === 'string') copy[f] = maskSecret(copy[f] as string)
      out[key] = copy
      continue
    }
    out[key] = value
  }
  return out
}

/** 读库里某个键的现有值（PUT 还原掩码字段用）；没有返回 null */
function readRawSetting(key: string): unknown {
  const row = db.select().from(settings).where(eq(settings.key, key)).get()
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return row.value
  }
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/settings', async () => {
    const rows = db.select().from(settings).all()
    const out: Record<string, unknown> = {}
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value)
      } catch {
        out[r.key] = r.value
      }
    }
    return maskSettingsMap(out)
  })

  app.put('/api/settings', async (req) => {
    const body = req.body as Record<string, unknown>
    const upsert = sqlite.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    const tx = sqlite.transaction(() => {
      for (const [key, value] of Object.entries(body)) {
        // ① 整键是敏感串：收到掩码串 = 用户没改过这个凭据，保留库里真值
        if (SECRET_KEYS.has(key) && isMasked(value)) continue

        // ② 嵌套敏感字段（企业微信的 secret）：掩码字段从库里的现有值还原，
        //    其余字段正常写入（PushChannelCard 每次都整对象存回，只挡 secret）
        const nested = SECRET_NESTED[key]
        if (nested && value && typeof value === 'object' && !Array.isArray(value)) {
          const incoming = { ...(value as Record<string, unknown>) }
          const existing = readRawSetting(key)
          let touched = false
          for (const f of nested) {
            if (isMasked(incoming[f])) {
              const prev = existing as Record<string, unknown> | null
              if (prev && typeof prev[f] === 'string') incoming[f] = prev[f]
              else delete incoming[f]
              touched = true
            }
          }
          if (touched) {
            upsert.run(key, JSON.stringify(incoming))
            continue
          }
        }

        upsert.run(key, JSON.stringify(value))
      }
    })
    tx()
    return { ok: true }
  })

  app.get('/api/settings/:key', async (req) => {
    const { key } = req.params as { key: string }
    const raw = readRawSetting(key)
    // 注意：必须包在对象里返回——裸字符串会被 Fastify 以 text/plain 输出，客户端 res.json() 会解析失败
    if (raw === null) return { value: null }
    const masked = maskSettingsMap({ [key]: raw })
    return { value: masked[key] }
  })
}
