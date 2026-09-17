/** 验证 mooc2-ans 域 Cookie 是否缺失 */
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.resolve(__dirname, '../data/workbench.db'))
const cookie = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'chaoxing.cookie'").get()!.value) as string

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const cookieKeys = cookie.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean)
console.log('Cookie 字段列表:', cookieKeys.join(', '))
console.log('是否包含 mooc2-ans 常用字段:')
for (const k of ['fid-1747', 'spaceFid', 'qzuid', 'doyen', 'sourceIsWatermelon', 'cpi']) {
  console.log('  ', k, cookieKeys.includes(k) ? '✓' : '✗')
}

// 直接访问课程页，确认是否被踢到登录
const courseId = process.argv[2] ?? '266941449'
const classId = process.argv[3] ?? '154281416'
const res = await fetch(
  `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=${courseId}&clazzid=${classId}&cpi=483418708&pageHeader=-1&v=2`,
  { headers: { 'User-Agent': UA, Cookie: cookie }, redirect: 'manual', signal: AbortSignal.timeout(20000) },
)
console.log('mooc2-ans 课程页状态:', res.status, 'location:', (res.headers.get('location') ?? '').slice(0, 120))
