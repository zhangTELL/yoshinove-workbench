/** 探测：进入课程中间页 → 找到真实作业列表 URL（含 enc） */
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

  // 进入课程中间页（会重定向到真实课程页）
  const res = await fetch(
    `https://mooc1-api.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${courseId}&clazzid=${classId}&vc=1&cpi=483418708&ismooc2=1&v=2`,
    { headers: { 'User-Agent': UA, Cookie: cookie }, redirect: 'follow', signal: AbortSignal.timeout(20000) },
  )
  const html = await res.text()
  console.log('中间页最终 URL:', res.url)
  console.log('长度:', html.length)
  writeFileSync(path.resolve(__dirname, '../../.tmp-coursepage.html'), html)

  // 找 work 相关的 URL 和 enc
  const workUrls = [...html.matchAll(/[^"']{0,120}work\/list[^"']{0,160}/g)].map((m) => m[0])
  console.log('work/list 出现次数:', workUrls.length)
  for (const u of workUrls.slice(0, 5)) console.log('  …', u.replace(/\s+/g, ' ').slice(0, 200))

  const encs = [...html.matchAll(/enc[=:]["']?([a-f0-9]{8,})/gi)].map((m) => m[1])
  console.log('enc 候选:', [...new Set(encs)].slice(0, 5))

  const uts = [...html.matchAll(/[?&]ut=(\w+)/g)].map((m) => m[1])
  console.log('ut 候选:', [...new Set(uts)].slice(0, 5))
}

main()
