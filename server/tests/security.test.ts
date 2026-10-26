import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerLocalRequestGuard } from '../src/security/localRequest.js'
import { safeFetch, validateOutboundUrl, redactSensitiveError } from '../src/security/outbound.js'

test('本地入口拒绝恶意 Host、未知 Origin 与无 Origin 的跨站请求', async t => {
  const app = Fastify()
  registerLocalRequestGuard(app, { apiPort: 5175 })
  let writes = 0
  app.get('/api/private', async () => ({ note: '测试记录' }))
  app.post('/api/write', async () => { writes++; return { ok: true } })
  t.after(() => app.close())
  for (const host of ['evil.example:5175', 'localhost.evil.example:5175', '127.0.0.1:9999', 'user@localhost:5175', '127.0.0.1:5175,evil.example']) {
    assert.equal((await app.inject({ url: '/api/private', headers: { host } })).statusCode, 403, host)
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/write', headers: { host: '127.0.0.1:5175', origin: 'https://evil.example' } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/write', headers: { host: '127.0.0.1:5175', origin: 'null' } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/write', headers: { host: '127.0.0.1:5175', 'sec-fetch-site': 'cross-site' } })).statusCode, 403)
  assert.equal(writes, 0)
})

test('Vite 本机代理、配置端口和无 Origin 的桌面客户端正常访问', async t => {
  const app = Fastify()
  registerLocalRequestGuard(app, { apiPort: 6185, webPort: 6183 })
  app.get('/api/health', async () => ({ ok: true }))
  t.after(() => app.close())
  for (const origin of [undefined, 'http://127.0.0.1:6183', 'http://localhost:6183']) {
    assert.equal((await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:6185', ...(origin ? { origin } : {}), 'sec-fetch-site': 'same-origin' } })).statusCode, 200)
  }
  assert.equal((await app.inject({ url: '/api/health', headers: { host: 'localhost:6185', origin: 'http://localhost:5173' } })).statusCode, 403)
})

test('不透明来源的笔记 iframe 可加载只读主题和图片，不能借路径前缀访问或修改 API', async t => {
  const app = Fastify()
  registerLocalRequestGuard(app, { apiPort: 5175 })
  app.get('/themes/:file', async (_req, reply) => reply.type('text/css').send('body { color: black; }'))
  app.get('/uploads/:name', async (_req, reply) => reply.type('image/png').send(Buffer.alloc(1)))
  app.get('/api/private', async () => ({ secret: 'test-only' }))
  app.post('/uploads/:name', async () => ({ changed: true }))
  t.after(() => app.close())
  const headers = { host: '127.0.0.1:5175', origin: 'null', 'sec-fetch-site': 'cross-site' }
  for (const url of ['/themes/audit.css', '/uploads/test.png']) assert.equal((await app.inject({ url, headers })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/private', headers })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/uploads/test.png', headers })).statusCode, 403)
  assert.equal((await app.inject({ url: '/uploads/test.png', headers: { ...headers, host: 'evil.example:5175' } })).statusCode, 403)
  assert.notEqual((await app.inject({ url: '/themes/../api/private', headers })).statusCode, 200)
})

test('外部接口只接受 HTTPS 或精确的环回 HTTP，地址内不接受凭据', () => {
  for (const value of ['https://api.example/v1', 'http://localhost:8080/v1', 'http://127.0.0.1:8080', 'http://[::1]:8080']) assert.doesNotThrow(() => validateOutboundUrl(value))
  for (const value of ['http://api.example/v1', 'file:///C:/private', 'https://user:password@api.example', 'http://localhost.evil.example', 'https://api.example/\r\nCookie:test']) assert.throws(() => validateOutboundUrl(value))
})

test('带凭据的请求遇到跨来源跳转时不会访问第二个服务器', async () => {
  const calls: string[] = []
  const fetcher = (async input => {
    calls.push(String(input))
    return new Response(null, { status: 307, headers: { location: 'https://other.example/stolen' } })
  }) as typeof fetch
  await assert.rejects(safeFetch('https://api.example/chat', { method: 'POST', headers: { Authorization: 'Bearer example-test-secret' }, body: '{}' }, { fetcher }), /跨来源/)
  assert.deepEqual(calls, ['https://api.example/chat'])
})

test('同源重定向保持认证，POST 303 按 HTTP 语义转换为 GET', async () => {
  const methods: string[] = []
  const fetcher = (async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer example-test-secret')
    assert.equal(init?.redirect, 'manual')
    methods.push(init?.method || 'GET')
    return methods.length === 1 ? new Response(null, { status: 303, headers: { location: '/result' } }) : new Response('ok')
  }) as typeof fetch
  const response = await safeFetch('https://api.example/chat', { method: 'POST', headers: { Authorization: 'Bearer example-test-secret' }, body: '{}' }, { fetcher })
  assert.equal(await response.text(), 'ok')
  assert.deepEqual(methods, ['POST', 'GET'])
})

test('需要检查第一跳的调用保留 manual 语义，循环跳转有次数上限', async () => {
  let calls = 0
  const fetcher = (async () => { calls++; return new Response(null, { status: 302, headers: { location: '/again' } }) }) as typeof fetch
  assert.equal((await safeFetch('https://api.example', { redirect: 'manual' }, { fetcher })).status, 302)
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(safeFetch('https://api.example', {}, { fetcher }), /跳转次数过多/)
  assert.equal(calls, 4)
})

test('上游错误与编码后的凭据在返回前脱敏', async () => {
  const secret = 'test/secret+=value'
  const message = redactSensitiveError(`失败 ${secret} ${encodeURIComponent(secret)} https://user:pass@api.example?access_token=sample123`, [secret])
  assert(!message.includes(secret)); assert(!message.includes(encodeURIComponent(secret))); assert(!message.includes('sample123')); assert(!message.includes('user:pass'))
  const fetcher = (async () => { throw new Error(`Authorization: Bearer ${secret}`) }) as typeof fetch
  await assert.rejects(safeFetch('https://api.example', {}, { fetcher, secrets: [secret] }), error => !String(error).includes(secret))
})
