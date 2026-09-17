import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { db, sqlite } from '../db/index.js'
import { notes } from '../db/schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const THEMES_DIR = path.resolve(__dirname, '../../data/themes')
/** Typora 主题目录（Windows 默认位置） */
const TYPORA_THEMES_DIR = 'C:\\Users\\zhang\\AppData\\Roaming\\Typora\\themes'

function touchFts(id: number, title: string, content: string) {
  // FTS 表内容仅用于潜在的英文前缀搜索，中文以 LIKE 兜底
  sqlite.prepare('INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES (?,?,?,?)').run('delete', id, title, content)
}

export const noteRoutes: FastifyPluginAsync = async (app) => {
  // 列表（支持关键词/标签/分类过滤），返回元信息
  app.get('/api/notes', async (req) => {
    const { query, tag, category } = req.query as { query?: string; tag?: string; category?: string }
    let rows = db.select().from(notes).orderBy(desc(notes.updatedAt)).all()
    if (query?.trim()) {
      const q = `%${query.trim()}%`
      rows = rows.filter((r) => r.title.includes(query.trim()) || r.content.includes(query.trim()))
      void q
    }
    if (tag) rows = rows.filter((r) => r.courseTag === tag)
    if (category) rows = rows.filter((r) => r.category === category)
    return rows.map(({ content, ...meta }) => ({ ...meta, excerpt: content.replace(/[#*`>\-\[\]()!]/g, '').slice(0, 80) }))
  })

  // 标签/分类清单（侧边栏筛选用）
  app.get('/api/notes/meta', async () => {
    const rows = db.select().from(notes).all()
    return {
      tags: [...new Set(rows.map((r) => r.courseTag).filter(Boolean))].sort(),
      categories: [...new Set(rows.map((r) => r.category).filter(Boolean))].sort(),
    }
  })

  app.get('/api/notes/:id', async (req) => {
    const { id } = req.params as { id: string }
    const row = db.select().from(notes).where(eq(notes.id, Number(id))).get()
    return row ?? null
  })

  app.post('/api/notes', async (req) => {
    const b = req.body as { title?: string; content?: string; courseTag?: string; category?: string }
    const now = new Date().toISOString()
    const r = db
      .insert(notes)
      .values({
        title: (b.title ?? '').trim() || '未命名笔记',
        content: b.content ?? '',
        courseTag: b.courseTag ?? '',
        category: b.category ?? '',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return { id: r.lastInsertRowid }
  })

  app.put('/api/notes/:id', async (req) => {
    const { id } = req.params as { id: string }
    const b = req.body as { title?: string; content?: string; courseTag?: string; category?: string }
    const old = db.select().from(notes).where(eq(notes.id, Number(id))).get()
    if (!old) throw Object.assign(new Error('笔记不存在'), { statusCode: 404 })
    db.update(notes)
      .set({
        title: b.title !== undefined ? b.title.trim() || '未命名笔记' : old.title,
        content: b.content !== undefined ? b.content : old.content,
        courseTag: b.courseTag !== undefined ? b.courseTag : old.courseTag,
        category: b.category !== undefined ? b.category : old.category,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(notes.id, Number(id)))
      .run()
    void touchFts
    return { ok: true }
  })

  app.delete('/api/notes/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(notes).where(eq(notes.id, Number(id))).run()
    return { ok: true }
  })

  // ===== Markdown 主题（从 Typora 导入）=====
  // 已导入的主题（data/themes 下的 .css 文件）
  app.get('/api/notes/themes', async () => {
    mkdirSync(THEMES_DIR, { recursive: true })
    const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith('.css'))
    return { themes: files.map((f) => ({ name: f.replace(/\.css$/, ''), file: f })) }
  })

  // 从 Typora 目录导入全部主题（css + 同名/引用的资源目录）
  app.post('/api/notes/themes/import', async (req) => {
    const { source } = (req.body ?? {}) as { source?: string }
    const src = source && existsSync(source) ? source : TYPORA_THEMES_DIR
    if (!existsSync(src)) {
      throw Object.assign(new Error(`未找到 Typora 主题目录：${src}`), { statusCode: 404 })
    }
    mkdirSync(THEMES_DIR, { recursive: true })
    let copied = 0
    for (const entry of readdirSync(src)) {
      const full = path.join(src, entry)
      const st = statSync(full)
      // 跳过 old-themes 备份目录
      if (entry === 'old-themes') continue
      if (st.isFile() && entry.endsWith('.css')) {
        cpSync(full, path.join(THEMES_DIR, entry))
        copied++
      } else if (st.isDirectory()) {
        // 资源目录（字体/图片），整体复制
        cpSync(full, path.join(THEMES_DIR, entry), { recursive: true })
        copied++
      }
    }
    return { ok: true, detail: `已导入 ${copied} 个主题文件/资源目录`, themes: readdirSync(THEMES_DIR).filter((f) => f.endsWith('.css')) }
  })

  // 主题 CSS（预览 iframe / 导出用）
  app.get('/themes/:file', async (req, reply) => {
    const { file } = req.params as { file: string }
    if (!/^[\w.-]+\.css$/.test(file)) throw Object.assign(new Error('非法路径'), { statusCode: 400 })
    const full = path.join(THEMES_DIR, file)
    if (!existsSync(full)) throw Object.assign(new Error('主题不存在'), { statusCode: 404 })
    reply.type('text/css').send(readFileSync(full))
  })
}
