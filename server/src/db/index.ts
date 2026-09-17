import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { textKeyOf, workKeyOf } from '../services/chaoxingKey.js'
import * as schema from './schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(__dirname, '../../data')
mkdirSync(dataDir, { recursive: true })

export const sqlite = new Database(path.join(dataDir, 'workbench.db'))
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

/** 单机单用户应用：启动时直接确保全部表存在，避免引入迁移工具复杂度 */
export function ensureSchema() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS semesters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      total_weeks INTEGER NOT NULL DEFAULT 20,
      section_times TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      teacher TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#409eff',
      credit REAL NOT NULL DEFAULT 0,
      exam_type TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS course_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL,
      start_section INTEGER NOT NULL,
      end_section INTEGER NOT NULL,
      weeks TEXT NOT NULL,
      week_parity TEXT NOT NULL DEFAULT 'all',
      room TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_semester ON course_sessions(semester_id);

    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_notif_status ON notification_log(channel, status);

    -- 作业身份 = work_key（学习通 workId），**不含 deadline/status**：
    -- 这两列是每次抓取都会变的值，曾用它们当唯一键 → 截止时间一变就插重复行
    CREATE TABLE IF NOT EXISTS chaoxing_homework (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_name TEXT NOT NULL,
      title TEXT NOT NULL,
      deadline TEXT,
      url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '进行中',
      course_start TEXT,
      work_key TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      reminded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS run_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS countdowns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '其他',
      note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      semester TEXT NOT NULL,
      course_name TEXT NOT NULL,
      credit REAL NOT NULL,
      score REAL NOT NULL,
      grade_point REAL NOT NULL,
      exam_type TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_label TEXT NOT NULL DEFAULT '',
      course_tag TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_min INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      course_tag TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title, content, content='notes', content_rowid='id',
      tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;

    CREATE TABLE IF NOT EXISTS model_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      variables TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS prompt_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      input TEXT NOT NULL DEFAULT '',
      expected TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      captured_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      source TEXT NOT NULL DEFAULT 'official',
      status TEXT NOT NULL DEFAULT 'ok',
      currency TEXT NOT NULL DEFAULT 'CNY',
      total REAL,
      granted REAL,
      topped_up REAL,
      available REAL,
      error TEXT NOT NULL DEFAULT '',
      raw TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_balance_profile ON balance_snapshots(profile_id, captured_at);

    CREATE TABLE IF NOT EXISTS quota_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      snapshot_id INTEGER,
      captured_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      label TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'CREDIT',
      limit_value REAL,
      used_value REAL,
      remaining REAL,
      percentage REAL,
      reset_at TEXT,
      raw TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_quota_profile ON quota_windows(profile_id, captured_at);

    -- P8 项目管理：本地项目清单。path 唯一，扫描与手动添加都按它幂等写入
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'scan',
      score INTEGER NOT NULL DEFAULT 0,
      markers TEXT NOT NULL DEFAULT '[]',
      stack TEXT NOT NULL DEFAULT '[]',
      has_git INTEGER NOT NULL DEFAULT 0,
      parent_path TEXT,
      git_branch TEXT,
      git_last_commit TEXT,
      git_last_author TEXT,
      git_last_subject TEXT,
      git_remote TEXT,
      git_dirty INTEGER,
      readme_excerpt TEXT,
      category_id INTEGER,
      favorite INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '',
      alias TEXT,
      last_opened_at TEXT,
      last_open_target TEXT,
      first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_score ON projects(score);
    CREATE INDEX IF NOT EXISTS idx_projects_git ON projects(git_last_commit);

    CREATE TABLE IF NOT EXISTS exclude_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      pattern TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- P8：项目分类（用户自建、可嵌套；与磁盘结构无关）
    CREATE TABLE IF NOT EXISTS project_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  /** 轻量迁移：老库补列（SQLite 没有 ADD COLUMN IF NOT EXISTS） */
  const addColumn = (table: string, column: string, ddl: string): void => {
    const exists = sqlite.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = '${column}'`).get()
    if (!exists) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }

  const hasColumn = sqlite.prepare("SELECT 1 FROM pragma_table_info('notification_log') WHERE name = 'dedupe_key'").get()
  if (!hasColumn) {
    sqlite.exec(`ALTER TABLE notification_log ADD COLUMN dedupe_key TEXT`)
    sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notification_log(dedupe_key) WHERE dedupe_key IS NOT NULL`)
  }

  // 学习通作业补 course_start：用来区分「本学期」与往期课程。老行为 NULL，下次同步会回填（见 upsertWorks）
  addColumn('chaoxing_homework', 'course_start', 'TEXT')

  // 学习通作业补 work_key（稳定身份）并清理历史重复行。必须在任何同步之前跑完
  addColumn('chaoxing_homework', 'work_key', 'TEXT')
  migrateChaoxingWorkKeys()

  // P8：项目归属分类（老行为 NULL = 未分类）
  addColumn('projects', 'category_id', 'INTEGER')

  // 健康跑补里程/步数：手动录入，老行为 NULL（只打卡不记数据也合法）
  addColumn('run_checkins', 'distance_km', 'REAL')
  addColumn('run_checkins', 'steps', 'INTEGER')

  // P6：model_profiles 扩展为「模型配置 + 余额监控配置」共用
  addColumn('model_profiles', 'provider', "TEXT NOT NULL DEFAULT 'custom'")
  addColumn('model_profiles', 'auth_style', "TEXT NOT NULL DEFAULT 'bearer'")
  addColumn('model_profiles', 'api_secret', "TEXT NOT NULL DEFAULT ''")
  addColumn('model_profiles', 'balance_path', "TEXT NOT NULL DEFAULT ''")
  addColumn('model_profiles', 'balance_enabled', 'INTEGER NOT NULL DEFAULT 1')
}

/** 一行作业的原始列（迁移用，避免依赖 drizzle 类型） */
interface HomeworkRow {
  id: number
  course_name: string
  title: string
  deadline: string | null
  url: string
  status: string
  course_start: string | null
  work_key: string | null
  synced_at: string
  reminded_at: string | null
}

/**
 * 学习通作业的身份迁移：
 *  ① 老库去掉 UNIQUE(course_name, title, deadline) —— 把每次抓取都会变的值当唯一键，是重复行的根源；
 *  ② 回填 work_key（学习通 workId 优先）；
 *  ③ 同 work_key 的重复行合并成一行（保留最新那条的状态/网址，补齐缺失的截止时间与开课时间）；
 *  ④ 建唯一索引，之后任何环境都不可能再写入重复作业。
 * 幂等：重复执行不会产生变化。
 */
function migrateChaoxingWorkKeys(): void {
  const tableSql = (
    sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='chaoxing_homework'`).get() as
      | { sql: string }
      | undefined
  )?.sql
  if (!tableSql) return

  // ① 老库的表定义里带 UNIQUE(course_name, title, deadline)：重建表去掉它
  if (/unique\s*\(\s*course_name/i.test(tableSql)) {
    sqlite.exec(`
      CREATE TABLE chaoxing_homework_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_name TEXT NOT NULL,
        title TEXT NOT NULL,
        deadline TEXT,
        url TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '进行中',
        course_start TEXT,
        work_key TEXT,
        synced_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        reminded_at TEXT
      );
      INSERT INTO chaoxing_homework_new
        (id, course_name, title, deadline, url, status, course_start, work_key, synced_at, reminded_at)
        SELECT id, course_name, title, deadline, url, status, course_start, work_key, synced_at, reminded_at
        FROM chaoxing_homework;
      DROP TABLE chaoxing_homework;
      ALTER TABLE chaoxing_homework_new RENAME TO chaoxing_homework;
    `)
  }

  // ② 回填 work_key + ③ 合并重复行
  const rows = sqlite.prepare(`SELECT * FROM chaoxing_homework`).all() as HomeworkRow[]
  const groups = new Map<string, HomeworkRow[]>()
  for (const r of rows) {
    const key = r.work_key || workKeyOf({ url: r.url, courseName: r.course_name, title: r.title })
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }

  const upd = sqlite.prepare(
    `UPDATE chaoxing_homework SET work_key = ?, deadline = ?, course_start = ?, status = ?, url = ?, reminded_at = ? WHERE id = ?`,
  )
  const del = sqlite.prepare(`DELETE FROM chaoxing_homework WHERE id = ?`)
  let merged = 0
  for (const [key, list] of groups) {
    // 存活行 = 同步时间最新的一条（状态/网址以它为准），缺的字段从同组其它行补
    const sorted = [...list].sort((a, b) => (b.synced_at || '').localeCompare(a.synced_at || '') || b.id - a.id)
    const keep = sorted[0]
    const deadline = keep.deadline ?? sorted.find((r) => r.deadline)?.deadline ?? null
    const courseStart = keep.course_start ?? sorted.find((r) => r.course_start)?.course_start ?? null
    // 已提醒过就别丢（否则去重后会重复推送一次提醒）
    const remindedAt = sorted.map((r) => r.reminded_at).filter((v): v is string => !!v).sort().pop() ?? null
    const url = keep.url || sorted.find((r) => r.url)?.url || ''
    const changed =
      keep.work_key !== key ||
      keep.deadline !== deadline ||
      keep.course_start !== courseStart ||
      keep.reminded_at !== remindedAt ||
      keep.url !== url
    if (changed) upd.run(key, deadline, courseStart, keep.status, url, remindedAt, keep.id)
    for (const r of sorted.slice(1)) {
      del.run(r.id)
      merged++
    }
  }

  // ④ 唯一索引：数据库层面兜底，任何代码路径都写不进重复作业
  sqlite.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_chaoxing_work_key ON chaoxing_homework(work_key) WHERE work_key IS NOT NULL`,
  )
  if (merged) console.log(`[db] 学习通作业去重：合并删除 ${merged} 条重复行`)
}

/** 供同步逻辑复用：课程+标题的退化标识 */
export { textKeyOf }

export const db = drizzle(sqlite, { schema })
