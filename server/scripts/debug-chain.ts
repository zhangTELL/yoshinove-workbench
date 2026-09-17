/** 调试：逐步打印作业链路中间值 */
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.resolve(__dirname, '../data/workbench.db'))
const cookie = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'chaoxing.cookie'").get()!.value) as string
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const courseId = process.argv[2] ?? '265765875'
const classId = process.argv[3] ?? '151141992'
const cpi = process.argv[4] ?? '483418708'

const mid = await fetch(
  `https://mooc1-api.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${courseId}&clazzid=${classId}&vc=1&cpi=${cpi}&ismooc2=1&v=2`,
  { headers: { 'User-Agent': UA, Cookie: cookie }, redirect: 'manual', signal: AbortSignal.timeout(20000) },
)
const loc = mid.headers.get('location') ?? ''
const enc = loc.match(/enc=([a-f0-9]+)/)?.[1]
console.log('1. 中间页:', mid.status, '| enc:', enc)

const stuUrl = loc.startsWith('http') ? loc : `https://mooc2-ans.chaoxing.com${loc}`
const stu = await fetch(stuUrl, {
  headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://i.chaoxing.com/' },
  redirect: 'follow',
  signal: AbortSignal.timeout(20000),
})
const stuHtml = await stu.text()
console.log('2. 课程页:', stu.status, '长度', stuHtml.length, '| 最终URL:', stu.url.slice(0, 90))
const workEnc = stuHtml.match(/id="workEnc"[^>]*value="([^"]+)"/)?.[1]
console.log('   workEnc:', workEnc ?? '未找到')
if (!workEnc) {
  const m = stuHtml.match(/无权限|无效的参数|登录/)
  console.log('   页面特征:', m?.[0] ?? '无')
  process.exit(0)
}

const wl = await fetch(
  `https://mooc1.chaoxing.com/mooc2/work/list?courseId=${courseId}&classId=${classId}&cpi=${cpi}&ut=s&enc=${workEnc}`,
  { headers: { 'User-Agent': UA, Cookie: cookie, Referer: stuUrl }, redirect: 'follow', signal: AbortSignal.timeout(20000) },
)
const wlHtml = await wl.text()
console.log('3. 作业列表:', wl.status, '长度', wlHtml.length, '| 无权限:', wlHtml.includes('无权限'), '| li数:', (wlHtml.match(/goTask/g) ?? []).length)
