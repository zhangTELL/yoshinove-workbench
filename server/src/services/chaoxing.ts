/** 学习通（超星）非官方客户端：仅做读取（课程列表/作业列表），不做任何写入操作 */
import type { Database } from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chaoxingHomework } from '../db/schema.js'
import { textKeyOf, workKeyOf } from './chaoxingKey.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

let sqliteRef: Database | null = null
export function initChaoxing(db: Database): void {
  sqliteRef = db
}

/**
 * upsert 作业：**以 work_key（学习通 workId）为身份**，返回新增条数。
 *
 * 历史 bug：曾用 `课程|标题|截止时间` 当幂等键，而截止时间是从页面「剩余 X 天 X 小时」
 * 换算出来的、会随抓取变化 —— 同一条作业「上次有截止时间、这次没有」时会插入第二条，
 * 前端就出现两条同名作业、且「打开作业」指向同一个页面。身份必须只取作业的固有属性。
 */
export function upsertWorks(works: ChaoxingWork[]): number {
  const exists = db.select().from(chaoxingHomework).all()
  const byKey = new Map<string, (typeof exists)[number]>()
  const byText = new Map<string, (typeof exists)[number]>()
  for (const h of exists) {
    if (h.workKey) byKey.set(h.workKey, h)
    // 兜底：迁移尚未跑到（或手工插入）的 work_key 为空的老行，按课程+标题匹配
    else byText.set(textKeyOf(h.courseName, h.title), h)
  }

  const now = new Date().toISOString()
  let added = 0
  for (const w of works) {
    const key = workKeyOf(w)
    const old = byKey.get(key) ?? byText.get(textKeyOf(w.courseName, w.title))
    if (old) {
      const patch: Partial<{ status: string; url: string; deadline: string; courseStart: string; workKey: string }> = {}
      if (w.status && old.status !== w.status) patch.status = w.status
      if (w.url && old.url !== w.url) patch.url = w.url
      // 截止时间是相对文本换算来的：新值为空时保留上次已知值，别把已知信息抹掉
      if (w.deadline && old.deadline !== w.deadline) patch.deadline = w.deadline
      if (w.courseStart && old.courseStart !== w.courseStart) patch.courseStart = w.courseStart
      if (!old.workKey) patch.workKey = key
      if (Object.keys(patch).length) {
        db.update(chaoxingHomework)
          .set({ ...patch, syncedAt: now })
          .where(eq(chaoxingHomework.id, old.id))
          .run()
      }
      // 同一批 works 里若有重复项（页面重复渲染），也要命中已存在的行而不是再插一条
      Object.assign(old, patch)
      byText.set(textKeyOf(old.courseName, old.title), old)
      continue
    }
    // work_key 唯一索引兜底：即使并发/异常导致重复，也只会更新而不报错
    const res = db
      .insert(chaoxingHomework)
      .values({
        courseName: w.courseName,
        title: w.title,
        deadline: w.deadline,
        url: w.url,
        status: w.status,
        courseStart: w.courseStart || null,
        workKey: key,
        syncedAt: now,
      })
      .onConflictDoNothing()
      .run()
    if (res.changes > 0) {
      added++
      byKey.set(key, {
        id: Number(res.lastInsertRowid),
        courseName: w.courseName,
        title: w.title,
        deadline: w.deadline,
        url: w.url,
        status: w.status,
        courseStart: w.courseStart || null,
        workKey: key,
        syncedAt: now,
        remindedAt: null,
      })
    }
  }
  return added
}

function getCookie(): string {
  if (!sqliteRef) return ''
  const row = sqliteRef.prepare("SELECT value FROM settings WHERE key = 'chaoxing.cookie'").get() as
    | { value: string }
    | undefined
  if (!row) return ''
  try {
    return JSON.parse(row.value) ?? ''
  } catch {
    return ''
  }
}

export interface ChaoxingStatus {
  hasCookie: boolean
  uid: string | null
}

export interface ChaoxingCourse {
  courseId: string
  classId: string
  /** personId，作业列表接口需要（URL 里的 cpi） */
  cpi: string
  name: string
  /**
   * 开课时间 YYYY-MM-DD（课程块里的「开课时间：2026-08-31～2028-08-31」）。
   * 学习通的课程列表**不带结构化的学期字段**（courseType/classState/term 参数都被忽略，
   * li 上只有 courseId/clazzId/personId），所以只能靠这个日期推断学期——实测可靠：
   * Java程序设计 2026-08-31 → 2026-2027第1学期；数据结构 2026-03-01 → 2025-2026第2学期。
   */
  startDate: string
  /** 结课时间 YYYY-MM-DD，仅记录，暂未使用 */
  endDate: string
}

export interface ChaoxingWork {
  courseName: string
  title: string
  deadline: string | null
  url: string
  status: string
  /** 所属课程的开课时间，用于「本学期」过滤 */
  courseStart: string
}

async function cxFetch(url: string, cookie: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    ...init,
    headers: {
      'User-Agent': UA,
      Cookie: cookie,
      ...(init?.headers ?? {}),
    },
  })
}

/** 校验 Cookie：只看第一跳。首页有重定向循环，绝不能跟随到底 */
export async function validateCookie(cookie: string): Promise<{ ok: boolean; uid: string | null; detail: string }> {
  if (!cookie.trim()) return { ok: false, uid: null, detail: 'Cookie 为空' }
  const uid = cookie.match(/UID=(\d+)/)?.[1] ?? null
  try {
    const res = await cxFetch('https://i.chaoxing.com/', cookie, { redirect: 'manual' })
    const loc = res.headers.get('location') ?? ''
    if (/passport\d?\.chaoxing\.com|\/login/i.test(loc)) {
      return { ok: false, uid, detail: 'Cookie 已失效（跳转到登录页），请重新复制' }
    }
    if (res.status === 200 || loc) {
      return { ok: true, uid, detail: 'Cookie 有效' }
    }
    return { ok: false, uid, detail: `异常响应 ${res.status}` }
  } catch (e) {
    return { ok: false, uid, detail: `请求失败: ${(e as Error).message}` }
  }
}

export function getStatus(): ChaoxingStatus {
  const cookie = getCookie()
  return { hasCookie: !!cookie, uid: cookie.match(/UID=(\d+)/)?.[1] ?? null }
}

/** 课程列表：courselistdata 返回 HTML，<li class="course" courseId=.. clazzId=..> 内含 course-name span */
export async function fetchCourseList(cookie: string): Promise<ChaoxingCourse[]> {
  const res = await cxFetch('https://mooc1-api.chaoxing.com/visit/courselistdata', cookie, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://i.chaoxing.com/base/courselist',
    },
    body: new URLSearchParams({ courseType: '1', classState: '2' }).toString(),
  })
  if (res.status >= 300 || res.headers.get('location')) {
    throw new Error('课程列表被重定向（Cookie 可能失效）')
  }
  const html = await res.text()
  const courses: ChaoxingCourse[] = []
  // 注意：课程 li 内部嵌套了"移动到"等子 li，不能用 </li> 界定，按下一个课程块切分
  const blocks = html.split(/(?=<li class="course)/)
  for (const block of blocks) {
    const head = block.match(/^<li class="course[^"]*"\s+courseId="(\d+)"\s+clazzId="(\d+)"\s+personId="(\d+)"/)
    if (!head) continue
    const name =
      block.match(/<span class="course-name[^"]*"[^>]*title="([^"]+)"/)?.[1] ??
      block.match(/<span class="course-name[^"]*"[^>]*>([^<]+)</)?.[1] ??
      ''
    // 课程块里的「开课时间：2026-08-31～2028-08-31」（分隔符是 ～ 或 ~ 都可能，两个都兜）
    const range = block.replace(/<[^>]+>/g, ' ').match(/(\d{4}-\d{2}-\d{2})\s*[～~]\s*(\d{4}-\d{2}-\d{2})/)
    courses.push({
      courseId: head[1],
      classId: head[2],
      cpi: head[3],
      name: name.trim() || `课程${head[1]}`,
      startDate: range?.[1] ?? '',
      endDate: range?.[2] ?? '',
    })
  }
  return courses
}

/**
 * 单门课程的作业列表（三步链路，2026-09 实测）：
 * 1. stucoursemiddle（302）→ Location 里拿本次的 enc
 * 2. 带 enc 访问课程页 → 隐藏域 #workEnc（作业列表专用 enc）
 * 3. mooc1.chaoxing.com/mooc2/work/list?courseId&classId&cpi&ut=s&enc=workEnc
 */
/**
 * 学习通作业的「原始状态文本」→ 本应用的两值状态。
 *
 * 词表是**实测**出来的（2026-09-18 遍历全部 40 门课程，原始状态只出现这 4 种）：
 *   `已完成` × 24、`待批阅` × 18、`未交` × 3、`未开始` × 1
 *
 * ⚠️ **`待批阅` = 已提交、等老师批阅，必须算「已提交」**。
 * 只认 `已完成` 时它会被归成「进行中」，症状就是**已提交的作业一直留在「未提交」栏**
 * （2026-09-18 用户反馈：Java 程序设计 `2026-2027-01(wk2)` 已提交却还在未提交栏，
 * 其原始状态正是 `待批阅`）。
 *
 * 为什么不反过来「白名单未提交词、其余算已提交」：未知状态**宁可多显示也不该漏掉待办**——
 * 误判成未提交只是多一条列表项，误判成已提交会让 DDL 提醒静默消失。
 */
const SUBMITTED_STATUS = new Set(['已完成', '待批阅'])

export async function fetchWorkList(cookie: string, course: ChaoxingCourse): Promise<ChaoxingWork[]> {
  const mid = await cxFetch(
    `https://mooc1-api.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${course.courseId}&clazzid=${course.classId}&vc=1&cpi=${course.cpi}&ismooc2=1&v=2`,
    cookie,
    { redirect: 'manual' },
  )
  const loc = mid.headers.get('location') ?? ''
  const enc = loc.match(/enc=([a-f0-9]+)/)?.[1]
  if (!enc) throw new Error('课程入口未返回 enc（Cookie 可能失效）')

  const stuUrl = loc.startsWith('http') ? loc : `https://mooc2-ans.chaoxing.com${loc}`
  const stu = await cxFetch(stuUrl, cookie, { headers: { Referer: 'https://i.chaoxing.com/' } })
  const stuHtml = await stu.text()
  const workEnc = stuHtml.match(/id="workEnc"[^>]*value="([^"]+)"/)?.[1]
  if (!workEnc) throw new Error('课程页未找到 workEnc')

  const wl = await cxFetch(
    `https://mooc1.chaoxing.com/mooc2/work/list?courseId=${course.courseId}&classId=${course.classId}&cpi=${course.cpi}&ut=s&enc=${workEnc}`,
    cookie,
    { headers: { Referer: stuUrl } },
  )
  const html = await wl.text()
  if (html.includes('无权限')) throw new Error('作业列表返回无权限')

  const works: ChaoxingWork[] = []
  // 每条作业：<li onclick="goTask(this);" data="…workId=..&enc=.." … aria-label="标题 ; 状态" …>
  const liRe = /<li onclick="goTask\(this\);"\s+data="([^"]+)"([^>]*)>([\s\S]*?)<\/li>/g
  let m: RegExpExecArray | null
  while ((m = liRe.exec(html))) {
    const [, url, attrs, inner] = m
    // 只保留真正的作业条目（互评等列表的 li 排除）
    if (!/\/work\/task\?/.test(url)) continue
    const label = attrs.match(/aria-label="([^"]*)"/)?.[1] ?? ''
    const title = label.split(';')[0]?.trim() || ''
    if (!title) continue
    const status = inner.match(/class="status fl">([^<]+)</)?.[1]?.trim() ?? '进行中'
    // 截止时间是相对文本（剩余X天X小时X分钟），换算为绝对时间
    let deadline: string | null = null
    const rel = inner.match(/剩余\s*(?:(\d+)\s*天)?\s*(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分钟)?/)
    if (rel) {
      const d = parseInt(rel[1] ?? '0', 10)
      const h = parseInt(rel[2] ?? '0', 10)
      const min = parseInt(rel[3] ?? '0', 10)
      const ms = ((d * 24 + h) * 60 + min) * 60000
      const dl = new Date(Date.now() + ms)
      const p = (n: number) => String(n).padStart(2, '0')
      deadline = `${dl.getFullYear()}-${p(dl.getMonth() + 1)}-${p(dl.getDate())} ${p(dl.getHours())}:${p(dl.getMinutes())}:00`
    }
    works.push({
      courseName: course.name,
      title,
      deadline,
      url: url.startsWith('http') ? url : `https://mooc1.chaoxing.com${url}`,
      status: SUBMITTED_STATUS.has(status) ? '已提交' : '进行中',
      courseStart: course.startDate,
    })
  }
  return works
}

export interface SyncResult {
  ok: boolean
  detail: string
  works: ChaoxingWork[]
  courseCount: number
}

/** 全量同步：课程 → 每门课的作业，汇总返回 */
export async function syncAll(): Promise<SyncResult> {
  const cookie = getCookie()
  if (!cookie) return { ok: false, detail: '未配置 Cookie', works: [], courseCount: 0 }
  const check = await validateCookie(cookie)
  if (!check.ok) return { ok: false, detail: check.detail, works: [], courseCount: 0 }
  const courses = await fetchCourseList(cookie)
  if (!courses.length) {
    return { ok: false, detail: '未解析到任何课程（页面结构可能变化，需按实际返回调整解析）', works: [], courseCount: 0 }
  }
  const works: ChaoxingWork[] = []
  const failed: string[] = []
  for (const c of courses) {
    try {
      works.push(...(await fetchWorkList(cookie, c)))
    } catch (e) {
      failed.push(`${c.name}: ${(e as Error).message}`)
    }
  }
  return {
    ok: true,
    detail: failed.length ? `同步了 ${courses.length} 门课，部分失败: ${failed.join('；')}` : `同步成功（${courses.length} 门课，${works.length} 条作业）`,
    works,
    courseCount: courses.length,
  }
}
