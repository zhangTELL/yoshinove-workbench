import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { HelperProcess, helperSpawnEnv, isLocalBridgeCallback } from '../../vendor/dsh-pet/src/host/helper-process.js'

const bridgeModule = fileURLToPath(new URL('../../vendor/dsh-pet/runtime/electron-helper/bridge-security.js', import.meta.url))
const { createBridgeCallbackServer } = createRequire(import.meta.url)(bridgeModule)
const token = 'a'.repeat(64)

test('桌面 helper 不继承工作台主密钥，但保留独立的桥接令牌', () => {
  const env = helperSpawnEnv(123, { WORKBENCH_SECRET_KEY: 'example-secret-key', DSH_PET_BRIDGE_TOKEN: token })
  assert.equal(env.WORKBENCH_SECRET_KEY, undefined)
  assert.equal(env.DSH_PET_BRIDGE_TOKEN, token)
})

test('桌宠回调拒绝无令牌、错误令牌、恶意 Host、超大与非法响应，允许带令牌的原生 null 来源', async t => {
  const payloads: unknown[] = []
  const server = createBridgeCallbackServer({ token, onResponse: (payload: unknown) => payloads.push(payload), maxBodyBytes: 128 })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.close(); server.closeAllConnections() })
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/respond`
  const body = JSON.stringify({ id: 1, status: 200, body: '测试回复' })
  const send = (headers = {}, content = body) => fetch(url, { method: 'POST', headers, body: content })
  assert.equal((await send()).status, 403)
  assert.equal((await send({ Authorization: 'Bearer wrong' })).status, 403)
  const wrongHostStatus = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/respond', method: 'POST', headers: { Authorization: `Bearer ${token}`, Host: `evil.example:${port}` } }, response => { response.resume(); resolve(response.statusCode!) })
    req.on('error', reject); req.end(body)
  })
  assert.equal(wrongHostStatus, 403)
  assert.equal((await send({ Authorization: `Bearer ${token}` }, 'x'.repeat(129))).status, 413)
  assert.equal((await send({ Authorization: `Bearer ${token}` }, '{')).status, 400)
  assert.equal((await send({ Authorization: `Bearer ${token}` }, JSON.stringify({ id: '1', status: 200 }))).status, 400)
  assert.equal(payloads.length, 0)
  assert.equal((await send({ Authorization: `Bearer ${token}`, Origin: 'null' })).status, 200)
  assert.deepEqual(payloads, [{ id: 1, status: 200, body: '测试回复' }])
})

test('未声明长度的分块回调也受到请求体上限约束', async t => {
  const server = createBridgeCallbackServer({ token, onResponse: () => assert.fail('不应消费超大响应'), maxBodyBytes: 32 })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.close(); server.closeAllConnections() })
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: '/respond', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Transfer-Encoding': 'chunked' } }, response => { response.resume(); resolve(response.statusCode!) })
    req.on('error', reject)
    req.write('x'.repeat(20)); req.end('x'.repeat(20))
  })
  assert.equal(status, 413)
})

test('桥接回调 URL 必须是明确的环回端口和固定路径', () => {
  assert(isLocalBridgeCallback('http://127.0.0.1:50000/respond'))
  for (const value of ['https://evil.example/respond', 'http://127.0.0.1:50000/respond?next=external', 'http://user:pass@127.0.0.1:50000/respond', 'http://127.0.0.1:65536/respond', 'http://127.0.0.1:0/respond', 'http://localhost.evil.example:50000/respond']) assert(!isLocalBridgeCallback(value))
})

test('宿主启动子进程后通过带令牌的真实 HTTP 回调完整传递桥接回复', async t => {
  let handled = 0
  const helperCode = `
    const {createBridgeCallbackServer}=require(process.argv[1]);
    const key=process.env.DSH_PET_BRIDGE_TOKEN;
    if(!/^[a-f0-9]{64}$/.test(key||'')) process.exit(2);
    const server=createBridgeCallbackServer({token:key,onResponse:payload=>{
      if(payload.id===2 && payload.body==='独立输入框的测试回复') console.log('BRIDGE_REPLY_OK');
      else process.exitCode=3;
      server.close();
    }});
    server.listen(0,'127.0.0.1',()=>{
      console.log('dsh-pet-bridge:'+JSON.stringify({id:1,method:'GET',url:'/config',cb:'https://evil.example/respond'}));
      console.log('dsh-pet-bridge:'+JSON.stringify({id:2,method:'GET',url:'/config',cb:'http://127.0.0.1:'+server.address().port+'/respond'}));
    });
  `
  const helper = new HelperProcess({ command: process.execPath, args: ['-e', helperCode, bridgeModule], cwd: tmpdir(), bridgeHandler: async req => { handled++; return { id: req.id, status: 200, body: '独立输入框的测试回复' } } }, {})
  t.after(() => helper.stopAndWait())
  const child = helper.start()!
  let output = ''
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('桥接回调超时')), 8000)
    child.stdout!.on('data', data => {
      output += String(data)
      if (output.includes('BRIDGE_REPLY_OK')) { clearTimeout(timer); resolve() }
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
  assert.equal(handled, 1, '恶意外站回调在进入业务处理前就应被拒绝')
})
