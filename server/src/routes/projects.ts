/**
 * P8 项目管理：扫描、列表、手动添加、元数据、一键打开
 *
 * 安全边界（见设计方案 §八）：
 *  - 「打开」只允许固定的 5 种目标，用 execFile + 参数数组（不经 shell），项目路径作为参数传递；
 *  - 本期不做文件删除/重命名；P8-1 也不做文件读写（P8-2 再引入，并带路径校验与 .bak）。
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { db, sqlite } from '../db/index.js'
import { excludeRules, projectCategories, projects } from '../db/schema.js'
import {
  cancelScan,
  clearScanPreview,
  getScanConfig,
  getScanState,
  importProjects,
  listDirs,
  locateFolder,
  saveScanConfig,
  startScan,
} from '../services/projectScan.js'
import { listTree, readProjectFile, writeProjectFile, createEntry, renameEntry, deleteEntry } from '../services/projectFiles.js'
import { readGitDetail } from '../services/projectGit.js'
import { previewStatus, startPreview, stopPreview } from '../services/previewServer.js'
import { appIcon, listApps, openInApp } from '../services/openInApp.js'

export const projectRoutes: FastifyPluginAsync = async (app) => {
  // ===== 扫描（手动指定目录；只产出预览，不写库）=====
  app.get('/api/projects/scan/config', async () => getScanConfig())

  app.post('/api/projects/scan', async (req) => {
    const body = (req.body ?? {}) as { roots?: string[]; depth?: number }
    // 不再有「自动扫描全盘」：必须显式给出要扫的目录
    const rawRoots = Array.isArray(body.roots) ? body.roots : []
    const roots = rawRoots.map((r) => path.resolve(String(r).trim())).filter((r) => r && existsSync(r))
    if (!roots.length) throw Object.assign(new Error('请先填写要扫描的目录（该目录必须存在）'), { statusCode: 400 })
    const cfg = getScanConfig()
    const st = startScan({
      roots,
      depth: typeof body.depth === 'number' ? Math.min(Math.max(body.depth, 1), 8) : cfg.depth,
    })
    // 记住这次扫的目录，下次打开对话框直接带上
    saveScanConfig({ roots })
    return { running: st.running, startedAt: st.startedAt }
  })

  app.get('/api/projects/scan/status', async () => {
    const st = getScanState()
    return { ...st, config: getScanConfig() }
  })

  app.post('/api/projects/scan/cancel', async () => {
    cancelScan()
    return { ok: true }
  })

  app.post('/api/projects/scan/clear', async () => {
    clearScanPreview()
    return { ok: true }
  })

  /** 勾选确认后导入 */
  app.post('/api/projects/import', async (req) => {
    const body = (req.body ?? {}) as { paths?: string[]; categoryId?: number | null }
    const paths = (Array.isArray(body.paths) ? body.paths : []).map(String).filter(Boolean)
    if (!paths.length) throw Object.assign(new Error('没有选中任何项目'), { statusCode: 400 })
    const categoryId = body.categoryId == null ? null : Number(body.categoryId)
    const r = await importProjects(paths, categoryId)
    return { ok: true, ...r }
  })

  // ===== 打开方式（仿 deepseek-harness 的 open-in-app：解析一次、点击直接用已验证的启动器）=====
  app.get('/api/projects/open-in-app/apps', async () => ({ apps: await listApps() }))

  app.get('/api/projects/open-in-app/icon/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const buf = await appIcon(id)
    if (!buf) {
      reply.code(404)
      return { error: '提取不到这个应用的图标' }
    }
    reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=3600')
    return reply.send(buf)
  })

  app.post('/api/projects/open-in-app/open', async (req) => {
    const b = (req.body ?? {}) as { app?: string; path?: string }
    const appId = String(b.app ?? '')
    const target = String(b.path ?? '').trim()
    if (!appId || !target) throw Object.assign(new Error('缺少应用或路径'), { statusCode: 400 })

    // 只允许打开**已登记的项目目录**（本应用里「打开方式」的用途就是这个，不做通用路径打开器）
    const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
    const row = db.select().from(projects).all().find((p) => norm(p.path) === norm(target))
    if (!row) throw Object.assign(new Error('只能打开已登记的项目目录'), { statusCode: 400 })

    const r = await openInApp(appId, row.path)
    if (r.outcome === 'launched') {
      db.update(projects)
        .set({ lastOpenedAt: new Date().toISOString(), lastOpenTarget: appId })
        .where(eq(projects.id, row.id))
        .run()
    }
    return { ok: r.outcome === 'launched', outcome: r.outcome, label: r.label }
  })

  // ===== 目录选择 =====
  /** 应用内目录浏览：不依赖桌面，任何环境都能用（网页拿不到本地绝对路径，所以由服务端列目录） */
  app.get('/api/fs/list', async (req) => {
    const q = req.query as { path?: string }
    return listDirs(q.path)
  })

  /**
   * 系统目录框的路径反查：前端用浏览器原生目录选择框（它是**前端**弹的，所以有桌面/前台权限），
   * 但浏览器不给绝对路径 → 用「目录名 + 第一层子项指纹」在这里反查真实路径。
   */
  app.post('/api/projects/locate-folder', async (req) => {
    const b = (req.body ?? {}) as { name?: string; children?: string[] }
    return locateFolder(b.name ?? '', Array.isArray(b.children) ? b.children.map(String) : [])
  })

  // ===== 项目内文件浏览与轻量编辑（P8-2）=====
  // 安全约定：只接受「项目 id + 项目内相对路径」，服务端做 resolve + realpath 双重防逃逸。
  app.get('/api/projects/:id/tree', async (req) => {
    const { id } = req.params as { id: string }
    const q = req.query as { path?: string }
    return listTree(Number(id), q.path ?? '')
  })

  app.get('/api/projects/:id/file', async (req) => {
    const { id } = req.params as { id: string }
    const q = req.query as { path?: string }
    return readProjectFile(Number(id), q.path ?? '')
  })

  app.put('/api/projects/:id/file', async (req) => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { path?: string; content?: string }
    const r = writeProjectFile(Number(id), b.path ?? '', b.content ?? '')
    return { ok: true, ...r }
  })

  // ===== 文件管理（P8-3：新建 / 重命名 / 删除，全部走同一个防逃逸校验）=====
  app.post('/api/projects/:id/entry', async (req) => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { dir?: string; name?: string; kind?: string }
    if (b.kind !== 'file' && b.kind !== 'dir') throw Object.assign(new Error('kind 必须是 file 或 dir'), { statusCode: 400 })
    return createEntry(Number(id), b.dir ?? '', b.name ?? '', b.kind)
  })

  app.patch('/api/projects/:id/entry', async (req) => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { path?: string; name?: string }
    return renameEntry(Number(id), b.path ?? '', b.name ?? '')
  })

  app.delete('/api/projects/:id/entry', async (req) => {
    const { id } = req.params as { id: string }
    const q = req.query as { path?: string }
    return deleteEntry(Number(id), q.path ?? '')
  })

  // ===== Git 详情（P8-4，只读）=====
  app.get('/api/projects/:id/git', async (req) => {
    const { id } = req.params as { id: string }
    return readGitDetail(Number(id))
  })

  // ===== 本地预览服务器（P8-4）=====
  app.get('/api/projects/:id/preview', async (req) => {
    const { id } = req.params as { id: string }
    return previewStatus(Number(id))
  })

  app.post('/api/projects/:id/preview', async (req) => {
    const { id } = req.params as { id: string }
    return startPreview(Number(id))
  })

  app.delete('/api/projects/:id/preview', async (req) => {
    const { id } = req.params as { id: string }
    return stopPreview(Number(id))
  })

  // ===== 分类（用户自建、可嵌套；与磁盘无关）=====
  app.get('/api/projects/categories', async () => {
    const rows = db.select().from(projectCategories).all()
    const projs = db.select().from(projects).all()
    const countOf = (id: number) => projs.filter((p) => p.categoryId === id && !p.hidden).length
    return {
      list: rows.map((c) => ({ ...c, count: countOf(c.id) })),
      uncategorized: projs.filter((p) => p.categoryId == null && !p.hidden).length,
    }
  })

  app.post('/api/projects/categories', async (req) => {
    const b = (req.body ?? {}) as { name?: string; parentId?: number | null }
    const name = String(b.name ?? '').trim()
    if (!name) throw Object.assign(new Error('请填写分类名称'), { statusCode: 400 })
    const parentId = b.parentId == null ? null : Number(b.parentId)
    if (parentId != null && !db.select().from(projectCategories).where(eq(projectCategories.id, parentId)).get()) {
      throw Object.assign(new Error('父分类不存在'), { statusCode: 400 })
    }
    const now = new Date().toISOString()
    const r = db.insert(projectCategories).values({ name, parentId, sort: 0, createdAt: now, updatedAt: now }).run()
    return { ok: true, id: r.lastInsertRowid }
  })

  app.patch('/api/projects/categories/:id', async (req) => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; parentId?: number | null }
    const cid = Number(id)
    const self = db.select().from(projectCategories).where(eq(projectCategories.id, cid)).get()
    if (!self) throw Object.assign(new Error('分类不存在'), { statusCode: 404 })
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (typeof b.name === 'string') {
      const name = b.name.trim()
      if (!name) throw Object.assign(new Error('分类名称不能为空'), { statusCode: 400 })
      patch.name = name
    }
    if ('parentId' in b) {
      const parentId = b.parentId == null ? null : Number(b.parentId)
      if (parentId === cid) throw Object.assign(new Error('不能把分类移到自己下面'), { statusCode: 400 })
      // 防止成环：新父级不能是本分类的后代
      let cursor = parentId
      const all = db.select().from(projectCategories).all()
      while (cursor != null) {
        if (cursor === cid) throw Object.assign(new Error('不能移动到自己的子分类下'), { statusCode: 400 })
        cursor = all.find((c) => c.id === cursor)?.parentId ?? null
      }
      patch.parentId = parentId
    }
    db.update(projectCategories).set(patch).where(eq(projectCategories.id, cid)).run()
    return { ok: true }
  })

  /** 删除分类：子分类上移一层，分类下的项目回到上一层（不删项目、不碰磁盘） */
  app.delete('/api/projects/categories/:id', async (req) => {
    const { id } = req.params as { id: string }
    const cid = Number(id)
    const self = db.select().from(projectCategories).where(eq(projectCategories.id, cid)).get()
    if (!self) return { ok: true }
    const now = new Date().toISOString()
    db.update(projectCategories).set({ parentId: self.parentId, updatedAt: now }).where(eq(projectCategories.parentId, cid)).run()
    db.update(projects).set({ categoryId: self.parentId, updatedAt: now }).where(eq(projects.categoryId, cid)).run()
    db.delete(projectCategories).where(eq(projectCategories.id, cid)).run()
    return { ok: true }
  })

  // ===== 列表 / 记录 =====
  app.get('/api/projects', async (req) => {
    const q = req.query as Record<string, string | undefined>
    const level = q.level ?? 'all' // all | project | weak
    // 嵌套子项目（父目录本身也是项目）默认折叠，传 nested=1 才展开
    const includeNested = q.nested === '1'
    const rows = db.select().from(projects).all()

    const list = rows.filter((r) => {
      if (q.hidden === '1' ? !r.hidden : r.hidden) return false
      if (!includeNested && r.parentPath) return false
      if (q.categoryId === 'none') {
        if (r.categoryId != null) return false
      } else if (q.categoryId) {
        if (r.categoryId !== Number(q.categoryId)) return false
      }
      if (level === 'project' && r.score < 50) return false
      if (level === 'weak' && r.score >= 50) return false
      if (q.favorite === '1' && !r.favorite) return false
      if (q.git === '1' && !r.hasGit) return false
      if (q.ai === '1' && !JSON.parse(r.markers || '[]').includes('ai')) return false
      if (q.stack && !JSON.parse(r.stack || '[]').includes(String(q.stack))) return false
      if (q.q) {
        const needle = String(q.q).toLowerCase()
        const hay = `${r.alias ?? ''} ${r.name} ${r.path} ${r.note} ${r.tags}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })

    const sort = q.sort ?? 'lastCommit'
    const time = (v: string | null) => (v ? new Date(v).getTime() : 0)
    list.sort((a, b) => {
      if (a.favorite !== b.favorite) return b.favorite - a.favorite // 收藏恒置顶
      if (sort === 'name') return (a.alias ?? a.name).localeCompare(b.alias ?? b.name, 'zh-Hans-CN')
      if (sort === 'score') return b.score - a.score
      if (sort === 'lastOpened') return time(b.lastOpenedAt) - time(a.lastOpenedAt)
      return time(b.gitLastCommit) - time(a.gitLastCommit) || b.score - a.score
    })

    const stacks = [...new Set(rows.flatMap((r) => JSON.parse(r.stack || '[]') as string[]))].sort()
    // 嵌套计数只算当前筛选下会被折叠掉的那些
    const nestedVisible = rows.filter((r) => {
      if (!r.parentPath || r.hidden) return false
      if (level === 'project' && r.score < 50) return false
      if (level === 'weak' && r.score >= 50) return false
      return true
    }).length
    return {
      total: list.length,
      all: rows.filter((r) => !r.hidden).length,
      weakCount: rows.filter((r) => r.score < 50 && !r.hidden).length,
      nestedCount: nestedVisible,
      stacks,
      list,
    }
  })

  /** 手动添加单个目录（与扫描导入等价，只是不走预览） */
  app.post('/api/projects', async (req) => {
    const body = (req.body ?? {}) as { path?: string; name?: string; categoryId?: number | null }
    const raw = String(body.path ?? '').trim()
    if (!raw) throw Object.assign(new Error('请填写项目路径'), { statusCode: 400 })
    const abs = path.resolve(raw)
    if (!existsSync(abs)) throw Object.assign(new Error('路径不存在'), { statusCode: 400 })
    const categoryId = body.categoryId == null ? null : Number(body.categoryId)
    const res = await importProjects([abs], categoryId, 'manual')
    if (res.skipped.length) throw Object.assign(new Error('无法读取该目录'), { statusCode: 400 })
    // 用自定义显示名（可选）
    if (body.name?.trim()) {
      db.update(projects).set({ alias: body.name.trim() }).where(eq(projects.path, abs)).run()
    }
    return { ok: true, existed: res.existed > 0 }
  })

  app.patch('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as Partial<{
      favorite: boolean
      hidden: boolean
      note: string
      alias: string
      tags: string[]
      categoryId: number | null
    }>
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (typeof b.favorite === 'boolean') patch.favorite = b.favorite ? 1 : 0
    if (typeof b.hidden === 'boolean') patch.hidden = b.hidden ? 1 : 0
    if (typeof b.note === 'string') patch.note = b.note
    if (typeof b.alias === 'string') patch.alias = b.alias.trim() || null
    if (Array.isArray(b.tags)) patch.tags = JSON.stringify(b.tags.map((t) => String(t).trim()).filter(Boolean))
    if ('categoryId' in b) patch.categoryId = b.categoryId == null ? null : Number(b.categoryId)
    db.update(projects).set(patch).where(eq(projects.id, Number(id))).run()
    return { ok: true }
  })

  /** 批量移动项目到分类（列表里多选后用） */
  app.post('/api/projects/move', async (req) => {
    const b = (req.body ?? {}) as { ids?: number[]; categoryId?: number | null }
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isFinite(n))
    if (!ids.length) throw Object.assign(new Error('没有选中的项目'), { statusCode: 400 })
    const categoryId = b.categoryId == null ? null : Number(b.categoryId)
    const now = new Date().toISOString()
    for (const id of ids) {
      db.update(projects).set({ categoryId, updatedAt: now }).where(eq(projects.id, id)).run()
    }
    return { ok: true, moved: ids.length }
  })

  /** 只删记录，不碰磁盘 */
  app.delete('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(projects).where(eq(projects.id, Number(id))).run()
    return { ok: true }
  })

  // ===== 排除规则（P8-1 先开放接口，界面上放 P8-3 的设置板块）=====
  app.get('/api/projects/excludes', async () => db.select().from(excludeRules).all())

  app.post('/api/projects/excludes', async (req) => {
    const b = (req.body ?? {}) as { kind?: string; pattern?: string }
    const kind = String(b.kind ?? 'path-prefix')
    const pattern = String(b.pattern ?? '').trim()
    if (!pattern) throw Object.assign(new Error('请填写要排除的内容'), { statusCode: 400 })
    if (!['name', 'path-prefix', 'path-regex'].includes(kind)) {
      throw Object.assign(new Error('排除类型不支持'), { statusCode: 400 })
    }
    if (kind === 'path-regex') {
      try {
        new RegExp(pattern)
      } catch {
        throw Object.assign(new Error('正则表达式不合法'), { statusCode: 400 })
      }
    }
    const r = db.insert(excludeRules).values({ kind, pattern, builtin: 0, createdAt: new Date().toISOString() }).run()
    return { ok: true, id: r.lastInsertRowid }
  })

  app.delete('/api/projects/excludes/:id', async (req) => {
    const { id } = req.params as { id: string }
    db.delete(excludeRules).where(eq(excludeRules.id, Number(id))).run()
    return { ok: true }
  })

  /** 扫描配置保存（上次扫的目录 / 深度） */
  app.put('/api/projects/scan/config', async (req) => {
    const b = (req.body ?? {}) as { roots?: string[]; depth?: number }
    const patch: { roots?: string[]; depth?: number } = {}
    if (Array.isArray(b.roots)) {
      patch.roots = b.roots.map((r) => path.resolve(String(r).trim())).filter((r) => r && existsSync(r))
    }
    if (typeof b.depth === 'number') patch.depth = b.depth
    return saveScanConfig(patch)
  })
}
