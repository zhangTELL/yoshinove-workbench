/** 探测 Vue 版课程页（fanyav3）及其作业接口 */
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

  // 1. 先拿新鲜 enc（302 Location）
  const mid = await fetch(
    `https://mooc1-api.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${courseId}&clazzid=${classId}&vc=1&cpi=483418708&ismooc2=1&v=2`,
    { headers: { 'User-Agent': UA, Cookie: cookie }, redirect: 'manual', signal: AbortSignal.timeout(20000) },
  )
  const loc = mid.headers.get('location') ?? ''
  const enc = loc.match(/enc=([a-f0-9]+)/)?.[1] ?? ''
  console.log('enc =', enc)

  // 2. Vue 版课程页
  const vueUrl = `https://mooc2-ans.chaoxing.com/mooc2-ans-vue/fanyav3/stu?courseId=${courseId}&clazzId=${classId}&cpi=483418708&enc=${enc}&t=${Date.now()}&v=6&ut=s`
  const res = await fetch(vueUrl, {
    headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://mooc2-ans.chaoxing.com/' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  })
  const html = await res.text()
  writeFileSync(path.resolve(__dirname, '../../.tmp-vue.html'), html)
  console.log('Vue 页:', res.status, '长度:', html.length)

  // 3. 找 JS bundle
  const scripts = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1])
  console.log('JS 文件:', scripts.slice(0, 10))

  // 4. 在页面和各 JS bundle 里找 work 相关 API
  const candidates = new Set<string>()
  const scan = (txt: string, label: string) => {
    for (const m of txt.matchAll(/["'`](\/?[\w./-]{0,60}work[\w./-]{0,60})["'`]/gi)) {
      if (/\.css|\.png|\.jpg|\.svg/i.test(m[1])) continue
      candidates.add(`${label}: ${m[1]}`)
    }
  }
  scan(html, 'page')
  for (const s of scripts) {
    const u = s.startsWith('http') ? s : `https://mooc2-ans.chaoxing.com${s}`
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(20000) })
      const js = await r.text()
      scan(js, s.split('/').pop()!.slice(0, 30))
    } catch { /* skip */ }
  }
  console.log('work 相关 API 候选:')
  for (const c of [...candidates].slice(0, 30)) console.log('  ', c)
}
main()
