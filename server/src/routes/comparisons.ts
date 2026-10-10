import type Database from 'better-sqlite3'
import type { FastifyError, FastifyPluginAsync } from 'fastify'
import { MAX_COMPARISON_CODE_BYTES, MAX_COMPARISON_MODELS, normalizeComparisonCode } from '@wb/shared'
import type { ComparisonEntry, ComparisonInput, ComparisonTopic } from '@wb/shared'

interface TopicRow {
  id: number
  name: string
  prompt: string
  entries: string
  created_at: string
  updated_at: string
}

function bad(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function text(value: unknown, label: string, maxLength: number, required = false): string {
  if (value !== undefined && typeof value !== 'string') throw bad(`${label}必须是文本`)
  const result = (value as string | undefined ?? '').trim()
  if (required && !result) throw bad(`请填写${label}`)
  if (result.length > maxLength) throw bad(`${label}不能超过 ${maxLength} 个字符`)
  return result
}

function inputOf(value: unknown): ComparisonInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('主题数据格式不正确')
  const b = value as Record<string, unknown>
  const name = text(b.name, '主题名称', 120, true)
  const prompt = text(b.prompt, '共同提示词', 100000)
  if (!Array.isArray(b.entries) || b.entries.length < 2 || b.entries.length > MAX_COMPARISON_MODELS) {
    throw bad(`每个主题需要 2 至 ${MAX_COMPARISON_MODELS} 个模型`)
  }
  const ids = new Set<string>()
  let totalBytes = 0
  const entries: ComparisonEntry[] = b.entries.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('模型作品格式不正确')
    const entry = value as Record<string, unknown>
    const id = text(entry.id, '模型标识', 80, true)
    if (ids.has(id)) throw bad('模型标识不能重复')
    ids.add(id)
    const name = text(entry.name, `第 ${index + 1} 个模型的名称`, 120, true)
    if (typeof entry.code !== 'string') throw bad(`${name} 的作品必须是文本代码`)
    const bytes = Buffer.byteLength(entry.code, 'utf8')
    if (bytes > MAX_COMPARISON_CODE_BYTES) throw bad(`${name} 的代码不能超过 2 MB`)
    totalBytes += bytes
    if (totalBytes > 16 * 1024 * 1024) throw bad('一个主题的作品代码合计不能超过 16 MB')
    let normalized: ReturnType<typeof normalizeComparisonCode>
    try { normalized = normalizeComparisonCode(entry.code) }
    catch (e) { throw bad(`${name}：${(e as Error).message}`) }
    return { id, name, ...normalized, fileName: text(entry.fileName, '文件名', 260) }
  })
  return { name, prompt, entries }
}

function topicOf(row: TopicRow): ComparisonTopic {
  return {
    id: row.id, name: row.name, prompt: row.prompt,
    entries: JSON.parse(row.entries) as ComparisonEntry[],
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function topicId(params: unknown): number {
  const id = Number((params as { id: string }).id)
  if (!Number.isSafeInteger(id) || id < 1) throw bad('主题编号不正确')
  return id
}

/** 接收本地作品，不调用外部模型接口。数据库由入口注入，便于使用独立数据库验收。 */
export const comparisonRoutes: FastifyPluginAsync<{ database: Database.Database }> = async (app, { database }) => {
  const find = (id: number) => database.prepare('SELECT * FROM ai_comparison_topics WHERE id = ?').get(id) as TopicRow | undefined
  const saveOptions = { bodyLimit: 20 * 1024 * 1024 }
  app.setErrorHandler<FastifyError>((error, _req, reply) => {
    const status = error.statusCode ?? 500
    const message = error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? '主题数据过大，请减少作品代码后重试' : error.message
    void reply.code(status).send({ message })
  })

  app.get('/api/ai/comparisons', async () => ({
    topics: database.prepare(`SELECT id, name, model_count AS modelCount, updated_at AS updatedAt
      FROM ai_comparison_topics ORDER BY updated_at DESC, id DESC`).all(),
  }))

  app.get('/api/ai/comparisons/:id', async (req, reply) => {
    const row = find(topicId(req.params))
    if (!row) return reply.code(404).send({ message: '对比主题不存在' })
    return { topic: topicOf(row) }
  })

  app.post('/api/ai/comparisons', saveOptions, async (req) => {
    const input = inputOf(req.body)
    const now = new Date().toISOString()
    const info = database.prepare(`INSERT INTO ai_comparison_topics
      (name, prompt, entries, model_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      input.name, input.prompt, JSON.stringify(input.entries), input.entries.length, now, now,
    )
    return { topic: topicOf(find(Number(info.lastInsertRowid))!) }
  })

  app.put('/api/ai/comparisons/:id', saveOptions, async (req, reply) => {
    const id = topicId(req.params)
    if (!find(id)) return reply.code(404).send({ message: '对比主题不存在' })
    const input = inputOf(req.body)
    database.prepare(`UPDATE ai_comparison_topics SET name = ?, prompt = ?, entries = ?, model_count = ?, updated_at = ? WHERE id = ?`).run(
      input.name, input.prompt, JSON.stringify(input.entries), input.entries.length, new Date().toISOString(), id,
    )
    return { topic: topicOf(find(id)!) }
  })

  app.delete('/api/ai/comparisons/:id', async (req, reply) => {
    const result = database.prepare('DELETE FROM ai_comparison_topics WHERE id = ?').run(topicId(req.params))
    if (!result.changes) return reply.code(404).send({ message: '对比主题不存在' })
    return { ok: true }
  })
}
