import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import { decodeSettingValue, encodeSettingValue, isEncryptedSecret, maskStoredSecret, migrateCredentials, openSecret, sealSecret } from '../src/security/credentials.js'
import { safeFetch } from '../src/security/outbound.js'

const temporary = mkdtempSync(join(tmpdir(), 'yw-credentials-test-'))
const master = randomBytes(32).toString('base64')
process.env.WORKBENCH_DATA_DIR = temporary
process.env.WORKBENCH_SECRET_KEY = master
const { sqlite, ensureSchema } = await import('../src/db/index.js')
ensureSchema()
sqlite.pragma('journal_mode = DELETE')
const { settingsRoutes } = await import('../src/routes/settings.js')
const { aiRoutes } = await import('../src/routes/ai.js')
const { chaoxingRoutes } = await import('../src/routes/chaoxing.js')
const { validateChaoxingUrl } = await import('../src/services/chaoxing.js')
const { sendWecom } = await import('../src/services/push.js')
after(() => { sqlite.close(); rmSync(temporary, { recursive: true, force: true }) })
beforeEach(() => { process.env.WORKBENCH_SECRET_KEY = master; sqlite.exec('DELETE FROM balance_snapshots; DELETE FROM model_profiles; DELETE FROM settings') })
const key = 'sk-test-only-credential-not-a-real-key'
const secret = 'test-only-api-secret-not-a-real-secret'

test('同一凭据每次使用独立随机 IV，加密值可解密且篡改与错误主密钥会被拒绝', () => {
  const first = sealSecret(key)
  const second = sealSecret(key)
  assert.notEqual(first, second)
  assert.ok(isEncryptedSecret(first))
  assert.equal(openSecret(first), key)
  assert.equal(maskStoredSecret(first), '••••-key')
  const bytes = Buffer.from(first.slice('wb-secret:v1:'.length), 'base64')
  bytes[13] ^= 1
  assert.throws(() => openSecret('wb-secret:v1:' + bytes.toString('base64')), /无法解密/)
  try {
    process.env.WORKBENCH_SECRET_KEY = randomBytes(32).toString('base64')
    assert.throws(() => openSecret(first), /无法解密/)
    assert.match(maskStoredSecret(first), /需重新填写/)
    const replacement = sealSecret(secret)
    assert.equal(openSecret(replacement), secret)
  } finally { process.env.WORKBENCH_SECRET_KEY = master }
  assert.equal(openSecret(first), key)
})

test('无效主密钥显式失败，不降级成明文；非敏感设置不需要加密', () => {
  try {
    process.env.WORKBENCH_SECRET_KEY = 'invalid-test-key'
    assert.throws(() => sealSecret(key), /32 字节/)
    assert.equal(encodeSettingValue('ui.displayName', '测试同学'), '"测试同学"')
  } finally { process.env.WORKBENCH_SECRET_KEY = master }
})

test('用户提交的密文前缀只是凭据内容，不可绕过新写入的加密', () => {
  const value = 'wb-secret:v1:' + key
  const stored = encodeSettingValue('assistant.deepseekKey', value)
  assert.ok(!stored.includes(key))
  assert.equal(decodeSettingValue('assistant.deepseekKey', stored), value)
})

test('旧数据库的所有已登记凭据与余额历史迁移后不再包含明文，业务记录保持不变且可重复迁移', () => {
  const database = new Database(sqlite.serialize())
  try {
    const put = database.prepare('INSERT INTO settings(key,value) VALUES (?,?)')
    put.run('assistant.deepseekKey', JSON.stringify(key))
    put.run('chaoxing.cookie', JSON.stringify('UID=123; test_session=legacy-cookie-only'))
    put.run('notification.pushplusToken', JSON.stringify('pushplus-test-only-token'))
    put.run('notification.wecom', JSON.stringify({ corpId: 'test-corp', secret }))
    put.run('ui.displayName', JSON.stringify('迁移测试同学'))
    database.prepare("INSERT INTO model_profiles(name,base_url,api_key,api_secret,model) VALUES ('测试','https://api.example.com',?,?,'test')").run(key, secret)
    database.prepare("INSERT INTO balance_snapshots(profile_id,captured_at,source,status,currency,error,raw) VALUES (1,'2026-10-26','test','error','CNY',?,?)").run('上游回显 ' + key, JSON.stringify({ api_key: key, nested: { access_token: 'unexpected-upstream-token' }, detail: secret }))
    const before = database.prepare("SELECT value FROM settings WHERE key='ui.displayName'").get()
    assert.ok(migrateCredentials(database) >= 5)
    const rows = database.prepare('SELECT key,value FROM settings').all() as { key: string; value: string }[]
    for (const row of rows) if (row.key !== 'ui.displayName') assert.ok(!row.value.includes(key) && !row.value.includes(secret))
    assert.equal(decodeSettingValue('assistant.deepseekKey', rows.find(row => row.key === 'assistant.deepseekKey')!.value), key)
    const profile = database.prepare('SELECT api_key,api_secret FROM model_profiles').get() as { api_key: string; api_secret: string }
    assert.equal(openSecret(profile.api_key), key)
    assert.equal(openSecret(profile.api_secret), secret)
    const snapshot = database.prepare('SELECT raw,error FROM balance_snapshots').get() as { raw: string; error: string }
    assert.ok(!JSON.stringify(snapshot).includes(key) && !JSON.stringify(snapshot).includes(secret) && !snapshot.raw.includes('unexpected-upstream-token'))
    assert.deepEqual(database.prepare("SELECT value FROM settings WHERE key='ui.displayName'").get(), before)
    assert.equal(migrateCredentials(database), 0)
    assert.ok(!database.serialize().includes(Buffer.from(key)))
    assert.ok(!database.serialize().includes(Buffer.from(secret)))
  } finally { database.close() }
})

test('迁移中凭据库失败时事务回滚，不擦除原凭据或写入部分密文', () => {
  const database = new Database(sqlite.serialize())
  try {
    database.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('assistant.deepseekKey', JSON.stringify(key))
    process.env.WORKBENCH_SECRET_KEY = 'invalid-test-key'
    assert.throws(() => migrateCredentials(database), /32 字节/)
    assert.equal((database.prepare('SELECT value FROM settings').get() as { value: string }).value, JSON.stringify(key))
  } finally { process.env.WORKBENCH_SECRET_KEY = master; database.close() }
})

test('旧版本空值与未配置字段可升级，不因历史设置类型不合法阻止启动', () => {
  for (const legacy of [null, '', false, [], { corpId: 'test', secret: null }]) {
    const database = new Database(sqlite.serialize())
    try {
      database.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('notification.wecom', JSON.stringify(legacy))
      database.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('assistant.deepseekKey', 'null')
      assert.doesNotThrow(() => migrateCredentials(database))
      assert.equal((database.prepare("SELECT value FROM settings WHERE key='assistant.deepseekKey'").get() as { value: string }).value, '""')
      assert.equal(migrateCredentials(database), 0)
    } finally { database.close() }
  }
})

test('设置接口仅返回掩码，掩码回写与企业微信其他字段更新均保留原凭据', async () => {
  const app = Fastify()
  await app.register(settingsRoutes)
  try {
    const written = await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'assistant.deepseekKey': key, 'chaoxing.cookie': 'UID=123; token=test-cookie', 'notification.pushplusToken': secret, 'notification.wecom': { corpId: 'before', secret } } })
    assert.equal(written.statusCode, 200, written.body)
    const before = sqlite.prepare('SELECT key,value FROM settings ORDER BY key').all()
    const masked = (await app.inject('/api/settings')).json()
    assert.ok(!JSON.stringify(masked).includes(key) && !JSON.stringify(masked).includes(secret))
    assert.ok(!JSON.stringify(masked).includes('wb-secret:'))
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', payload: masked })).statusCode, 200)
    assert.deepEqual(sqlite.prepare('SELECT key,value FROM settings ORDER BY key').all(), before)
    masked['notification.wecom'].corpId = 'after'
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'notification.wecom': masked['notification.wecom'] } })
    const raw = (sqlite.prepare("SELECT value FROM settings WHERE key='notification.wecom'").get() as { value: string }).value
    assert.deepEqual(decodeSettingValue('notification.wecom', raw), { corpId: 'after', secret })
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'assistant.deepseekKey': { invalid: key } } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'assistant.currentSession': 'bypass-pending-review' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'notification.wecom': JSON.parse('{"__proto__":{"secret":"test"}}') } })).statusCode, 400)
  } finally { await app.close() }
})

test('模型凭据加密落库，修改名称不会二次加密，出站请求使用解密后的 Key 且错误不会回显', async () => {
  const app = Fastify()
  await app.register(aiRoutes)
  const originalFetch = globalThis.fetch
  try {
    const created = await app.inject({ method: 'POST', url: '/api/ai/profiles', payload: { name: '测试模型', baseUrl: 'https://api.example.com', apiKey: key, apiSecret: secret, model: 'test' } })
    assert.equal(created.statusCode, 200, created.body)
    const id = created.json().id
    const before = sqlite.prepare('SELECT api_key,api_secret FROM model_profiles WHERE id=?').get(id) as { api_key: string; api_secret: string }
    assert.ok(isEncryptedSecret(before.api_key) && isEncryptedSecret(before.api_secret))
    await app.inject({ method: 'PUT', url: `/api/ai/profiles/${id}`, payload: { name: '修改名称' } })
    assert.deepEqual(sqlite.prepare('SELECT api_key,api_secret FROM model_profiles WHERE id=?').get(id), before)
    const listed = (await app.inject('/api/ai/balance')).body
    assert.ok(!listed.includes(key) && !listed.includes(secret) && !listed.includes('wb-secret:'))
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`)
      return Response.json({ error: { message: `错误回显 ${key}` } }, { status: 401 })
    }
    const reply = await app.inject({ method: 'POST', url: '/api/ai/chat', payload: { profileId: id, messages: [] } })
    assert.equal(reply.statusCode, 200)
    assert.ok(!reply.body.includes(key), reply.body)
    const insecure = await app.inject({ method: 'POST', url: '/api/ai/profiles', payload: { name: '拒绝明文网络', baseUrl: 'http://example.com', apiKey: key } })
    assert.equal(insecure.statusCode, 400)
  } finally { globalThis.fetch = originalFetch; await app.close() }
})

test('学习通 Cookie 保存为密文，状态与掩码读取仍兼容', async () => {
  const app = Fastify()
  await app.register(chaoxingRoutes)
  await app.register(settingsRoutes)
  const originalFetch = globalThis.fetch
  const cookie = 'UID=123; test_cookie=only-for-testing'
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://i.chaoxing.com/')
      assert.equal(new Headers(init?.headers).get('cookie'), cookie)
      return new Response('', { status: 200 })
    }
    const saved = await app.inject({ method: 'POST', url: '/api/chaoxing/cookie', payload: { cookie } })
    assert.equal(saved.json().ok, true, saved.body)
    const stored = (sqlite.prepare("SELECT value FROM settings WHERE key='chaoxing.cookie'").get() as { value: string }).value
    assert.ok(!stored.includes(cookie))
    assert.equal(decodeSettingValue('chaoxing.cookie', stored), cookie)
    assert.ok(!(await app.inject('/api/settings')).body.includes(cookie))
    assert.equal((await app.inject('/api/chaoxing/status')).json().hasCookie, true)
  } finally { globalThis.fetch = originalFetch; await app.close() }
})

test('地址中的历史认证参数加密且不回显，原地址仍可在服务端使用，新配置禁止此旁路', async () => {
  const base = 'https://api.example.com/v1?api_key=test-only-url-key'
  const path = '/balance?access_token=test-only-url-token'
  const inserted = sqlite.prepare("INSERT INTO model_profiles(name,base_url,balance_path,api_key,model) VALUES ('旧地址',?,?,?,'test')").run(base, path, key)
  migrateCredentials(sqlite)
  const id = Number(inserted.lastInsertRowid)
  const stored = sqlite.prepare('SELECT base_url,balance_path FROM model_profiles WHERE id=?').get(id) as { base_url: string; balance_path: string }
  assert.ok(isEncryptedSecret(stored.base_url) && isEncryptedSecret(stored.balance_path))
  assert.equal(openSecret(stored.base_url), base)
  assert.equal(openSecret(stored.balance_path), path)
  assert.ok(!sqlite.serialize().includes(Buffer.from('test-only-url-key')))
  const app = Fastify()
  await app.register(aiRoutes)
  try {
    const view = (await app.inject('/api/ai/balance')).json()
    assert.ok(!JSON.stringify(view).includes('test-only-url-key') && !JSON.stringify(view).includes('test-only-url-token'))
    const edited = await app.inject({ method: 'PUT', url: `/api/ai/profiles/${id}`, payload: { name: '保留旧地址', baseUrl: view.profiles[0].baseUrl, balancePath: view.profiles[0].balancePath } })
    assert.equal(edited.statusCode, 200, edited.body)
    assert.deepEqual(sqlite.prepare('SELECT base_url,balance_path FROM model_profiles WHERE id=?').get(id), stored)
    const forbiddenBase = await app.inject({ method: 'POST', url: '/api/ai/profiles', payload: { name: '拒绝URL凭据', baseUrl: base } })
    assert.equal(forbiddenBase.statusCode, 400)
    const forbiddenPath = await app.inject({ method: 'POST', url: '/api/ai/profiles', payload: { name: '拒绝path凭据', baseUrl: 'https://api.example.com', balancePath: path } })
    assert.equal(forbiddenPath.statusCode, 400)
  } finally { await app.close() }
})

test('学习通显式跳转只允许官方 HTTPS 域，手动首跳校验不跟随且错误域不收到 Cookie', async () => {
  for (const url of ['http://mooc1.chaoxing.com', 'https://chaoxing.com.example.com', 'https://example.com', 'https://user:password@chaoxing.com']) assert.throws(() => validateChaoxingUrl(url))
  assert.equal(validateChaoxingUrl('https://mooc1.chaoxing.com/path').hostname, 'mooc1.chaoxing.com')
  let calls = 0
  const response = await safeFetch('https://i.chaoxing.com/', { redirect: 'manual' }, { fetcher: async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://passport2.chaoxing.com/' } }) } })
  assert.equal(response.status, 302)
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(safeFetch('https://i.chaoxing.com/', { headers: { Cookie: 'test-only-cookie' } }, { allowRedirect: (_from, next) => { validateChaoxingUrl(next); return true }, fetcher: async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://evil.example.com/' } }) } }), /官方域名/)
  assert.equal(calls, 1)
})

test('更换企业微信账号或 Secret 后重新取 token，返回错误隐藏 Secret 和访问令牌', async () => {
  const originalFetch = globalThis.fetch
  let lookups = 0
  try {
    globalThis.fetch = async input => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/gettoken')) { lookups++; return Response.json({ access_token: `test-access-${lookups}`, expires_in: 7200 }) }
      return Response.json({ errcode: 123, errmsg: `${secret} test-access-${lookups}` })
    }
    const first = { corpId: 'test-corp-a', agentId: '1', secret, toUser: 'test' }
    const result = await sendWecom(first, '测试', '测试')
    assert.ok(!result.detail.includes(secret) && !result.detail.includes('test-access-1'))
    await sendWecom(first, '测试', '测试')
    assert.equal(lookups, 1)
    await sendWecom({ ...first, corpId: 'test-corp-b' }, '测试', '测试')
    assert.equal(lookups, 2)
  } finally { globalThis.fetch = originalFetch }
})
