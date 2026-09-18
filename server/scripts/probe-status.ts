/**
 * 调试：dump 学习通「作业列表页」里每条作业的**原始状态文本**与倒计时是否出现。
 *
 * 背景：状态在解析层被二值化（`已完成` → 已提交，其余 → 进行中），
 * 一旦页面用别的词表达「已提交/待批阅」，就会误判成未提交。
 * （2026-09-18 用户反馈：Java 作业已提交，仍留在「未提交」栏）
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { fetchCourseList } from '../src/services/chaoxing.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.resolve(__dirname, '../data/workbench.db'), { readonly: true })
const row = db.prepare("SELECT value FROM settings WHERE key = 'chaoxing.cookie'").get() as { value: string } | undefined
db.close()
if (!row?.value) throw new Error('库里没有 chaoxing.cookie')
const cookie = JSON.parse(row.value) as string

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const only = process.argv[2]

const courses = await fetchCourseList(cookie)
console.log('课程数:', courses.length, only ? `（只打含「${only}」的）` : '')

const seen = new Map<string, number>()

for (const c of courses) {
  if (only && !c.name.includes(only)) continue
  let html = ''
  try {
    // 与 fetchWorkList 一致的两步：课程入口拿 enc → 课程页拿 workEnc → 作业列表
    const mid = await fetch(
      `https://mooc1-api.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${c.courseId}&clazzid=${c.classId}&vc=1&cpi=${c.cpi}&ismooc2=1&v=2`,
      { headers: { 'User-Agent': UA, Cookie: cookie }, redirect: 'manual', signal: AbortSignal.timeout(20000) },
    )
    const loc = mid.headers.get('location') ?? ''
    const enc = loc.match(/enc=([a-f0-9]+)/)?.[1]
    if (!enc) {
      console.log(`\n## ${c.name} —— 课程入口未返回 enc`)
      continue
    }
    const stuUrl = loc.startsWith('http') ? loc : `https://mooc2-ans.chaoxing.com${loc}`
    const stuHtml = await (
      await fetch(stuUrl, {
        headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://i.chaoxing.com/' },
        signal: AbortSignal.timeout(20000),
      })
    ).text()
    const workEnc = stuHtml.match(/id="workEnc"[^>]*value="([^"]+)"/)?.[1]
    if (!workEnc) {
      console.log(`\n## ${c.name} —— 课程页未找到 workEnc`)
      continue
    }
    html = await (
      await fetch(
        `https://mooc1.chaoxing.com/mooc2/work/list?courseId=${c.courseId}&classId=${c.classId}&cpi=${c.cpi}&ut=s&enc=${workEnc}`,
        { headers: { 'User-Agent': UA, Cookie: cookie, Referer: stuUrl }, signal: AbortSignal.timeout(20000) },
      )
    ).text()
  } catch (e) {
    console.log(`\n## ${c.name} —— 拉取失败: ${(e as Error).message}`)
    continue
  }

  const liRe = /<li onclick="goTask\(this\);"\s+data="([^"]+)"([^>]*)>([\s\S]*?)<\/li>/g
  const items: { title: string; status: string; countdown: string | null }[] = []
  let m: RegExpExecArray | null
  while ((m = liRe.exec(html))) {
    const [, url, attrs, inner] = m
    if (!/\/work\/task\?/.test(url)) continue
    const label = attrs.match(/aria-label="([^"]*)"/)?.[1] ?? ''
    const title = label.split(';')[0]?.trim() || ''
    if (!title) continue
    const status = inner.match(/class="status fl">([^<]+)</)?.[1]?.trim() ?? '(没有 status 节点)'
    const cd = inner.match(/剩余[^<]*/)?.[0]?.trim() ?? null
    items.push({ title, status, countdown: cd })
    seen.set(status, (seen.get(status) ?? 0) + 1)
  }
  if (!items.length) continue
  console.log(`\n## ${c.name}（${items.length} 条）`)
  for (const it of items) {
    console.log(`  status=${JSON.stringify(it.status)}  倒计时=${it.countdown ? JSON.stringify(it.countdown) : 'null'}  ${JSON.stringify(it.title)}`)
  }
}

console.log('\n===== 出现过的原始状态文本（全库课程合计）=====')
for (const [k, v] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${JSON.stringify(k)} × ${v}`)
