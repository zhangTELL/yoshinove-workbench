/** 学习通作业列表接口探测：用真实课程试多个候选端点并 dump 返回 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.resolve(__dirname, '../data/workbench.db'))
const cookie = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'chaoxing.cookie'").get()!.value) as string

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function dump(name: string, url: string, init?: RequestInit) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    ...init,
    headers: { 'User-Agent': UA, Cookie: cookie, ...(init?.headers ?? {}) },
  })
  const html = await res.text()
  writeFileSync(path.resolve(__dirname, `../../.tmp-work-${name}.html`), html)
  console.log(`[${name}] ${res.status} 长度=${html.length} 最终URL=${res.url.slice(0, 100)}`)
  console.log(`[${name}] 预览:`, html.slice(0, 300).replace(/\s+/g, ' '))
  console.log('---')
}

async function main() {
  const args = process.argv.slice(2)
  const courseId = args[0] ?? '266941449'
  const classId = args[1] ?? '154281416'
  const cpi = args[2] ?? '483418708'

  const common = {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://mooc2-ans.chaoxing.com/' },
  }
  await dump('v1-mooc2worklist', `https://mooc1-api.chaoxing.com/mooc2/work/list?courseId=${courseId}&classId=${classId}&ut=default&view=local&mooc=false`, common)
  await dump('v2-ut-s', `https://mooc1-api.chaoxing.com/mooc2/work/list?courseId=${courseId}&classId=${classId}&ut=s&mooc=false`, common)
  await dump('v3-getworklist', `https://mooc2-ans.chaoxing.com/mooc2-ans/work/getWorkList?courseId=${courseId}&classId=${classId}&cpi=${cpi}`, common)
  await dump('v4-worklistdata', `https://mooc1-api.chaoxing.com/work/listAll?courseId=${courseId}&classId=${classId}`, common)
}

main()
