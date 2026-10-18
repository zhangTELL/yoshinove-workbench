import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import { assistantRoutes } from '../src/routes/assistant.js'
import { createAssistant } from '../src/services/assistant.js'

const temporary = mkdtempSync(join(tmpdir(), 'yw-assistant-test-'))
process.env.WORKBENCH_DATA_DIR = temporary
const { sqlite: template, ensureSchema } = await import('../src/db/index.js')
ensureSchema()
template.pragma('journal_mode = DELETE')
after(() => { template.close(); rmSync(temporary, { recursive: true, force: true }) })
type Step = Record<string, unknown> | ((body: Record<string, unknown>) => Response | Promise<Response>)
const call = (name: string, args: unknown) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
function setup(steps: Step[]) {
  const database = new Database(template.serialize())
  database.pragma('foreign_keys = ON')
  const requests: Record<string, unknown>[] = []
  const fetcher: typeof fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body))
    requests.push(body)
    const step = steps.shift()
    assert.ok(step, '不应产生额外模型调用')
    return typeof step === 'function' ? step(body) : Response.json(step)
  }
  const app = Fastify()
  app.register(assistantRoutes, { database, fetcher })
  app.addHook('onClose', async () => { database.close() })
  const seed = () => database.prepare("INSERT INTO countdowns (title,date,category,note) VALUES ('实验报告','2026-11-01','作业','原备注')").run()
  const key = () => app.inject({ method: 'PUT', url: '/api/assistant/config', payload: { apiKey: 'sk-test-only-not-a-real-key' } })
  const chat = () => app.inject({ method: 'POST', url: '/api/assistant/chat', payload: { message: '把实验报告改到11月3日' } })
  return { database, app, requests, seed, key, chat }
}
const updateCountdown = () => [call('search_records', { entity: 'countdown', query: '实验报告' }), call('apply_changes', { answer: '已调整日期，请核对。', changes: [{ entity: 'countdown', action: 'update', id: 1, values: { date: '2026-11-03' } }] })]

test('未配置 Key 不调用模型，Key 只以掩码返回；请求使用官方 Flash 模型且上下文不含 Key', async t => {
  const s = setup([{ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '你好。' } }] }])
  t.after(() => s.app.close())
  const missingKey = await s.chat()
  assert.equal(missingKey.statusCode, 428, missingKey.body)
  assert.equal(s.requests.length, 0)
  const configured = (await s.key()).json()
  assert.equal(configured.configured, true)
  assert.equal(configured.keyMask, '••••-key')
  assert.equal(JSON.stringify(configured).includes('sk-test'), false)
  assert.equal((await s.chat()).statusCode, 200)
  assert.equal(s.requests[0].model, 'deepseek-flash')
  assert.equal(JSON.stringify(s.requests[0]).includes('sk-test-only'), false)
})
test('一句话修改后可定位，刷新仍待确认，撤销逐字段恢复，重复撤销幂等', async t => {
  const s = setup(updateCountdown()); t.after(() => s.app.close()); s.seed(); await s.key()
  const original = s.database.prepare('SELECT * FROM countdowns').get()
  const response = await s.chat()
  assert.equal(response.statusCode, 200, response.body)
  const turn = response.json().turn
  assert.equal(turn.status, 'pending')
  assert.equal(turn.changes[0].target.path, '/tools')
  assert.equal(turn.changes[0].target.query.tab, 'countdown')
  assert.equal((s.database.prepare('SELECT date FROM countdowns').get() as { date: string }).date, '2026-11-03')
  assert.equal(createAssistant(s.database).state().pending?.id, turn.id)
  assert.equal((await s.chat()).statusCode, 409)
  const url = `/api/assistant/turns/${turn.id}/undo`
  assert.equal((await s.app.inject({ method: 'POST', url })).json().turn.status, 'undone')
  assert.deepEqual(s.database.prepare('SELECT * FROM countdowns').get(), original)
  assert.equal((await s.app.inject({ method: 'POST', url })).statusCode, 200)
})
test('确定修改保留新内容，确定后不能再用旧撤销请求覆盖记录', async t => {
  const s = setup(updateCountdown()); t.after(() => s.app.close()); s.seed(); await s.key()
  const turn = (await s.chat()).json().turn
  assert.equal((await s.app.inject({ method: 'POST', url: `/api/assistant/turns/${turn.id}/confirm` })).json().turn.status, 'confirmed')
  assert.equal((await s.app.inject({ method: 'POST', url: `/api/assistant/turns/${turn.id}/undo` })).statusCode, 409)
  assert.equal((s.database.prepare('SELECT date FROM countdowns').get() as { date: string }).date, '2026-11-03')
})
test('批量修改任何一项校验失败都回滚，未读取的记录和任意 SQL 字段都不能修改', async t => {
  for (const values of [{ date: '2026-02-30' }, { id: 99 }, { title: '' }]) {
    const s = setup([call('search_records', { entity: 'countdown' }), call('apply_changes', { changes: [
      { entity: 'countdown', action: 'create', values: { title: '不应残留', date: '2026-11-02' } },
      { entity: 'countdown', action: 'update', id: 1, values },
    ] })]); t.after(() => s.app.close()); s.seed(); await s.key()
    assert.equal((await s.chat()).statusCode, 400)
    assert.equal((s.database.prepare('SELECT COUNT(*) AS n FROM countdowns').get() as { n: number }).n, 1)
    assert.equal((s.database.prepare('SELECT COUNT(*) AS n FROM assistant_turns').get() as { n: number }).n, 0)
  }
  const s = setup([call('apply_changes', { changes: [{ entity: 'countdown', action: 'delete', id: 1 }] })]); t.after(() => s.app.close()); s.seed(); await s.key()
  assert.equal((await s.chat()).statusCode, 409)
})
test('分析期间发生手动修改时拒绝覆盖，撤销期间有后续修改时整批保持不动', async t => {
  const steps = updateCountdown()
  const s = setup([steps[0], () => { s.database.prepare("UPDATE countdowns SET note='用户新内容' WHERE id=1").run(); return Response.json(steps[1]) }])
  t.after(() => s.app.close()); s.seed(); await s.key()
  assert.equal((await s.chat()).statusCode, 409)
  const s2 = setup(updateCountdown()); t.after(() => s2.app.close()); s2.seed(); await s2.key()
  const turn = (await s2.chat()).json().turn
  s2.database.prepare("UPDATE countdowns SET note='用户新内容' WHERE id=1").run()
  assert.equal((await s2.app.inject({ method: 'POST', url: `/api/assistant/turns/${turn.id}/undo` })).statusCode, 409)
  assert.equal((s2.database.prepare('SELECT note FROM countdowns').get() as { note: string }).note, '用户新内容')
})
test('新增课程和单周排课可同批引用，撤销按依赖顺序恢复；学期边界拒绝非法排课', async t => {
  const changes = [
    { entity: 'course', action: 'create', values: { semesterId: 1, name: '线性代数' } },
    { entity: 'session', action: 'create', values: { semesterId: 1, courseId: '$0', weekday: 2, startSection: 1, endSection: 2, weeks: [3] } },
  ]
  const s = setup([call('apply_changes', { changes })]); t.after(() => s.app.close())
  s.database.prepare("INSERT INTO semesters(name,start_date,total_weeks,section_times,is_current) VALUES ('测试学期','2026-09-07',16,?,1)").run(JSON.stringify([{ start: '08:00', end: '08:45' }, { start: '08:50', end: '09:35' }]))
  await s.key()
  const response = await s.chat(); assert.equal(response.statusCode, 200, response.body)
  const turn = response.json().turn
  assert.equal(turn.changes[1].target.query.week, '3')
  assert.equal((await s.app.inject({ method: 'POST', url: `/api/assistant/turns/${turn.id}/undo` })).statusCode, 200)
  assert.equal((s.database.prepare('SELECT COUNT(*) AS n FROM courses').get() as { n: number }).n, 0)
  assert.equal((s.database.prepare('SELECT COUNT(*) AS n FROM course_sessions').get() as { n: number }).n, 0)
})
test('删除提示词后撤销同时恢复测试用例，内容和版本更新可撤销', async t => {
  const s = setup([call('search_records', { entity: 'prompt' }), call('apply_changes', { changes: [{ entity: 'prompt', action: 'delete', id: 1 }] })]); t.after(() => s.app.close())
  s.database.prepare("INSERT INTO prompts(name,content,variables,version,updated_at) VALUES('写作','{主题}','[\"主题\"]',3,'旧时间')").run()
  s.database.prepare("INSERT INTO prompt_cases(prompt_id,input,expected) VALUES(1,'测试输入','预期输出')").run()
  await s.key(); const turn = (await s.chat()).json().turn
  assert.equal((await s.app.inject({ method: 'POST', url: `/api/assistant/turns/${turn.id}/undo` })).statusCode, 200)
  assert.equal((s.database.prepare('SELECT version FROM prompts').get() as { version: number }).version, 3)
  assert.equal((s.database.prepare('SELECT input FROM prompt_cases').get() as { input: string }).input, '测试输入')
})
test('上游认证失败与输出截断不会产生修改，错误不会回显凭据', async t => {
  for (const step of [() => new Response('secret echoed', { status: 401 }), { choices: [{ finish_reason: 'length', message: { content: '' } }] }]) {
    const s = setup([step]); t.after(() => s.app.close()); await s.key()
    const response = await s.chat(); assert.equal(response.statusCode, 502)
    assert.equal(response.body.includes('secret echoed'), false)
    assert.equal(s.database.prepare('SELECT 1 FROM assistant_turns').get(), undefined)
  }
})
