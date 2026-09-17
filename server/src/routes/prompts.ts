import type { FastifyPluginAsync } from 'fastify'
import { sqlite } from '../db/index.js'

/** Prompt 管理库：提示词 + {变量} + 测试用例 + 版本号 */

interface PromptRow {
  id: number
  name: string
  content: string
  variables: string
  version: number
  updated_at: string
}

interface CaseRow {
  id: number
  prompt_id: number
  input: string
  expected: string
}

function nowLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 从正文里抽出 {变量}；中文变量名也要能匹配，所以不能用 \w */
function extractVariables(content: string): string[] {
  const found = new Set<string>()
  for (const m of content.matchAll(/\{([^}]+)\}/g)) {
    const name = m[1].trim()
    if (name) found.add(name)
  }
  return [...found]
}

function parseVariables(raw: string, content: string): string[] {
  try {
    const arr = JSON.parse(raw)
    if (Array.isArray(arr) && arr.length) return arr as string[]
  } catch {
    /* 落到重新解析 */
  }
  return extractVariables(content)
}

function casesOf(promptId: number): CaseRow[] {
  return sqlite.prepare('SELECT * FROM prompt_cases WHERE prompt_id = ? ORDER BY id').all(promptId) as CaseRow[]
}

function toDTO(r: PromptRow) {
  const cases = casesOf(r.id)
  return {
    id: r.id,
    name: r.name,
    content: r.content,
    variables: parseVariables(r.variables, r.content),
    version: r.version,
    updatedAt: r.updated_at,
    cases: cases.map((c) => ({ id: c.id, input: c.input, expected: c.expected })),
  }
}

export const promptRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/ai/prompts', async () => {
    const rows = sqlite.prepare('SELECT * FROM prompts ORDER BY updated_at DESC, id DESC').all() as PromptRow[]
    return { prompts: rows.map(toDTO) }
  })

  app.get('/api/ai/prompts/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const row = sqlite.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as PromptRow | undefined
    if (!row) return reply.code(404).send({ message: '提示词不存在' })
    return { prompt: toDTO(row) }
  })

  app.post('/api/ai/prompts', async (req, reply) => {
    const b = req.body as { name?: string; content?: string; cases?: { input?: string; expected?: string }[] }
    const name = String(b.name ?? '').trim()
    if (!name) return reply.code(400).send({ message: '请填写提示词名称' })
    const content = String(b.content ?? '')
    const info = sqlite
      .prepare('INSERT INTO prompts (name, content, variables, version, updated_at) VALUES (?, ?, ?, 1, ?)')
      .run(name, content, JSON.stringify(extractVariables(content)), nowLocal())
    const id = Number(info.lastInsertRowid)
    const insertCase = sqlite.prepare('INSERT INTO prompt_cases (prompt_id, input, expected) VALUES (?, ?, ?)')
    for (const c of b.cases ?? []) insertCase.run(id, String(c.input ?? ''), String(c.expected ?? ''))
    return { ok: true, id }
  })

  app.put('/api/ai/prompts/:id', async (req) => {
    const id = Number((req.params as { id: string }).id)
    const b = req.body as { name?: string; content?: string; cases?: { input?: string; expected?: string }[] }
    const cur = sqlite.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as PromptRow | undefined
    if (!cur) return { ok: false, error: '提示词不存在' }
    const content = String(b.content ?? cur.content)
    // 每次保存版本号 +1，便于回溯「这版是用哪版提示词跑的」
    sqlite
      .prepare('UPDATE prompts SET name = ?, content = ?, variables = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(String(b.name ?? cur.name), content, JSON.stringify(extractVariables(content)), nowLocal(), id)
    if (Array.isArray(b.cases)) {
      sqlite.prepare('DELETE FROM prompt_cases WHERE prompt_id = ?').run(id)
      const insertCase = sqlite.prepare('INSERT INTO prompt_cases (prompt_id, input, expected) VALUES (?, ?, ?)')
      for (const c of b.cases) insertCase.run(id, String(c.input ?? ''), String(c.expected ?? ''))
    }
    const row = sqlite.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as PromptRow
    return { ok: true, prompt: toDTO(row) }
  })

  app.delete('/api/ai/prompts/:id', async (req) => {
    const id = Number((req.params as { id: string }).id)
    sqlite.prepare('DELETE FROM prompt_cases WHERE prompt_id = ?').run(id)
    sqlite.prepare('DELETE FROM prompts WHERE id = ?').run(id)
    return { ok: true }
  })
}
