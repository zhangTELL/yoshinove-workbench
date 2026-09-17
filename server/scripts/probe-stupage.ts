/** 进入课程页，找作业列表真实 URL（含 enc/ut） */
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
  const res = await fetch(
    `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=${courseId}&clazzid=${classId}&cpi=483418708&pageHeader=-1&v=2`,
    { headers: { 'User-Agent': UA, Cookie: cookie }, redirect: 'follow', signal: AbortSignal.timeout(20000) },
  )
  const html = await res.text()
  writeFileSync(path.resolve(__dirname, '../../.tmp-stu.html'), html)
  console.log('状态:', res.status, '长度:', html.length, '最终URL:', res.url.slice(0, 90))

  const workUrls = [...html.matchAll(/[^"']{0,140}work[^"']{0,180}/g)].map((m) => m[0].replace(/\s+/g, ' '))
  console.log('work 相关字符串:', workUrls.length)
  for (const u of [...new Set(workUrls)].slice(0, 12)) console.log('  ', u.slice(0, 220))
}
main()
