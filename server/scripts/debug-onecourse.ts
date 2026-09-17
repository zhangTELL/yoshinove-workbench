/** 调试：单门课程的作业抓取链路 */
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchCourseList, fetchWorkList, initChaoxing } from '../src/services/chaoxing.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.resolve(__dirname, '../data/workbench.db'))
initChaoxing(db)
const cookie = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'chaoxing.cookie'").get()!.value) as string

const courses = await fetchCourseList(cookie)
console.log('课程数:', courses.length)
const target = courses.find((c) => c.name.includes('Web应用')) ?? courses.find((c) => c.courseId === '265765875')
if (!target) {
  console.log('未找到目标课程；前5门:', courses.slice(0, 5))
  process.exit(0)
}
console.log('目标课程:', target)
try {
  const works = await fetchWorkList(cookie, target)
  console.log('作业数:', works.length)
  for (const w of works) console.log(' -', w.title, '|', w.status, '|', w.deadline)
} catch (e) {
  console.log('抓取失败:', (e as Error).message)
}
