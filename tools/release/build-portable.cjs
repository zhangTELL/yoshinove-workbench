const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '../..')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此打包脚本需要 Windows x64 和 Node 26。')
if (Number(process.versions.node.split('.')[0]) !== 26) throw new Error('请使用 Node 26 打包。')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本号无效。')
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
if (git.status !== 0) throw new Error('无法读取发布提交。')
const commit = git.stdout.trim()
const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true })
if (status.status !== 0 || status.stdout.trim()) throw new Error('请先提交源代码，发布包必须对应干净的提交。')
const runtimeCache = path.join(root, 'dist', 'runtime-cache', process.version)
fs.mkdirSync(runtimeCache, { recursive: true })
const release = path.join(root, 'dist', 'releases', `v${version}`)
const stage = path.join(release, `Yoshinove-Workbench-${version}-windows-x64`)
if (fs.existsSync(stage) && fs.readdirSync(stage).length) throw new Error('发布暂存目录已存在，避免覆盖既有产物。')
fs.mkdirSync(stage, { recursive: true })

async function prepareRuntime() {
  const base = 'https://nodejs.org/dist/' + process.version + '/'
  for (const [name, address] of [['SHASUMS256.txt', base + 'SHASUMS256.txt'], ['LICENSE', 'https://raw.githubusercontent.com/nodejs/node/' + process.version + '/LICENSE']]) {
    const response = await fetch(address, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error('无法读取 Node 官方运行时文件：' + name)
    fs.writeFileSync(path.join(runtimeCache, name), await response.text())
  }
}
async function main() {
  await prepareRuntime()
  const manifest = fs.readFileSync(path.join(runtimeCache, 'SHASUMS256.txt'), 'utf8')
  const expected = manifest.split(/\r?\n/).find(line => line.trim().endsWith(' win-x64/node.exe'))?.trim().split(/\s+/)[0]
  const actual = crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex')
  if (!expected || expected !== actual) throw new Error('当前 Node 与官方 Windows x64 校验值不一致。')
  const nodes = new Map()
  const primary = new Map()
  function locate(name, source) {
    const req = createRequire(path.join(source, 'package.json'))
    for (const base of req.resolve.paths(`${name}/package.json`) || []) {
      const candidate = path.join(base, name)
      if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
    }
    throw new Error(`无法解析发布依赖：${name}`)
  }
  function visit(source) {
    source = fs.realpathSync(source)
    if (nodes.has(source)) return source
    const json = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
    const node = { source, name: json.name, version: json.version, dependencies: new Map() }
    nodes.set(source, node)
    if (!primary.has(node.name)) primary.set(node.name, source)
    const required = json.dependencies || {}
    const optional = { ...json.peerDependencies, ...json.optionalDependencies }
    for (const name of new Set([...Object.keys(required), ...Object.keys(optional)])) {
      try { node.dependencies.set(name, visit(locate(name, source))) }
      catch (error) { if (name in required) throw error }
    }
    return source
  }
  // 从已安装依赖递归收集，保留锁定版本与原生构建产物。
  const inputs = [root, path.join(root, 'server')]
  const direct = []
  for (const base of inputs) {
    const json = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'))
    for (const name of Object.keys(json.dependencies || {})) direct.push(locate(name, base))
  }
  for (const source of direct) {
    const json = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
    primary.set(json.name, source)
  }
  for (const source of direct) visit(source)
  const destinationSources = new Map()
  const jobs = []
  function copyPackage(source, target) {
    if (destinationSources.has(target)) return
    fs.cpSync(source, target, { recursive: true, dereference: true, filter: item => {
      const parts = path.relative(source, item).split(path.sep)
      return !parts.includes('node_modules') && !parts.includes('.git')
    } })
    destinationSources.set(target, source)
    jobs.push({ source, target })
  }
  for (const [name, source] of primary) copyPackage(source, path.join(stage, 'node_modules', name))
  for (let index = 0; index < jobs.length; index++) {
    const { source, target } = jobs[index]
    for (const [name, dependency] of nodes.get(source).dependencies) {
      let found
      const req = createRequire(path.join(target, 'package.json'))
      for (const base of req.resolve.paths(`${name}/package.json`) || []) {
        const candidate = path.join(base, name)
        if (destinationSources.has(candidate)) { found = destinationSources.get(candidate); break }
      }
      if (found !== dependency) copyPackage(dependency, path.join(target, 'node_modules', name))
    }
  }
  const sharedPath = path.join(stage, 'node_modules', '@wb', 'shared')
  buildSync({ entryPoints: [path.join(root, 'shared/src/index.ts')], outfile: path.join(sharedPath, 'index.js'), platform: 'node', format: 'esm', bundle: true, legalComments: 'eof' })
  fs.writeFileSync(path.join(sharedPath, 'package.json'), JSON.stringify({ name: '@wb/shared', version, type: 'module', exports: './index.js' }, null, 2))
  fs.cpSync(path.join(root, 'server/dist'), path.join(stage, 'server/dist'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'server/package.json'), JSON.stringify({ name: '@wb/server', version, type: 'module', private: true }))
  fs.cpSync(path.join(root, 'client/dist'), path.join(stage, 'client/dist'), { recursive: true, filter: item => !path.relative(path.join(root, 'client/dist'), item).split(path.sep).includes('theme-local') })
  for (const name of ['assets', 'runtime', 'lib']) fs.cpSync(path.join(root, 'vendor/dsh-pet', name), path.join(stage, 'vendor/dsh-pet', name), { recursive: true })
  for (const name of ['LICENSE', 'package.json', 'upstream.json']) fs.copyFileSync(path.join(root, 'vendor/dsh-pet', name), path.join(stage, 'vendor/dsh-pet', name))
  fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true })
  fs.copyFileSync(process.execPath, path.join(stage, 'runtime/node.exe'))
  fs.copyFileSync(path.join(runtimeCache, 'LICENSE'), path.join(stage, 'runtime/Node-LICENSE.txt'))
  const electronExe = process.env.DSH_PET_ELECTRON_PATH || path.join(os.homedir(), '.dsh/electron/electron.exe')
  fs.cpSync(path.dirname(electronExe), path.join(stage, 'runtime/electron'), { recursive: true })
  fs.copyFileSync(path.join(__dirname, 'launcher.mjs'), path.join(stage, 'launcher.mjs'))
  for (const [name, args] of [['启动工作台.bat', ''], ['停止工作台.bat', '--stop']]) {
    fs.writeFileSync(path.join(stage, name), `@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0launcher.mjs" ${args} %*\r\nif errorlevel 1 pause\r\n`)
  }
  fs.writeFileSync(path.join(stage, 'version.json'), JSON.stringify({ version, commit, platform: 'win32', arch: 'x64', node: process.version, electron: fs.readFileSync(path.join(stage, 'runtime/electron/version'), 'utf8').trim(), dependencies: [...nodes.values()].map(({ name, version }) => ({ name, version })) }, null, 2))
  fs.writeFileSync(path.join(stage, '使用说明.md'), `# Yoshinove工作台 ${version}\n\n适用于 Windows 10/11 64 位，解压到可写目录后双击“启动工作台.bat”，浏览器会自动打开。无需安装 Node、pnpm 或 PowerShell 7。\n\n请保留启动窗口；按 Ctrl+C 或双击“停止工作台.bat”停止服务。若提示端口占用，请先关闭之前的工作台，再重新启动。\n\n业务数据、加密凭据、上传文件和桌宠配置默认保存在本软件包的 server/data 目录，首次启动自动创建，也可用 WORKBENCH_DATA_DIR 指定。备份或迁移时先停止服务，再复制整个 server/data。升级时保留旧目录备份，将 server/data 复制到新版本相同位置。请勿把个人 data 目录上传到公开仓库。新版首次启动会加密旧版凭据，主密钥保存在当前账户的系统凭据库中；换电脑或账户后需重新填写凭据。请保留整个数据目录（包括 credentials.json），不要用旧版本程序写入已升级的数据。\n\n桌宠、笔记编辑器和 PDF 解析资源均已附带；AI、学习通同步及推送功能需要联网并配置自己的凭据。默认网页地址为 http://127.0.0.1:5173，仅本机可访问。项目管理中的 Git 功能需要自行安装 Git。\n\n本包不含个人数据、安卓项目或本地角色素材；缺少素材的主题会自动降级。\n\n版本对应提交：${commit}。第三方许可保留在 runtime 和 node_modules 各组件目录；桌宠许可位于 vendor/dsh-pet/LICENSE。\n\nzhang TELL/Yoshinove\n`)
  const seen = new Set()
  const blocks = []
  function visitNotice(source) {
    source = fs.realpathSync(source)
    if (seen.has(source)) return
    seen.add(source)
    const json = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
    const notices = fs.readdirSync(source).filter(file => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(file) && fs.statSync(path.join(source, file)).isFile())
    blocks.push(`${'='.repeat(72)}\n${json.name}@${json.version} (${typeof json.license === 'string' ? json.license : '见组件许可'})\n${notices.map(file => `${file}\n${fs.readFileSync(path.join(source, file), 'utf8')}`).join('\n')}\n`)
    const req = createRequire(path.join(source, 'package.json'))
    for (const name of Object.keys(json.dependencies || {})) {
      for (const base of req.resolve.paths(`${name}/package.json`) || []) {
        const candidate = path.join(base, name)
        if (fs.existsSync(path.join(candidate, 'package.json'))) { visitNotice(candidate); break }
      }
    }
  }
  visitNotice(path.join(root, 'client'))
  fs.writeFileSync(path.join(stage, '前端第三方许可.txt'), blocks.join('\n'))
  console.log(`已附带 ${seen.size} 个前端组件的许可信息。`)

  const files = []
  function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const full = path.join(directory, name)
      const info = fs.lstatSync(full)
      if (info.isSymbolicLink()) throw new Error(`发布包残留符号链接：${full}`)
      if (info.isDirectory()) walk(full)
      else files.push({ path: path.relative(stage, full).replaceAll('\\', '/'), bytes: info.size })
    }
  }
  walk(stage)
  if (files.some(file => /^(server\/data|Android-timetable|素材|\.git)\//.test(file.path) || /(^|\/)theme-local\//.test(file.path))) throw new Error('包内包含本地数据或受限目录')
  for (const name of ['fastify', '@napi-rs/keyring', 'better-sqlite3']) {
    const installed = JSON.parse(fs.readFileSync(path.join(locate(name, path.join(root, 'server')), 'package.json'), 'utf8')).version
    const packaged = JSON.parse(fs.readFileSync(path.join(stage, 'node_modules', name, 'package.json'), 'utf8')).version
    if (installed !== packaged) throw new Error('发布依赖版本不一致：' + name)
  }
  fs.writeFileSync(path.join(release, '打包校验记录.json'), JSON.stringify({ commit, packages: jobs.length, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), contents: files }, null, 2))
  console.log(JSON.stringify({ stage, packages: jobs.length, files: files.length, totalMiB: Math.round(files.reduce((n, f) => n + f.bytes, 0) / 1048576) }))

}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
