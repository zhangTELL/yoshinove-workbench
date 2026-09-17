import type { FastifyPluginAsync } from 'fastify'
import { sqlite } from '../db/index.js'
import { listProviderMeta } from '../services/balance.js'
import {
  buildBalanceHistory,
  buildBalanceView,
  nowLocal,
  pruneSnapshots,
  refreshProfiles,
  selectProfiles,
  type ProfileRow,
} from '../services/balanceStore.js'

/** AI 实验区服务端：模型/余额配置、平台目录、余额抓取、模型对话与对比。Key 只在服务端出现。 */

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '')
}

function chatUrl(baseUrl: string): string {
  return baseUrl.endsWith('/chat/completions') ? baseUrl : `${trimSlash(baseUrl)}/chat/completions`
}

function getProfile(id: number): ProfileRow | undefined {
  return sqlite.prepare('SELECT * FROM model_profiles WHERE id = ?').get(id) as ProfileRow | undefined
}

/** 从 OpenAI 兼容响应里取首个回复与用量 */
function readCompletion(body: Record<string, unknown>): { text: string; tokens: number } {
  const choices = Array.isArray(body.choices) ? body.choices : []
  const first = (choices[0] ?? {}) as { message?: { content?: string } }
  const usage = (body.usage ?? {}) as Record<string, unknown>
  return {
    text: first.message?.content ?? '',
    tokens: Number(usage.total_tokens ?? 0),
  }
}

function errorMessage(body: Record<string, unknown>, raw: string): string {
  const err = body.error as { message?: string } | undefined
  return err?.message ?? raw.replace(/\s+/g, ' ').slice(0, 240)
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/ai/providers', async () => ({ providers: listProviderMeta() }))

  app.get('/api/ai/balance', async () => buildBalanceView())

  /** 余额趋势 + 消耗速度分析。days 支持 7 / 30 / 90 */
  app.get('/api/ai/balance/history', async (req) => {
    const raw = Number((req.query as { days?: string }).days ?? 30)
    const days = [7, 30, 90].includes(raw) ? raw : 30
    return buildBalanceHistory(days)
  })

  // ===== 模型 / 余额配置 CRUD =====
  app.post('/api/ai/profiles', async (req, reply) => {
    const b = req.body as Record<string, unknown>
    const name = String(b.name ?? '').trim()
    if (!name) return reply.code(400).send({ message: '请填写配置名称' })
    const provider = String(b.provider ?? 'custom')
    const meta = listProviderMeta().find((p) => p.id === provider)
    const info = sqlite
      .prepare(
        `INSERT INTO model_profiles
           (name, base_url, api_key, model, enabled, provider, auth_style, api_secret, balance_path, balance_enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        String(b.baseUrl ?? meta?.defaultBaseUrl ?? ''),
        String(b.apiKey ?? ''),
        String(b.model ?? ''),
        b.enabled === false ? 0 : 1,
        provider,
        // 智谱逆向端点用裸 Key，默认值按平台给对，省得用户踩坑
        String(b.authStyle ?? (provider === 'zhipu' ? 'raw' : 'bearer')),
        String(b.apiSecret ?? ''),
        String(b.balancePath ?? ''),
        b.balanceEnabled === false ? 0 : 1,
      )
    return { ok: true, id: Number(info.lastInsertRowid) }
  })

  app.put('/api/ai/profiles/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const b = req.body as Record<string, unknown>
    const cur = getProfile(id)
    if (!cur) return reply.code(404).send({ message: '配置不存在' })
    // Key / Secret 传空表示「不修改」——前端只拿得到掩码，不能回写覆盖真实值
    const apiKey = typeof b.apiKey === 'string' && b.apiKey !== '' ? b.apiKey : cur.api_key
    const apiSecret = typeof b.apiSecret === 'string' && b.apiSecret !== '' ? b.apiSecret : cur.api_secret
    sqlite
      .prepare(
        `UPDATE model_profiles SET name = ?, base_url = ?, api_key = ?, model = ?, enabled = ?,
           provider = ?, auth_style = ?, api_secret = ?, balance_path = ?, balance_enabled = ? WHERE id = ?`,
      )
      .run(
        String(b.name ?? cur.name),
        String(b.baseUrl ?? cur.base_url),
        apiKey,
        String(b.model ?? cur.model),
        b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0,
        String(b.provider ?? cur.provider),
        String(b.authStyle ?? cur.auth_style),
        apiSecret,
        String(b.balancePath ?? cur.balance_path),
        b.balanceEnabled === undefined ? cur.balance_enabled : b.balanceEnabled ? 1 : 0,
        id,
      )
    return { ok: true }
  })

  app.delete('/api/ai/profiles/:id', async (req) => {
    const id = Number((req.params as { id: string }).id)
    sqlite.prepare('DELETE FROM model_profiles WHERE id = ?').run(id)
    sqlite.prepare('DELETE FROM balance_snapshots WHERE profile_id = ?').run(id)
    sqlite.prepare('DELETE FROM quota_windows WHERE profile_id = ?').run(id)
    return { ok: true }
  })

  // ===== 余额抓取 =====
  app.post('/api/ai/balance/refresh', async (req) => {
    const b = (req.body ?? {}) as { profileIds?: number[] }
    const all = selectProfiles()
    const targets =
      Array.isArray(b.profileIds) && b.profileIds.length
        ? all.filter((p) => b.profileIds!.includes(p.id))
        : all.filter((p) => p.balance_enabled)
    if (!targets.length) return { ...buildBalanceView(), outcomes: [] }
    const outcomes = await refreshProfiles(targets)
    pruneSnapshots()
    return { ...buildBalanceView(), outcomes }
  })

  /** 手工录入：无接口平台用，也可用于修正逆向端点的数据 */
  app.post('/api/ai/balance/manual', async (req, reply) => {
    const b = req.body as { profileId?: number; total?: number; currency?: string; note?: string }
    if (!b.profileId) return reply.code(400).send({ message: '缺少 profileId' })
    if (!getProfile(b.profileId)) return reply.code(404).send({ message: '配置不存在' })
    const total = Number(b.total)
    if (!Number.isFinite(total)) return reply.code(400).send({ message: '请填写有效金额' })
    sqlite
      .prepare(
        `INSERT INTO balance_snapshots
           (profile_id, captured_at, source, status, currency, total, granted, topped_up, available, error, raw)
         VALUES (?, ?, 'manual', 'ok', ?, ?, NULL, NULL, ?, '', ?)`,
      )
      .run(b.profileId, nowLocal(), b.currency || 'CNY', total, total, JSON.stringify({ note: b.note ?? '' }))
    return buildBalanceView()
  })

  // ===== 模型调用（Key 不出后端） =====
  app.post('/api/ai/chat', async (req, reply) => {
    const b = req.body as { profileId?: number; messages?: { role: string; content: string }[]; temperature?: number }
    if (!b.profileId) return reply.code(400).send({ message: '缺少 profileId' })
    const row = getProfile(b.profileId)
    if (!row) return reply.code(404).send({ message: '配置不存在' })
    if (!row.api_key) return reply.code(400).send({ message: '该配置还没有填 API Key' })

    const started = Date.now()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 120000)
    try {
      const res = await fetch(chatUrl(row.base_url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${row.api_key}` },
        body: JSON.stringify({ model: row.model, messages: b.messages ?? [], temperature: b.temperature ?? 0.7 }),
        signal: ctrl.signal,
      })
      const raw = await res.text()
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        /* 非 JSON 响应保持空对象，下面统一报错 */
      }
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}：${errorMessage(body, raw)}`, text: '', latencyMs: Date.now() - started }
      }
      const { text, tokens } = readCompletion(body)
      return { ok: true, text, latencyMs: Date.now() - started, tokens }
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? '请求超时（120s）' : (e as Error).message
      return { ok: false, error: msg, text: '', latencyMs: Date.now() - started }
    } finally {
      clearTimeout(timer)
    }
  })

  /** 多模型并排对比：prompt 含 {输入} 则替换，否则 prompt 作 system、用例作 user */
  app.post('/api/ai/compare', async (req, reply) => {
    const b = req.body as { profileIds?: number[]; prompt?: string; cases?: string[] }
    if (!Array.isArray(b.profileIds) || !b.profileIds.length) return reply.code(400).send({ message: '请至少选择一个模型' })
    const prompt = String(b.prompt ?? '')
    const cases = (Array.isArray(b.cases) && b.cases.length ? b.cases : ['']).slice(0, 10)
    const rows = b.profileIds.map(getProfile).filter((r): r is ProfileRow => !!r)
    const hasVar = /\{\s*输入\s*\}|\{\s*input\s*\}/.test(prompt)

    const results = await Promise.all(
      rows.map(async (row) => {
        const outputs = await Promise.all(
          cases.map(async (c, idx) => {
            const messages = hasVar
              ? [{ role: 'user', content: prompt.replace(/\{\s*输入\s*\}|\{\s*input\s*\}/g, c) }]
              : [...(prompt ? [{ role: 'system', content: prompt }] : []), { role: 'user', content: c }]
            const started = Date.now()
            try {
              const res = await fetch(chatUrl(row.base_url), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${row.api_key}` },
                body: JSON.stringify({ model: row.model, messages }),
              })
              const raw = await res.text()
              let body: Record<string, unknown> = {}
              try {
                body = JSON.parse(raw) as Record<string, unknown>
              } catch {
                /* 同上 */
              }
              if (!res.ok) {
                return {
                  caseIndex: idx,
                  caseInput: c,
                  ok: false,
                  error: `HTTP ${res.status}：${errorMessage(body, raw)}`,
                  text: '',
                  latencyMs: Date.now() - started,
                  tokens: 0,
                }
              }
              const { text, tokens } = readCompletion(body)
              return { caseIndex: idx, caseInput: c, ok: true, text, latencyMs: Date.now() - started, tokens }
            } catch (e) {
              return { caseIndex: idx, caseInput: c, ok: false, error: (e as Error).message, text: '', latencyMs: Date.now() - started, tokens: 0 }
            }
          }),
        )
        return { profileId: row.id, name: row.name, model: row.model, provider: row.provider, outputs }
      }),
    )
    return { prompt, hasVar, cases, results }
  })
}
