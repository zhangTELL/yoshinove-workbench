/** 下载 fanyav3 JS 包并 grep work 接口；同时探测 Vue 作业页路径 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.resolve(__dirname, '../data/workbench.db'))
const cookie = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'chaoxing.cookie'").get()!.value) as string

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const outDir = path.resolve(__dirname, '../../.tmp-js')
mkdirSync(outDir, { recursive: true })

async function main() {
  const courseId = process.argv[2] ?? '266941449'
  const classId = process.argv[3] ?? '154281416'

  const mid = await fetch(
    `https://mooc1-api.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${courseId}&clazzid=${classId}&vc=1&cpi=483418708&ismooc2=1&v=2`,
    { headers: { 'User-Agent': UA, Cookie: cookie }, redirect: 'manual', signal: AbortSignal.timeout(20000) },
  )
  const enc = (mid.headers.get('location') ?? '').match(/enc=([a-f0-9]+)/)?.[1] ?? ''
  console.log('enc =', enc)

  // Vue 作业页路径探测
  const tries = [
    `https://mooc2-ans.chaoxing.com/mooc2-ans-vue/fanyav3/work?courseId=${courseId}&clazzId=${classId}&cpi=483418708&enc=${enc}&ut=s`,
    `https://mooc2-ans.chaoxing.com/mooc2-ans-vue/work?courseId=${courseId}&clazzId=${classId}&enc=${enc}&ut=s`,
    `https://mooc1.chaoxing.com/mooc2/work/list?courseId=${courseId}&classId=${classId}&ut=s&enc=${enc}&mooc=false&pageHeader=8&workRelationId=37157`,
  ]
  for (const [i, u] of tries.entries()) {
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://mooc2-ans.chaoxing.com/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    const t = await r.text()
    writeFileSync(path.resolve(outDir, `try${i}.html`), t)
    console.log(`try${i}: ${r.status} len=${t.length} final=${r.url.slice(0, 80)} 无权限=${t.includes('无权限')}`)
  }

  // 下载 JS 包 grep
  const bundles = ['chunk-vendors.e92bd546.js', 'chunk-common.a1eeafc2.js', 'fanyav3.45e16b5a.js']
  for (const b of bundles) {
    const r = await fetch(`https://mooc2-ans.chaoxing.com/mooc2-ans-vue/js/${b}`, {
      headers: { 'User-Agent': UA, Cookie: cookie },
      signal: AbortSignal.timeout(60000),
    })
    const js = await r.text()
    writeFileSync(path.resolve(outDir, b), js)
    const hits = [...js.matchAll(/["'`](\/?[\w-./]{0,50}(?:work|Work)[\w-./]{0,50})["'`]/g)].map((m) => m[1])
    const uniq = [...new Set(hits)].filter((h) => !/\.(png|jpg|css|svg|gif|woff)/i.test(h))
    console.log(`${b} (${Math.round(js.length / 1024)}KB):`, uniq.slice(0, 25))
  }
}
main()
