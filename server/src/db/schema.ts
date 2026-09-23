import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const semesters = sqliteTable('semesters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  startDate: text('start_date').notNull(),
  totalWeeks: integer('total_weeks').notNull().default(20),
  sectionTimes: text('section_times').notNull(),
  isCurrent: integer('is_current').notNull().default(0),
  createdAt: text('created_at').notNull(),
})

export const courses = sqliteTable('courses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  semesterId: integer('semester_id').notNull(),
  name: text('name').notNull(),
  teacher: text('teacher').notNull().default(''),
  color: text('color').notNull().default('#409eff'),
  credit: real('credit').notNull().default(0),
  examType: text('exam_type').notNull().default(''),
  note: text('note').notNull().default(''),
})

export const courseSessions = sqliteTable('course_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  courseId: integer('course_id').notNull(),
  semesterId: integer('semester_id').notNull(),
  weekday: integer('weekday').notNull(),
  startSection: integer('start_section').notNull(),
  endSection: integer('end_section').notNull(),
  weeks: text('weeks').notNull(),
  weekParity: text('week_parity').notNull().default('all'),
  room: text('room').notNull().default(''),
  note: text('note').notNull().default(''),
})

export const scheduleSwaps = sqliteTable('schedule_swaps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  semesterId: integer('semester_id').notNull(),
  /** 被替换的日期 YYYY-MM-DD：这一天的课表来自 sourceDate */
  date: text('date').notNull(),
  /** 课表来源日期 YYYY-MM-DD */
  sourceDate: text('source_date').notNull(),
  createdAt: text('created_at').notNull(),
})

export const notificationLog = sqliteTable('notification_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channel: text('channel').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull(),
  sentAt: text('sent_at').notNull(),
})

export const chaoxingHomework = sqliteTable('chaoxing_homework', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  courseName: text('course_name').notNull(),
  title: text('title').notNull(),
  deadline: text('deadline'),
  url: text('url').notNull().default(''),
  status: text('status').notNull().default('进行中'),
  /** 所属课程的"开课时间"（YYYY-MM-DD，来自课程列表的「开课时间：…」）；用来判断是不是本学期。老数据为空 */
  courseStart: text('course_start'),
  /** 稳定标识（学习通 workId 优先，退化到 课程+标题）——见 services/chaoxingKey.ts */
  workKey: text('work_key'),
  syncedAt: text('synced_at').notNull(),
  remindedAt: text('reminded_at'),
})

export const runCheckins = sqliteTable('run_checkins', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull().unique(),
  note: text('note').notNull().default(''),
  /** 手动录入的里程（km），可为空——只打卡不记数据也合法 */
  distanceKm: real('distance_km'),
  /** 手动录入的步数 */
  steps: integer('steps'),
  createdAt: text('created_at').notNull(),
})

export const countdowns = sqliteTable('countdowns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  date: text('date').notNull(),
  category: text('category').notNull().default('其他'),
  note: text('note').notNull().default(''),
})

export const scores = sqliteTable('scores', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  semester: text('semester').notNull(),
  courseName: text('course_name').notNull(),
  credit: real('credit').notNull(),
  score: real('score').notNull(),
  gradePoint: real('grade_point').notNull(),
  examType: text('exam_type').notNull().default(''),
})

export const pomodoroSessions = sqliteTable('pomodoro_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskLabel: text('task_label').notNull().default(''),
  courseTag: text('course_tag').notNull().default(''),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at').notNull(),
  durationMin: integer('duration_min').notNull(),
})

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  courseTag: text('course_tag').notNull().default(''),
  category: text('category').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const modelProfiles = sqliteTable('model_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull().default(''),
  model: text('model').notNull(),
  enabled: integer('enabled').notNull().default(1),
  /** 平台标识，对应 services/balance.ts 的适配器 id */
  provider: text('provider').notNull().default('custom'),
  /** 认证方式：bearer | raw | volc-sign | aliyun-rpc */
  authStyle: text('auth_style').notNull().default('bearer'),
  /** AK/SK 类平台的 SecretKey */
  apiSecret: text('api_secret').notNull().default(''),
  /** 覆盖适配器默认余额端点，留空用默认 */
  balancePath: text('balance_path').notNull().default(''),
  /** 是否参与余额轮询 */
  balanceEnabled: integer('balance_enabled').notNull().default(1),
})

/** 余额快照：每次抓取一条，source 区分官方/逆向/手工 */
export const balanceSnapshots = sqliteTable('balance_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull(),
  capturedAt: text('captured_at').notNull(),
  /** official | reverse | manual */
  source: text('source').notNull().default('official'),
  /** ok | error | unsupported */
  status: text('status').notNull().default('ok'),
  currency: text('currency').notNull().default('CNY'),
  total: real('total'),
  granted: real('granted'),
  toppedUp: real('topped_up'),
  available: real('available'),
  error: text('error').notNull().default(''),
  /** 原始响应，便于排查接口变更 */
  raw: text('raw').notNull().default(''),
})

/** 套餐 / 资源包窗口：按周期重置的额度，与余额是两套数据 */
export const quotaWindows = sqliteTable('quota_windows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull(),
  snapshotId: integer('snapshot_id'),
  capturedAt: text('captured_at').notNull(),
  label: text('label').notNull(),
  /** TOKENS_LIMIT | TIME_LIMIT | COUNT | CREDIT */
  type: text('type').notNull().default('CREDIT'),
  limitValue: real('limit_value'),
  usedValue: real('used_value'),
  remaining: real('remaining'),
  percentage: real('percentage'),
  resetAt: text('reset_at'),
  raw: text('raw').notNull().default(''),
})

export const prompts = sqliteTable('prompts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  content: text('content').notNull().default(''),
  variables: text('variables').notNull().default('[]'),
  version: integer('version').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
})

export const promptCases = sqliteTable('prompt_cases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  promptId: integer('prompt_id').notNull(),
  input: text('input').notNull().default(''),
  expected: text('expected').notNull().default(''),
})

/** 本地项目（P8）：path 是唯一身份，扫描与手动添加都按它幂等写入 */
export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 绝对路径，唯一键 */
  path: text('path').notNull().unique(),
  name: text('name').notNull(),
  /** scan | manual */
  source: text('source').notNull().default('scan'),
  /** 标记打分：≥50 视为项目，15~49 为弱信号 */
  score: integer('score').notNull().default(0),
  /** JSON 数组：命中的标记（git / readme / ai / build:2 …） */
  markers: text('markers').notNull().default('[]'),
  /** JSON 数组：推断出的技术栈标签 */
  stack: text('stack').notNull().default('[]'),
  hasGit: integer('has_git').notNull().default(0),
  /** 父项目 id：父目录本身也是项目时用于折叠 */
  parentPath: text('parent_path'),
  gitBranch: text('git_branch'),
  gitLastCommit: text('git_last_commit'),
  gitLastAuthor: text('git_last_author'),
  gitLastSubject: text('git_last_subject'),
  gitRemote: text('git_remote'),
  gitDirty: integer('git_dirty'),
  readmeExcerpt: text('readme_excerpt'),
  /** 所属分类（软件内组织，与磁盘无关）；null = 未分类 */
  categoryId: integer('category_id'),
  favorite: integer('favorite').notNull().default(0),
  hidden: integer('hidden').notNull().default(0),
  /** JSON 数组：用户标签 */
  tags: text('tags').notNull().default('[]'),
  note: text('note').notNull().default(''),
  alias: text('alias'),
  lastOpenedAt: text('last_opened_at'),
  lastOpenTarget: text('last_open_target'),
  firstSeenAt: text('first_seen_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 扫描排除规则：name（目录名，大小写不敏感）| path-prefix | path-regex */
export const excludeRules = sqliteTable('exclude_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  pattern: text('pattern').notNull(),
  /** 是否内置（内置的可禁用但不删） */
  builtin: integer('builtin').notNull().default(0),
  createdAt: text('created_at').notNull(),
})

/**
 * 项目分类（用户自建，可嵌套）。
 * 与磁盘结构无关：只是软件内的组织方式，重命名/移动分类不会动任何文件。
 */
export const projectCategories = sqliteTable('project_categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** 父分类 id，null = 顶层 */
  parentId: integer('parent_id'),
  sort: integer('sort').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
