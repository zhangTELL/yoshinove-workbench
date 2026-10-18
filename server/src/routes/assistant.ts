import type { FastifyPluginAsync } from 'fastify'
import type Database from 'better-sqlite3'
import { createAssistant } from '../services/assistant.js'

export const assistantRoutes: FastifyPluginAsync<{ database: Database.Database; fetcher?: typeof fetch; assistant?: ReturnType<typeof createAssistant> }> = async (app, options) => {
  const assistant = options.assistant ?? createAssistant(options.database, options.fetcher)
  app.get('/api/assistant/config', async () => assistant.config())
  app.put('/api/assistant/config', async req => assistant.saveConfig((req.body as { apiKey?: unknown })?.apiKey))
  app.get('/api/assistant/state', async () => assistant.state())
  app.post('/api/assistant/chat', async req => {
    const body = req.body as { message?: unknown; context?: unknown }
    return { turn: await assistant.chat(body?.message, body?.context) }
  })
  app.post('/api/assistant/turns/:id/:action', async req => {
    const { id, action } = req.params as { id: string; action: string }
    if (action !== 'confirm' && action !== 'undo') throw Object.assign(new Error('操作无效'), { statusCode: 400 })
    return { turn: assistant.finish(id, action) }
  })
}
