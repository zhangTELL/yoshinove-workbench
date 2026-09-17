/** 用 enc 参数探测作业列表 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.resolve(__dirname, '../data/workbench.db'))
const cookie = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'chaoxing.cookie'").get()!.value) as string

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function dump(name: string, url: string) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  })
  const html = await res.text()
  writeFileSync(path.resolve(__dirname, `../../.tmp-${name}.html`), html)
  const hasNoAuth = html.includes('无权限')
  const hasLogin = /passport\d?\.chaoxing\.com/.test(res.url)
  console.log(`[${name}] ${res.status} len=${html.length} noAuth=${hasNoAuth} toLogin=${hasLogin}`)
  console.log(`   预览:`, html.replace(/\s+/g, ' ').slice(0, 260))
  console.log()
}

async function main() {
  const courseId = process.argv[2] ?? '266941449'
  const classId = process.argv[3] ?? '154281416'

  // 1. 取 enc（课程中间页的重定向 URL 里带）
  const mid = await fetch(
    `https://mooc1-api.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${courseId}&clazzid=${classId}&vc=1&cpi=483418708&ismooc2=1&v=2`,
    { headers: { 'User-Agent': UA, Cookie: cookie }, redirect: 'manual', signal: AbortSignal.timeout(20000) },
  )
  const loc = mid.headers.get('location') ?? ''
  const enc = loc.match(/enc=([a-f0-9]+)/)?.[1] ?? ''
  console.log('enc =', enc, '| 中间页状态:', mid.status)

  // 2. 作业列表候选（带 enc）
  await dump('e1-api-ut-s', `https://mooc1-api.chaoxing.com/mooc2/work/list?courseId=${courseId}&classId=${classId}&ut=s&enc=${enc}&mooc=false&pageHeader=0`)
  await dump('e2-api-default', `https://mooc1-api.chaoxing.com/mooc2/work/list?courseId=${courseId}&classId=${classId}&ut=default&enc=${enc}&mooc=false`)
  await dump('e3-mooc1host', `https://mooc1.chaoxing.com/mooc2/work/list?courseId=${courseId}&classId=${classId}&ut=s&enc=${enc}&mooc=false`)
}

main()
