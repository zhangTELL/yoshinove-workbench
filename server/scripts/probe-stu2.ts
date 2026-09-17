/** 完整链路：stucoursemiddle(302 取 enc) → mycourse/stu → 找 work/list URL */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.resolve(__dirname, '../data/workbench.db'))
const cookie = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'chaoxing.cookie'").get()!.value) as string

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function main() {
  const courseId = process.argv[2] ?? '266941449'
  const classId = process.argv[3] ?? '154281416'

  const mid = await fetch(
    `https://mooc1-api.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${courseId}&clazzid=${classId}&vc=1&cpi=483418708&ismooc2=1&v=2`,
    { headers: { 'User-Agent': UA, Cookie: cookie }, redirect: 'manual', signal: AbortSignal.timeout(20000) },
  )
  const loc = mid.headers.get('location') ?? ''
  console.log('302 →', loc.slice(0, 150))
  if (!loc.includes('enc=')) {
    console.log('未拿到 enc，退出')
    return
  }

  const stuUrl = loc.startsWith('http') ? loc : `https://mooc2-ans.chaoxing.com${loc}`
  const res = await fetch(stuUrl, {
    headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://i.chaoxing.com/' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  })
  const html = await res.text()
  writeFileSync(path.resolve(__dirname, '../../.tmp-stu2.html'), html)
  console.log('课程页:', res.status, '长度:', html.length, '最终URL:', res.url.slice(0, 100))

  const workUrls = [...html.matchAll(/[^"']{0,160}work\/list[^"']{0,200}/g)].map((m) => m[0].replace(/\s+/g, ' '))
  console.log('work/list 出现:', workUrls.length)
  for (const u of [...new Set(workUrls)].slice(0, 5)) console.log('  ', u.slice(0, 260))

  // 也找 作业 tab 的接口线索
  const apiHints = [...new Set([...html.matchAll(/[^"']{0,80}(?:getWorkList|workList|listWork)[^"']{0,120}/g)].map((m) => m[0].replace(/\s+/g, ' ')))]
  console.log('其他作业接口线索:', apiHints.length)
  for (const u of apiHints.slice(0, 8)) console.log('  ', u.slice(0, 200))
}
main()
