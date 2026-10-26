import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import fsDefault from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { request } from 'node:http'
import { after, mock, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'

const temporary = fs.mkdtempSync(path.join(tmpdir(), 'yw-portability-'))
process.env.WORKBENCH_DATA_DIR = path.join(temporary, 'data')
process.env.WORKBENCH_SECRET_KEY = randomBytes(32).toString('base64')
const { resolveDataDir, resolveTyporaThemesDir, configuredPort } = await import('../src/config.js')
const { sqlite, ensureSchema } = await import('../src/db/index.js')
ensureSchema()
const files = await import('../src/services/projectFiles.js')
const { startPreview, stopPreview, stopAllPreviews } = await import('../src/services/previewServer.js')
const { sanitizeGitRemote } = await import('../src/services/gitSafety.js')
const { describeOne, listRoots } = await import('../src/services/projectScan.js')
const { readGitDetail } = await import('../src/services/projectGit.js')
const { scrubbedEnv } = await import('../src/services/openInApp.js')

after(() => {
  stopAllPreviews()
  sqlite.close()
  assert.equal(path.dirname(fs.realpathSync.native(temporary)).toLowerCase(), fs.realpathSync.native(tmpdir()).toLowerCase())
  fs.rmSync(temporary, { recursive: true, force: true })
})

let counter = 0
function project() {
  const directory = path.join(temporary, `project-${++counter}`)
  fs.mkdirSync(directory)
  const result = sqlite.prepare("INSERT INTO projects(path,name,first_seen_at,updated_at) VALUES (?,?,'2026-10-26','2026-10-26')").run(directory, path.basename(directory))
  return { directory, id: Number(result.lastInsertRowid) }
}

function symbolicLink(t: { skip(message: string): void }, target: string, link: string, type: 'file' | 'dir' | 'junction' = 'file') {
  try { fs.symlinkSync(target, link, type); return true }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code || '')) {
      t.skip('当前账户不能创建此类符号链接，未宣称该边界已实测')
      return false
    }
    throw error
  }
}

test('数据目录和桌宠主目录不依赖启动 cwd，Typora 按各平台用户目录解析', async () => {
  const serverDirectory = fileURLToPath(new URL('../', import.meta.url))
  assert.equal(resolveDataDir({}), path.join(serverDirectory, 'data'))
  assert.equal(resolveDataDir({ WORKBENCH_DATA_DIR: 'portable-data' }), path.join(serverDirectory, 'portable-data'))
  assert.equal(resolveDataDir(), path.join(temporary, 'data'))
  const original = process.cwd()
  const previousPetHome = process.env.WORKBENCH_PET_HOME
  delete process.env.WORKBENCH_PET_HOME
  process.chdir(temporary)
  try {
    assert.equal(resolveDataDir({}), path.join(serverDirectory, 'data'))
    const { resolveDshHome } = await import('../../tools/pet/home.mjs')
    assert.equal(resolveDshHome(), path.join(temporary, 'data', 'pet'))
  } finally {
    process.chdir(original)
    if (previousPetHome === undefined) delete process.env.WORKBENCH_PET_HOME
    else process.env.WORKBENCH_PET_HOME = previousPetHome
  }
  assert.equal(resolveTyporaThemesDir({ APPDATA: 'C:\\Users\\别的账户\\AppData\\Roaming' }, 'win32', 'C:\\Users\\别的账户'), 'C:\\Users\\别的账户\\AppData\\Roaming\\Typora\\themes')
  assert.equal(resolveTyporaThemesDir({}, 'darwin', '/Users/other'), '/Users/other/Library/Application Support/abnerworks.Typora/themes')
  assert.equal(resolveTyporaThemesDir({ XDG_CONFIG_HOME: '/custom/config' }, 'linux', '/home/other'), '/custom/config/Typora/themes')
  assert.equal(configuredPort('6001', 5173), 6001)
  assert.throws(() => configuredPort('65536', 5173), /端口/)
  const database = sqlite.prepare('PRAGMA database_list').all() as { file: string }[]
  assert.equal(database[0].file.toLowerCase(), path.join(temporary, 'data/workbench.db').toLowerCase())
})

test('主题导入和图片上传实际写入自定义数据目录', async () => {
  const themeSource = path.join(temporary, 'typora')
  fs.mkdirSync(themeSource)
  fs.writeFileSync(path.join(themeSource, 'portable.css'), 'body { color: tomato; }')
  const { noteRoutes } = await import('../src/routes/notes.js')
  const { uploadRoutes, uploadsDir } = await import('../src/routes/uploads.js')
  assert.equal(uploadsDir, path.join(temporary, 'data/uploads'))
  const app = Fastify()
  await app.register(multipart)
  await app.register(noteRoutes)
  await app.register(uploadRoutes)
  try {
    const imported = await app.inject({ method: 'POST', url: '/api/notes/themes/import', payload: { source: themeSource } })
    assert.equal(imported.statusCode, 200, imported.body)
    assert.equal(fs.readFileSync(path.join(temporary, 'data/themes/portable.css'), 'utf8'), 'body { color: tomato; }')
    assert.equal((await app.inject('/themes/portable.css')).statusCode, 200)
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Gv0AAAAASUVORK5CYII=', 'base64')
    const boundary = 'workbench-portability-test'
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`), image, Buffer.from(`\r\n--${boundary}--\r\n`)])
    const uploaded = await app.inject({ method: 'POST', url: '/api/upload/image', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
    assert.equal(uploaded.statusCode, 200, uploaded.body)
    const imageUrl = uploaded.json().url as string
    assert.deepEqual(fs.readFileSync(path.join(uploadsDir, path.basename(imageUrl))), image)
    const downloaded = await app.inject(imageUrl)
    assert.equal(downloaded.statusCode, 200)
    assert.deepEqual(downloaded.rawPayload, image)
  } finally { await app.close() }
})

test('预览正常网页可访问，隐藏凭据、SQLite 辅助文件和密钥容器均拒绝发布', async () => {
  const { directory, id } = project()
  fs.writeFileSync(path.join(directory, 'index.html'), '<p>portable</p>')
  const sensitive = ['.env', '.git/config', 'workbench.db', 'workbench.db-wal', 'workbench.db-shm', 'workbench.db-journal', 'credentials.json', 'secrets.json', 'account.jks', 'account.keystore', 'file.txt.bak']
  for (const name of sensitive) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true })
    fs.writeFileSync(path.join(directory, name), '不能通过预览读取')
  }
  const preview = await startPreview(id)
  try {
    assert.equal(await (await fetch(preview.url!)).text(), '<p>portable</p>')
    assert.equal((await fetch(preview.url!, { method: 'HEAD' })).status, 200)
    for (const name of sensitive) assert.equal((await fetch(new URL(name, preview.url!))).status, 403, name)
    const hostileHost = await new Promise<number>((done, reject) => {
      const req = request(preview.url!, { headers: { Host: `evil.example:${preview.port}` } }, response => { response.resume(); response.on('end', () => done(response.statusCode!)) })
      req.on('error', reject)
      req.end()
    })
    assert.equal(hostileHost, 403)
    assert.equal((await fetch(preview.url!, { method: 'POST' })).status, 405)
  } finally { stopPreview(id) }
})

test('主题导入不沿着已有资源目录 junction 写入数据目录之外', async t => {
  const source = path.join(temporary, 'theme-import-source')
  const outside = path.join(temporary, 'outside-theme-resources')
  fs.mkdirSync(path.join(source, 'fonts'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(source, 'fonts/new.woff2'), '不应写到外部')
  const destination = path.join(temporary, 'data/themes/fonts')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (!symbolicLink(t, outside, destination, process.platform === 'win32' ? 'junction' : 'dir')) return
  const { noteRoutes } = await import('../src/routes/notes.js')
  const app = Fastify()
  await app.register(noteRoutes)
  try {
    const response = await app.inject({ method: 'POST', url: '/api/notes/themes/import', payload: { source } })
    assert.equal(fs.existsSync(path.join(outside, 'new.woff2')), false, '导入不能写入 junction 指向的外部目录')
    assert.ok(response.statusCode >= 400, response.body)
  } finally { await app.close(); fs.unlinkSync(destination) }
})

test('主题导入替换本地 CSS 时不修改外部硬链接文件', async () => {
  const source = path.join(temporary, 'theme-hardlink-source')
  const outside = path.join(temporary, 'outside-theme.css')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'linked.css'), '新主题')
  fs.writeFileSync(outside, '外部文件保持不变')
  const destination = path.join(temporary, 'data/themes/linked.css')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.linkSync(outside, destination)
  const { noteRoutes } = await import('../src/routes/notes.js')
  const app = Fastify()
  await app.register(noteRoutes)
  try {
    const response = await app.inject({ method: 'POST', url: '/api/notes/themes/import', payload: { source } })
    assert.equal(fs.readFileSync(outside, 'utf8'), '外部文件保持不变')
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(fs.readFileSync(destination, 'utf8'), '新主题')
  } finally { await app.close(); fs.unlinkSync(destination) }
})

test('预览补目录 index.html 后仍拒绝外部符号链接', async t => {
  const { directory, id } = project()
  const outside = path.join(temporary, 'outside-preview.html')
  fs.writeFileSync(outside, '不能逃出项目')
  fs.writeFileSync(path.join(directory, 'index.html'), '<p>root</p>')
  fs.mkdirSync(path.join(directory, 'child'))
  if (!symbolicLink(t, outside, path.join(directory, 'child/index.html'))) return
  const preview = await startPreview(id)
  try { assert.equal((await fetch(new URL('child/', preview.url!))).status, 403) }
  finally { stopPreview(id) }
})

test('项目解析拒绝目录 junction 越界、父目录穿越和 Windows ADS 路径', t => {
  const { directory, id } = project()
  const outside = path.join(temporary, 'outside-junction')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'private.txt'), 'private')
  if (!symbolicLink(t, outside, path.join(directory, 'jump'), process.platform === 'win32' ? 'junction' : 'dir')) return
  assert.throws(() => files.readProjectFile(id, 'jump/private.txt'), /项目之外/)
  assert.throws(() => files.resolveInProject(id, '../outside-junction/private.txt'), /范围/)
  assert.throws(() => files.resolveInProject(id, 'file.txt:private'), /相对路径/)
})

test('大文本仅有限读取供预览，不把整个文件装入内存或标为可编辑', () => {
  const { directory, id } = project()
  const target = path.join(directory, 'large.txt')
  fs.writeFileSync(target, Buffer.alloc(files.MAX_READ * 4, 'A'))
  const originalRead = fsDefault.readSync
  let bytesRequested = 0
  const boundedRead = mock.method(fsDefault, 'readSync', (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    bytesRequested += length
    return originalRead(fd, buffer, offset, length, position)
  })
  syncBuiltinESMExports()
  try {
    const result = files.readProjectFile(id, 'large.txt')
    assert.equal(result.kind, 'tooLarge')
    assert.equal(result.truncated, true)
    assert.equal(result.editable, false)
    assert.equal(result.content?.length, 512 * 1024)
    assert.ok(bytesRequested > 0 && bytesRequested <= 1024 * 1024, '读取预算应有硬上限，而非完整读取 8MB 文件')
    assert.equal(fs.statSync(target).size, files.MAX_READ * 4)
  } finally { boundedRead.mock.restore(); syncBuiltinESMExports() }
})

test('保存文件会保留旧内容备份，并且不会覆盖 .bak 硬链接指向的项目外文件', () => {
  const { directory, id } = project()
  const target = path.join(directory, 'edit.txt')
  const outside = path.join(temporary, 'outside-backup.txt')
  fs.writeFileSync(target, '旧内容')
  fs.writeFileSync(outside, '外部内容保持不变')
  fs.linkSync(outside, `${target}.bak`)
  files.writeProjectFile(id, 'edit.txt', '新内容')
  assert.equal(fs.readFileSync(target, 'utf8'), '新内容')
  assert.equal(fs.readFileSync(`${target}.bak`, 'utf8'), '旧内容')
  assert.equal(fs.readFileSync(outside, 'utf8'), '外部内容保持不变')
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0)
})

test('保存源文件若为外部硬链接则拒绝写入', () => {
  const { directory, id } = project()
  const outside = path.join(temporary, 'outside-hardlink.txt')
  fs.writeFileSync(outside, '外部内容保持不变')
  fs.linkSync(outside, path.join(directory, 'alias.txt'))
  assert.throws(() => files.writeProjectFile(id, 'alias.txt', '不应写入'), /硬链接/)
  assert.equal(fs.readFileSync(outside, 'utf8'), '外部内容保持不变')
})

test('保存时拒绝 .bak 符号链接，保持源文件和外部文件不变', t => {
  const { directory, id } = project()
  const outside = path.join(temporary, 'outside-symbolic-backup.txt')
  fs.writeFileSync(outside, 'outside')
  fs.writeFileSync(path.join(directory, 'edit.txt'), 'old')
  if (!symbolicLink(t, outside, path.join(directory, 'edit.txt.bak'))) return
  assert.throws(() => files.writeProjectFile(id, 'edit.txt', 'new'), /备份位置/)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside')
  assert.equal(fs.readFileSync(path.join(directory, 'edit.txt'), 'utf8'), 'old')
})

test('新建文件不会跟随已有悬空符号链接创建项目外文件', t => {
  const { directory, id } = project()
  const absent = path.join(temporary, 'outside-absent.txt')
  if (!symbolicLink(t, absent, path.join(directory, 'new.txt'))) return
  assert.throws(() => files.createEntry(id, '', 'new.txt', 'file'), /已经存在/)
  assert.equal(fs.existsSync(absent), false)
  assert.throws(() => files.createEntry(id, '', 'CON.txt', 'file'), /保留/)
})

function git(directory: string, args: string[]): string {
  const result = spawnSync('rtk', ['proxy', 'git', ...args], { cwd: directory, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('Git 元信息读取不执行自定义 fsmonitor，远程 URL 不泄漏认证信息', async () => {
  const { directory, id } = project()
  git(directory, ['init', '--quiet'])
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'tracked')
  git(directory, ['add', '--', 'tracked.txt'])
  const marker = path.join(directory, 'monitor-ran.txt')
  const hook = path.join(directory, '.git', 'monitor.cjs')
  fs.writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('token\\0');`)
  const shellQuote = (value: string) => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`
  git(directory, ['config', 'core.fsmonitor', `${shellQuote(process.execPath)} ${shellQuote(hook)}`])
  git(directory, ['status', '--porcelain'])
  assert.equal(fs.existsSync(marker), true, '先证明无保护的 Git status 会执行测试 hook')
  fs.unlinkSync(marker)
  const remote = 'https://PAT-for-test:password-for-test@example.com/owner/repo.git?token=hidden&branch=main'
  git(directory, ['remote', 'add', 'origin', remote])
  const meta = await describeOne(directory)
  await readGitDetail(id)
  assert.equal(fs.existsSync(marker), false)
  assert.equal(meta.gitRemote, 'https://example.com/owner/repo.git?branch=main')
  assert.equal(sanitizeGitRemote('git@github.com:owner/repo.git'), 'git@github.com:owner/repo.git')
  assert.equal(sanitizeGitRemote('ssh://git:private@example.com/owner/repo.git'), 'ssh://git@example.com/owner/repo.git')
  assert.ok(listRoots().some(item => item.path === homedir()))
})

test('外部应用环境不会继承凭据与 Electron Node 模式', () => {
  const names = ['WORKBENCH_SECRET_KEY', 'TEST_SESSION_ID', 'TEST_COOKIE', 'ELECTRON_RUN_AS_NODE']
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  try {
    for (const name of names) process.env[name] = 'private-test-value'
    const clean = scrubbedEnv()
    for (const name of names) assert.equal(clean[name], undefined)
    const pathValue = Object.entries(clean).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
    assert.ok(pathValue === process.env.PATH, '应保留 PATH')
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
})

test('Windows 启停脚本使用同一端口配置，停止匹配不波及其他 checkout', { skip: process.platform !== 'win32' }, () => {
  const helper = fileURLToPath(new URL('../../tools/workbench-runtime.ps1', import.meta.url))
  const script = path.join(temporary, 'runtime-test.ps1')
  fs.writeFileSync(script, `param([string]$RuntimeFile)
$ErrorActionPreference = 'Stop'
. $RuntimeFile
$env:WORKBENCH_WEB_PORT = '6011'
$env:PORT = '6012'
$ports = Get-WorkbenchPorts
if ($ports.Web -ne 6011 -or $ports.Api -ne 6012) { throw '自定义端口未生效' }
$root = 'D:\\学生项目\\工作台'
$own = 'pwsh -NoProfile -File "D:\\学生项目\\工作台\\tools\\start-workbench.ps1"'
$other = 'pwsh -NoProfile -File "D:\\学生项目\\另一份工作台\\tools\\start-workbench.ps1"'
if (-not (Test-WorkbenchProcessCommand -Name 'pwsh.exe' -CommandLine $own -ProjectRoot $root)) { throw '没有匹配当前启动器' }
if (Test-WorkbenchProcessCommand -Name 'pwsh.exe' -CommandLine $other -ProjectRoot $root) { throw '误匹配其他启动器' }
if (Test-WorkbenchProcessCommand -Name 'node.exe' -CommandLine 'node D:/学生项目/工作台-copy/client/vite.js' -ProjectRoot $root) { throw '误匹配相似前缀' }
if (-not (Test-WorkbenchProcessCommand -Name 'node.exe' -CommandLine 'node D:/学生项目/工作台/client/vite.js' -ProjectRoot $root)) { throw '未匹配当前子进程' }
$env:PORT = '6011'
$invalid = $false
try { Get-WorkbenchPorts | Out-Null } catch { $invalid = $true }
if (-not $invalid) { throw '允许前后端使用同一端口' }
Write-Output '端口配置与本 checkout 进程匹配通过'
`)
  const result = spawnSync('rtk', ['proxy', 'pwsh', '-NoProfile', '-File', script, helper], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
