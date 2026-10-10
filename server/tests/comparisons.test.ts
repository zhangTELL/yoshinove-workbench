import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import { MAX_COMPARISON_CODE_BYTES } from '@wb/shared'
import type { ComparisonInput, ComparisonTopic } from '@wb/shared'
import { COMPARISON_SCHEMA_SQL } from '../src/db/comparisonSchema.js'
import { comparisonRoutes } from '../src/routes/comparisons.js'

function openApp(file = ':memory:') {
  const database = new Database(file)
  database.exec(COMPARISON_SCHEMA_SQL)
  const app = Fastify()
  app.register(comparisonRoutes, { database })
  app.addHook('onClose', async () => { database.close() })
  return app
}

function topicInput(): ComparisonInput {
  return {
    name: '鹈鹕骑自行车测试', prompt: '画一只骑自行车的鹈鹕。',
    entries: [
      { id: 'model-1', name: '模型甲', format: 'svg', fileName: '甲.svg', code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="20" /></svg>' },
      { id: 'model-2', name: '模型乙', format: 'html', fileName: '', code: '<!doctype html><html><body><h1>模型乙的作品</h1></body></html>' },
    ],
  }
}

test('主题和原始作品在关闭数据库、重启服务后仍可读取，列表只返回摘要', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-comparison-test-'))
  const file = join(dir, 'comparisons.db')
  let app = openApp(file)
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }) })
  const input = topicInput()
  const created = await app.inject({ method: 'POST', url: '/api/ai/comparisons', payload: input })
  assert.equal(created.statusCode, 200)
  const topic = created.json<{ topic: ComparisonTopic }>().topic
  await app.close()
  app = openApp(file)
  const loaded = await app.inject({ method: 'GET', url: `/api/ai/comparisons/${topic.id}` })
  assert.deepEqual(loaded.json().topic.entries, input.entries)
  assert.equal(loaded.json().topic.prompt, input.prompt)
  assert.equal(loaded.json().topic.name, input.name)
  const list = (await app.inject({ method: 'GET', url: '/api/ai/comparisons' })).json().topics
  assert.equal(list[0].modelCount, 2)
  assert.equal('entries' in list[0], false)
})

test('修改模型清单会整体替换，删除主题后作品不可再读取', async (t) => {
  const app = openApp()
  t.after(() => app.close())
  const input = topicInput()
  const id = (await app.inject({ method: 'POST', url: '/api/ai/comparisons', payload: input })).json().topic.id
  input.entries.push({ id: 'model-3', name: '模型丙', format: 'html', fileName: '丙.html', code: '<main>第三份作品</main>' })
  const added = await app.inject({ method: 'PUT', url: `/api/ai/comparisons/${id}`, payload: input })
  assert.equal(added.json().topic.entries.length, 3)
  input.name = '重新命名的测试'
  input.entries.shift()
  const replaced = await app.inject({ method: 'PUT', url: `/api/ai/comparisons/${id}`, payload: input })
  assert.equal(replaced.json().topic.name, input.name)
  assert.deepEqual(replaced.json().topic.entries.map((entry: { id: string }) => entry.id), ['model-2', 'model-3'])
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/ai/comparisons/${id}` })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: `/api/ai/comparisons/${id}` })).statusCode, 404)
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/ai/comparisons' })).json().topics, [])
})

test('可以保存尚未收集完的主题，代码块和带 XML 声明的 SVG 能正确识别', async (t) => {
  const app = openApp()
  t.after(() => app.close())
  const input = topicInput()
  input.entries[0].code = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"><text>预览</text></svg>'
  input.entries[1].code = ''
  const draft = await app.inject({ method: 'POST', url: '/api/ai/comparisons', payload: input })
  assert.equal(draft.statusCode, 200)
  assert.equal(draft.json().topic.entries[0].format, 'svg')
  assert.equal(draft.json().topic.entries[1].code, '')
  const id = draft.json().topic.id
  input.entries[1].code = '模型说明\n```html\n<main>完成的作品</main>\n```\n后续说明'
  const updated = await app.inject({ method: 'PUT', url: `/api/ai/comparisons/${id}`, payload: input })
  assert.equal(updated.json().topic.entries[1].code, '<main>完成的作品</main>')
  assert.equal(updated.json().topic.entries[1].format, 'html')
})

test('完整网页中的 Markdown 代码示例原样保存', async (t) => {
  const app = openApp()
  t.after(() => app.close())
  const input = topicInput()
  input.entries[1].code = '<!doctype html><html><body><pre>```html\n<section>示例</section>\n```</pre></body></html>'
  const response = await app.inject({ method: 'POST', url: '/api/ai/comparisons', payload: input })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().topic.entries[1].code, input.entries[1].code)
})

test('无效修改不会覆盖已经保存的主题', async (t) => {
  const app = openApp()
  t.after(() => app.close())
  const input = topicInput()
  const id = (await app.inject({ method: 'POST', url: '/api/ai/comparisons', payload: input })).json().topic.id
  const badInputs = [
    { ...input, name: ' ' },
    { ...input, entries: [input.entries[0]] },
    { ...input, entries: [input.entries[0], input.entries[0]] },
    { ...input, entries: [input.entries[0], { ...input.entries[1], code: '普通说明文字' }] },
    { ...input, entries: [input.entries[0], { ...input.entries[1], code: 42 }] },
  ]
  for (const payload of badInputs) {
    const response = await app.inject({ method: 'PUT', url: `/api/ai/comparisons/${id}`, payload })
    assert.equal(response.statusCode, 400)
    assert.equal(typeof response.json().message, 'string')
  }
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/ai/comparisons/${id}` })).json().topic.entries, input.entries)
  assert.equal((await app.inject({ method: 'GET', url: '/api/ai/comparisons/not-an-id' })).statusCode, 400)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/ai/comparisons/99999', payload: input })).statusCode, 404)
})

test('多个较大的网页作品可超过默认 1 MB 请求上限，单个作品仍限制为 2 MB', async (t) => {
  const app = openApp()
  t.after(() => app.close())
  const input = topicInput()
  input.entries.forEach((entry) => { entry.code = `<main>${'预'.repeat(210000)}</main>` })
  const response = await app.inject({ method: 'POST', url: '/api/ai/comparisons', payload: input })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().topic.entries[1].code, input.entries[1].code)
  input.entries[0].code = `<main>${'a'.repeat(MAX_COMPARISON_CODE_BYTES)}</main>`
  const rejected = await app.inject({ method: 'POST', url: '/api/ai/comparisons', payload: input })
  assert.equal(rejected.statusCode, 400)
  assert.match(rejected.json().message, /2 MB/)
  assert.equal((await app.inject({ method: 'GET', url: '/api/ai/comparisons' })).json().topics.length, 1)
})
