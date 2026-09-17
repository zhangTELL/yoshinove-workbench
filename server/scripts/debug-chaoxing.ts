/** 学习通接口调试：dump 课程列表与作业列表原始返回 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.resolve(__dirname, '../data/workbench.db'))
const cookie = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'chaoxing.cookie'").get()!.value) as string

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function main() {
  // 1. 课程列表
  const res = await fetch('https://mooc1-api.chaoxing.com/visit/courselistdata', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://i.chaoxing.com/base/courselist',
    },
    body: new URLSearchParams({ courseType: '1', classState: '2' }).toString(),
  })
  const html = await res.text()
  console.log('=== courselist 状态:', res.status, '长度:', html.length)
  writeFileSync(path.resolve(__dirname, '../../.tmp-courselist.html'), html)
  console.log('前 1500 字符:\n', html.slice(0, 1500))

  // 提取 courseid/clid 出现情况
  const ids = [...html.matchAll(/courseid=(\d+)[^"']{0,80}?cl[ia]ss?i?d=(\d+)/gi)]
  console.log('解析到 courseid/clid 组合:', ids.length, ids.slice(0, 5).map((m) => `${m[1]}-${m[2]}`))
}

main()
