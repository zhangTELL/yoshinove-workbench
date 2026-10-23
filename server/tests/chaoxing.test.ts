import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import Fastify from 'fastify'

const temporary = mkdtempSync(join(tmpdir(), 'yw-chaoxing-test-'))
process.env.WORKBENCH_DATA_DIR = temporary
const { sqlite, ensureSchema } = await import('../src/db/index.js')
ensureSchema()
const { initChaoxing, parseWorkList, parseWorkSnapshot, syncAll, upsertWorks } = await import('../src/services/chaoxing.js')
initChaoxing(sqlite)
const { chaoxingRoutes } = await import('../src/routes/chaoxing.js')
after(() => { sqlite.close(); rmSync(temporary, { recursive: true, force: true }) })
beforeEach(() => { sqlite.exec("DELETE FROM chaoxing_homework; DELETE FROM settings WHERE key = 'chaoxing.cookie'") })
const scope = { courseId: '101', classId: '201' }
function work(id: string, extra = {}) {
  return { courseName: 'Web应用与开发', title: '第14、15章作业', deadline: null, status: '进行中', courseStart: '2026-08-19', url: `https://mooc1.chaoxing.com/mooc2/work/task?courseId=101&classId=201&workId=${id}`, ...extra }
}
async function list(includeArchived = false) {
  const app = Fastify()
  await app.register(chaoxingRoutes)
  try { return (await app.inject('/api/chaoxing/homework' + (includeArchived ? '?includeArchived=1' : ''))).json() }
  finally { await app.close() }
}

test('完整课程快照缺少旧作业时，当前列表只显示新版，旧记录仍保留', async () => {
  upsertWorks([work('11')])
  upsertWorks([work('12', { title: '第14，15章课后作业', deadline: '2026-10-25 23:58:00' })], [scope])
  const visible = await list()
  assert.equal(visible.length, 1, '已经不在学习通列表的旧版不能继续作为待办返回')
  assert.equal(visible[0].title, '第14，15章课后作业')
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM chaoxing_homework').get() as { n: number }).n, 2)
  ensureSchema()
  assert.equal((await list()).length, 1, '重启时的表迁移不能让已移除记录重新出现在待办中')
})

test('抓取失败或未抓取的课程保持原样，不会按空列表归档，本地手动记录也保留', async () => {
  upsertWorks([work('11'), work('21', { url: 'https://mooc1.chaoxing.com/mooc2/work/task?courseId=102&classId=202&workId=21' }), work('local', { title: '本地补充作业', url: '' })])
  upsertWorks([], [])
  assert.equal((await list()).length, 3)
  upsertWorks([], [scope])
  assert.deepEqual((await list()).map((row: { title: string }) => row.title).sort(), ['本地补充作业', '第14、15章作业'].sort())
  assert.equal((await list(true)).length, 3)
})

test('已移除作业再次出现在学习通时恢复原记录，保留提醒标记', async () => {
  upsertWorks([work('11')])
  const id = (await list())[0].id
  sqlite.prepare("UPDATE chaoxing_homework SET reminded_at = '2026-10-01T00:00:00Z' WHERE id = ?").run(id)
  upsertWorks([], [scope])
  assert.equal((await list()).length, 0)
  assert.equal((await list(true))[0].remotePresent, false)
  upsertWorks([work('11', { status: '已提交' })], [scope])
  const restored = (await list())[0]
  assert.equal(restored.id, id)
  assert.equal(restored.remindedAt, '2026-10-01T00:00:00Z')
  assert.equal(restored.status, '已提交')
  assert.equal((await list(true)).length, 1)
})

test('重复同步、截止时间变化和标题更名只更新同一编号，不重新插入', async () => {
  assert.equal(upsertWorks([work('11', { deadline: '2026-10-25 23:58:00' })]), 1)
  const id = (await list())[0].id
  const latest = work('11', { title: '第14，15章课后作业', status: '已提交' })
  assert.equal(upsertWorks([latest, latest], [scope]), 0)
  assert.equal(upsertWorks([latest], [scope]), 0)
  const rows = await list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, id)
  assert.equal(rows[0].title, latest.title)
  assert.equal(rows[0].deadline, '2026-10-25 23:58:00')
})

test('远程编号不同的同名作业不被文本兜底误合并，同名班级在接口中可区分', async () => {
  upsertWorks([work('11')])
  upsertWorks([work('11'), work('12')], [scope])
  assert.equal((await list()).length, 2, '两份真实编号不同的作业不能按标题合并')
  const other = work('21', { url: 'https://mooc1.chaoxing.com/mooc2/work/task?courseId=102&classId=202&workId=21', courseStart: '2026-09-15' })
  upsertWorks([work('11'), work('12'), other], [scope, { courseId: '102', classId: '202' }])
  const rows = await list()
  assert.equal(rows.length, 3)
  assert.equal(new Set(rows.map((row: { courseKey: string }) => row.courseKey)).size, 2)
  assert.equal(rows.find((row: { courseKey: string }) => row.courseKey === '102:202').classLabel, '2026-09-15开课 · 班级 202')
})

test('旧文本身份只升级一次；同批后续编号不能借用已升级的文本兜底', async () => {
  upsertWorks([work('local', { url: '' })])
  const id = (await list())[0].id
  upsertWorks([work('11'), work('12')], [scope])
  const rows = await list()
  assert.equal(rows.length, 2)
  assert.ok(rows.some((row: { id: number; workKey: string }) => row.id === id && row.workKey === 'cx:101:11'))
})

const course = { ...scope, cpi: 'test-person', name: '测试课程', startDate: '2026-08-19', endDate: '' }
const page = (body: string) => `<div class="main task-list">${body}</div>`
const item = (id: string, title = '第14、15章作业', status = '未交') => `<li aria-label="${title};${status}" data="/mooc2/work/task?courseId=101&amp;classId=201&amp;workId=${id}" onclick="goTask(this);"><span class="status fl">${status}</span></li>`

test('作业页仅在完整解析或明确暂无作业时接受，未知页面与部分解析不能当成空快照', () => {
  const parsed = parseWorkList(page(item('11')), course)
  assert.equal(parsed.length, 1)
  assert.match(parsed[0].url, /&workId=11/)
  assert.equal(parsed[0].status, '进行中')
  assert.equal(parseWorkList(page(item('11', '作业', '待批阅')), course)[0].status, '已提交')
  assert.deepEqual(parseWorkList(page('<div class="null-data">暂无作业</div>'), course), [])
  assert.throws(() => parseWorkList('<html>账号登录</html>', course), /登录/)
  assert.throws(() => parseWorkList(page('<div>未知结构</div>'), course), /未识别/)
  assert.throws(() => parseWorkList(page(item('11') + item('12', '')), course), /标题/)
})

test('作业转入互评入口仍算在当前列表中，不新增互评任务，也不误归档原作业', async () => {
  upsertWorks([work('11', { status: '已提交' })])
  const snapshot = parseWorkSnapshot(page(item('11').replace('/work/task?', '/work/eval-list?')), course)
  assert.equal(snapshot.works.length, 0)
  assert.deepEqual(snapshot.listedWorkKeys, ['cx:101:11'])
  upsertWorks(snapshot.works, [{ ...scope, listedWorkKeys: snapshot.listedWorkKeys }])
  assert.equal((await list()).length, 1)
  assert.equal((await list())[0].status, '已提交')
})

test('同步只将成功课程标记为完整快照，并发同步复用同一请求，失败课程数据不受影响', async t => {
  upsertWorks([work('11'), work('21', { url: 'https://mooc1.chaoxing.com/mooc2/work/task?courseId=102&classId=202&workId=21' })])
  sqlite.prepare("INSERT INTO settings(key,value) VALUES('chaoxing.cookie',?)").run(JSON.stringify('test-only-not-a-real-cookie'))
  const nativeFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = nativeFetch })
  let courseRequests = 0
  globalThis.fetch = async url => {
    const target = new URL(String(url))
    if (target.hostname === 'i.chaoxing.com') return new Response('已登录')
    if (target.pathname === '/visit/courselistdata') {
      courseRequests++
      return new Response([scope, { courseId: '102', classId: '202' }].map(c => `<li class="course" courseId="${c.courseId}" clazzId="${c.classId}" personId="123"><span class="course-name" title="测试课程"></span>2026-08-19～2028-08-19</li>`).join(''))
    }
    if (target.pathname.endsWith('/stucoursemiddle')) return new Response('', { status: 302, headers: { location: 'https://mooc2-ans.chaoxing.com/course?enc=abc' } })
    if (target.pathname === '/course') return new Response('<input id="workEnc" value="abc">')
    if (target.pathname.endsWith('/work/list')) return target.searchParams.get('courseId') === '101' ? new Response(page('<div class="null-data">暂无作业</div>')) : new Response('上游故障', { status: 503 })
    throw new Error('出现意料外的网络请求')
  }
  const first = syncAll()
  assert.equal(syncAll(), first)
  const result = await first
  assert.equal(courseRequests, 1)
  assert.deepEqual(result.completedCourses, [{ ...scope, listedWorkKeys: [] }])
  assert.equal(result.ok, true)
  upsertWorks(result.works, result.completedCourses)
  const rows = await list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].courseKey, '102:202')
})
