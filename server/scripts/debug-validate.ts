/** 调试 validateCookie 的实际跳转 */
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.resolve(__dirname, '../data/workbench.db'))
const cookie = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'chaoxing.cookie'").get()!.value) as string

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const res = await fetch('https://i.chaoxing.com/', {
  headers: { 'User-Agent': UA, Cookie: cookie },
  redirect: 'follow',
})
console.log('status:', res.status)
console.log('final url:', res.url)
const html = await res.text()
console.log('前 5k 含登录字样:', /用户登录|请登录/.test(html.slice(0, 5000)))
console.log('标题:', html.match(/<title>([^<]*)<\/title>/)?.[1])
