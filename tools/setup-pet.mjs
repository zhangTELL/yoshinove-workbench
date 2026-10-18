import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pet = resolve(root, 'vendor/dsh-pet')
const manifest = JSON.parse(readFileSync(resolve(pet, 'upstream.json'), 'utf8').replace(/^\uFEFF/, ''))
const assets = manifest.assets.filter(asset => !['assets/config.jsonc', 'assets/logo.png'].includes(asset.path))
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const missing = assets.filter(asset => {
  const path = resolve(pet, asset.path)
  return !existsSync(path) || blobHash(readFileSync(path)) !== asset.sha
})
if (missing.length) {
  console.log(`正在准备桌宠动画与字体（${missing.length} 份缺失，首次下载约 130MB）…`)
  let archive
  if (process.env.WORKBENCH_PET_ARCHIVE) archive = readFileSync(process.env.WORKBENCH_PET_ARCHIVE)
  else {
    const response = await fetch(`https://codeload.github.com/${manifest.repository}/zip/${manifest.commit}`, { signal: AbortSignal.timeout(900000) })
    if (!response.ok) throw new Error(`桌宠资源下载失败：HTTP ${response.status}`)
    const chunks = []; let downloaded = 0, reported = 0
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk)); downloaded += chunk.length
      if (downloaded - reported >= 5 * 1024 * 1024) { console.log(`桌宠资源已下载 ${Math.round(downloaded / 1024 / 1024)} MB`); reported = downloaded }
    }
    archive = Buffer.concat(chunks)
  }
  const wanted = new Set(missing.map(asset => asset.path))
  const files = unzipSync(archive, { filter: file => wanted.has(file.name.split('/').slice(2).join('/')) })
  for (const asset of missing) {
    const name = Object.keys(files).find(name => name.split('/').slice(2).join('/') === asset.path)
    const bytes = files[name]
    if (!bytes || blobHash(bytes) !== asset.sha) throw new Error(`桌宠资源校验失败：${asset.path}`)
    const destination = resolve(pet, asset.path)
    if (!destination.startsWith(pet + '\\') && !destination.startsWith(pet + '/')) throw new Error('桌宠资源路径越界')
    mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, bytes)
  }
}
const shared = { absWorkingDir: root, bundle: true, logLevel: 'warning', legalComments: 'eof' }
await build({ ...shared, entryPoints: ['tools/pet/client.mjs'], outfile: 'client/src/pet/runtime.js', platform: 'browser', format: 'esm', minify: true, nodePaths: [resolve(root, 'client/node_modules')], define: { 'process.env.NODE_ENV': '"production"' } })
await build({ ...shared, entryPoints: ['tools/pet/host.mjs'], outfile: 'vendor/dsh-pet/lib/workbench-host.mjs', platform: 'node', format: 'esm', packages: 'external', alias: {
  '@deepseek-ai/dsh-home-paths': resolve(root, 'tools/pet/home.mjs'),
  '@deepseek-ai/dsh-credentials': resolve(pet, 'src/standalone/shims/dsh-credentials.ts'),
  '@deepseek-ai/dsh-llm': resolve(pet, 'src/standalone/shims/dsh-llm.ts'),
} })
await build({ ...shared, entryPoints: ['vendor/dsh-pet/src/shared/index.ts'], outfile: 'vendor/dsh-pet/runtime/electron-helper/shared-core.js', platform: 'browser', format: 'iife', globalName: 'PetShared' })
console.log(`桌宠运行时已就绪（dsh-pet ${manifest.version}，${assets.length} 份资源已校验）`)
