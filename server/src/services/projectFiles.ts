/**
 * P8-2 项目内文件浏览与轻量编辑
 *
 * 安全边界（设计方案 §八，逐条落地）：
 *  ① **绝不接受任意绝对路径**：所有文件操作都由「项目 id + 项目内相对路径」组成，
 *     前端无法用它读项目以外的任何东西；
 *  ② **两道防逃逸**：先 `path.resolve` 做前缀判断（挡 `..\..\`），
 *     再对目标做 `realpath` 判断（挡符号链接 / junction 指向外部）；
 *  ③ 只写**已存在的文本文件**，单次 ≤ 2MB，写前自动备份 `<文件名>.bak`；
 *  ④ P8-2 不做新建 / 删除 / 重命名（避免误操作破坏项目）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { projects } from '../db/schema.js'

/** 单次读取上限：超过就只给前面一段并标记 truncated（Monaco 处理几 MB 会明显卡顿） */
export const MAX_READ = 2 * 1024 * 1024
/** 预览截断点 */
const TRUNCATE_AT = 512 * 1024
/** 单次写入上限 */
export const MAX_WRITE = 2 * 1024 * 1024
/** 单个目录最多返回多少条 */
const MAX_ENTRIES = 800

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code })

/** Windows 文件系统大小写不敏感，路径比较统一走这个 */
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

/** realpath 失败（路径不存在/无权限）时退回 resolve，保证不抛异常 */
function realOr(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

export interface ProjectRow {
  id: number
  path: string
  name: string
  alias: string | null
}

function loadProject(id: number): ProjectRow {
  const row = db.select().from(projects).where(eq(projects.id, id)).get()
  if (!row) throw bad('项目不存在', 404)
  if (!existsSync(row.path)) throw bad('项目目录已经不存在了（可能被移动或删除）', 404)
  return row as ProjectRow
}

/**
 * 把「项目内相对路径」解析成绝对路径，并确保它没有逃出项目根。
 * @param relRaw 相对路径（'' 表示项目根本身）
 */
export function resolveInProject(id: number, relRaw: string): { root: string; abs: string; rel: string } {
  const proj = loadProject(id)
  const root = realOr(proj.path)
  const raw = String(relRaw ?? '')
  // 显式拒绝绝对路径（含盘符 / UNC），避免歧义：本接口只接受项目内相对路径
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('//')) {
    throw bad('请提供项目内的相对路径')
  }
  // 统一分隔符、去掉前导斜杠
  const rel = raw.replace(/\\/g, '/').replace(/^\/+/, '')
  const abs = path.resolve(root, rel)

  // ① 字符串层：挡住 ../ 逃逸
  if (norm(abs) !== norm(root) && !norm(abs).startsWith(norm(root) + path.sep)) {
    throw bad('路径超出项目范围')
  }

  // ② 文件系统层：挡住符号链接 / junction 指向项目外
  const probe = existsSync(abs) ? abs : path.dirname(abs)
  const realProbe = realOr(probe)
  if (norm(realProbe) !== norm(root) && !norm(realProbe).startsWith(norm(root) + path.sep)) {
    throw bad('该路径是指向项目之外的链接，已拒绝访问')
  }

  return { root, abs, rel: abs.slice(root.length).replace(/^[\\/]/, '').replace(/\\/g, '/') }
}

// ==================== 忽略规则（文件树用） ====================

/** 文件树默认不展开的目录：依赖 / 构建产物 / 版本库内部（打开它们只会有噪音） */
const TREE_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn',
  'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'output', 'target', 'coverage', 'release',
  '.next', '.nuxt', '.svelte-kit', '.output', '.turbo', '.parcel-cache',
  '__pycache__', '.venv', 'venv', '.tox', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.gradle', '.m2', 'obj', 'bin',
  '.cache', '.tmp', 'tmp', '.idea', '.vscode',
])

// ==================== 语言映射（对齐 Monaco 的 languageId） ====================

const LANG_BY_EXT: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', pyw: 'python',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', ino: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', php: 'php', rb: 'ruby', swift: 'swift', dart: 'dart',
  lua: 'lua', pl: 'perl', r: 'r', jl: 'julia', hs: 'plaintext',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell',
  bat: 'bat', cmd: 'bat',
  sql: 'sql', mysql: 'mysql', pgsql: 'pgsql',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
  xml: 'xml', svg: 'xml', xsl: 'xml', plist: 'xml', csproj: 'xml', xaml: 'xml',
  graphql: 'graphql', gql: 'graphql', proto: 'protobuf', tf: 'hcl', hcl: 'hcl',
  dockerfile: 'dockerfile', makefile: 'plaintext', cmake: 'plaintext', gradle: 'plaintext',
  txt: 'plaintext', log: 'plaintext', gitignore: 'plaintext', editorconfig: 'plaintext',
}

/** 没有扩展名但按文件名识别的 */
const LANG_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'plaintext',
  'cmakelists.txt': 'plaintext',
  '.gitignore': 'plaintext',
  '.gitattributes': 'plaintext',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
}

export function languageOf(filePath: string): string {
  const base = path.basename(filePath).toLowerCase()
  if (LANG_BY_NAME[base]) return LANG_BY_NAME[base]
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : ''
  return LANG_BY_EXT[ext] ?? 'plaintext'
}

/** 能在应用内预览的文件类型 */
export function previewKindOf(filePath: string): 'html' | 'svg' | 'markdown' | null {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '')
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'svg') return 'svg'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  return null
}

/** 明确按二进制处理、不允许在编辑器里保存的扩展名 */
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff', 'avif',
  'pdf', 'zip', 'rar', '7z', 'gz', 'tar', 'xz', 'bz2',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'o', 'a', 'lib', 'pdb',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'mp4', 'mkv', 'mov', 'avi', 'webm',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'psd', 'ai', 'sketch', 'db', 'sqlite', 'sqlite3',
  'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'apk',
])

// ==================== 目录树 ====================

export interface TreeNode {
  name: string
  rel: string
  isDir: boolean
  size: number | null
  ext: string
  /** 属于依赖/产物类目录，默认折叠（前端可切换显示） */
  ignored: boolean
  /** 该目录下是否有 Git 等标记（仅目录、仅一层，用于给个视觉提示） */
  looksLikePackage?: boolean
}

export interface TreeListing {
  /** 当前列出的相对路径（'' = 项目根） */
  rel: string
  /** 面包屑：从项目根到当前目录 */
  crumbs: { name: string; rel: string }[]
  entries: TreeNode[]
  /** 被折叠掉的忽略目录数量 */
  ignoredCount: number
  /** 是否因为条目过多被截断 */
  truncated: boolean
}

export function listTree(id: number, relRaw: string): TreeListing {
  const { root, abs, rel } = resolveInProject(id, relRaw)
  let dirents: import('node:fs').Dirent[] = []
  try {
    dirents = readdirSync(abs, { withFileTypes: true })
  } catch (e) {
    throw bad(`无法读取该目录：${(e as Error).message}`)
  }

  const entries: TreeNode[] = []
  let ignoredCount = 0
  let truncated = false

  for (const d of dirents) {
    if (d.isSymbolicLink()) continue // 不跟随链接，避免成环与逃逸
    const childAbs = path.join(abs, d.name)
    const childRel = rel ? `${rel}/${d.name}` : d.name
    const isDir = d.isDirectory()
    if (isDir && TREE_SKIP_DIRS.has(d.name.toLowerCase())) {
      ignoredCount++
      continue
    }
    let size: number | null = null
    if (!isDir) {
      try {
        size = statSync(childAbs).size
      } catch {
        size = null
      }
    }
    entries.push({
      name: d.name,
      rel: childRel,
      isDir,
      size,
      ext: isDir ? '' : path.extname(d.name).toLowerCase().replace(/^\./, ''),
      ignored: false,
      ...(isDir && isPackageDir(childAbs) ? { looksLikePackage: true } : {}),
    })
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })

  const segs = rel ? rel.split('/') : []
  const crumbs = [{ name: root.split(/[\\/]/).filter(Boolean).pop() ?? '.', rel: '' }]
  segs.forEach((s, i) => crumbs.push({ name: s, rel: segs.slice(0, i + 1).join('/') }))

  return { rel, crumbs, entries, ignoredCount, truncated }
}

/** 目录里是否有 git / 包清单（给文件树一个小标记） */
function isPackageDir(dir: string): boolean {
  try {
    const names = new Set(readdirSync(dir).map((n) => n.toLowerCase()))
    return names.has('.git') || names.has('package.json') || names.has('pyproject.toml') || names.has('cargo.toml')
  } catch {
    return false
  }
}

// ==================== 读文件 ====================

export interface FileContent {
  rel: string
  name: string
  /** 文件字节数 */
  size: number
  ext: string
  language: string
  preview: 'html' | 'svg' | 'markdown' | null
  /** text = 可在编辑器打开；binary = 只能提示；tooLarge = 太大 */
  kind: 'text' | 'binary' | 'tooLarge'
  content: string | null
  truncated: boolean
  mtime: string
  /** 能否保存（二进制 / 截断的大文件不可写） */
  editable: boolean
}

export function readProjectFile(id: number, relRaw: string): FileContent {
  const { abs, rel } = resolveInProject(id, relRaw)
  if (!rel) throw bad('请指定要打开的文件')

  let st
  try {
    st = statSync(abs)
  } catch {
    throw bad('文件不存在', 404)
  }
  if (st.isDirectory()) throw bad('这是一个文件夹')

  const ext = path.extname(abs).toLowerCase().replace(/^\./, '')
  const name = path.basename(abs)
  const base: Omit<FileContent, 'kind' | 'content' | 'truncated' | 'editable'> = {
    rel,
    name,
    size: st.size,
    ext,
    language: languageOf(abs),
    preview: previewKindOf(abs),
    mtime: st.mtime.toISOString(),
  }

  // 已知二进制扩展名：直接判定，不读内容
  if (BINARY_EXTS.has(ext)) {
    return { ...base, kind: 'binary', content: null, truncated: false, editable: false }
  }

  // 无扩展名的文件也做个探测（前 8KB 有 NUL 字节就当二进制）
  const buf = readFileSync(abs)
  const head = buf.subarray(0, 8192)
  if (head.includes(0)) {
    return { ...base, kind: 'binary', content: null, truncated: false, editable: false }
  }

  if (buf.length > MAX_READ) {
    // 给前 512KB 让用户能看个大概，但明确不可保存（避免把截断内容写回去毁掉文件）
    return {
      ...base,
      kind: 'tooLarge',
      content: buf.subarray(0, TRUNCATE_AT).toString('utf8'),
      truncated: true,
      editable: false,
    }
  }

  return { ...base, kind: 'text', content: buf.toString('utf8'), truncated: false, editable: true }
}

// ==================== 写文件 ====================

export interface WriteResult {
  rel: string
  size: number
  mtime: string
  /** 备份文件名（列表页可直接提示） */
  backup: string
}

export function writeProjectFile(id: number, relRaw: string, content: string): WriteResult {
  const { abs, rel } = resolveInProject(id, relRaw)
  if (!rel) throw bad('请指定要保存的文件')
  if (typeof content !== 'string') throw bad('内容格式不正确')

  if (!existsSync(abs)) throw bad('文件不存在（本版本不支持新建文件）', 404)
  const st = statSync(abs)
  if (st.isDirectory()) throw bad('这是一个文件夹')

  const ext = path.extname(abs).toLowerCase().replace(/^\./, '')
  if (BINARY_EXTS.has(ext)) throw bad('不支持编辑二进制文件')

  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_WRITE) throw bad(`文件太大了（${(bytes / 1024 / 1024).toFixed(1)} MB），上限 2 MB`)

  // 备份：同名 .bak，覆盖旧备份（只留最近一次，避免堆一堆文件）
  const backupPath = `${abs}.bak`
  try {
    copyFileSync(abs, backupPath)
  } catch (e) {
    throw bad(`创建备份失败，已取消保存：${(e as Error).message}`, 500)
  }

  writeFileSync(abs, content, 'utf8')
  const after = statSync(abs)
  return { rel, size: after.size, mtime: after.mtime.toISOString(), backup: path.basename(backupPath) }
}

// ==================== 文件管理（P8-3：新建 / 重命名 / 删除） ====================

/** Windows 文件名的非法字符；同时挡掉 . / .. 这类特殊名 */
const BAD_NAME = /[\/:*?"<>|]/

function assertName(name: string): string {
  const n = String(name ?? '').trim()
  if (!n) throw bad('名称不能为空')
  if (n.length > 200) throw bad('名称太长了')
  if (BAD_NAME.test(n)) throw bad('名称不能包含 \ / : * ? " < > | 字符')
  if (n === '.' || n === '..' || n.startsWith('.git') || n.toLowerCase() === 'node_modules') {
    throw bad('这个名称会被保留，换一个吧')
  }
  return n
}

export interface CreateEntryResult {
  rel: string
  name: string
  kind: 'file' | 'dir'
}

/** 在指定目录下新建文件（空文件）或文件夹 */
export function createEntry(id: number, relDirRaw: string, name: string, kind: 'file' | 'dir'): CreateEntryResult {
  const { abs: dirAbs, rel: dirRel } = resolveInProject(id, relDirRaw)
  let st
  try {
    st = statSync(dirAbs)
  } catch {
    throw bad('目标文件夹不存在', 404)
  }
  if (!st.isDirectory()) throw bad('目标不是一个文件夹')

  const clean = assertName(name)
  const target = path.join(dirAbs, clean)
  if (existsSync(target)) throw bad(`「${clean}」已经存在了`, 409)

  if (kind === 'dir') mkdirSync(target)
  else writeFileSync(target, '', 'utf8')

  const rel = dirRel ? `${dirRel}/${clean}` : clean
  return { rel, name: clean, kind }
}

/** 重命名文件 / 文件夹（只改名字，不移动位置） */
export function renameEntry(id: number, relRaw: string, newName: string): { rel: string } {
  const { abs, rel } = resolveInProject(id, relRaw)
  if (!rel) throw bad('不能重命名项目根目录')
  const clean = assertName(newName)
  const target = path.join(path.dirname(abs), clean)
  if (existsSync(target)) throw bad(`「${clean}」已经存在了`, 409)
  renameSync(abs, target)
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  return { rel: parent ? `${parent}/${clean}` : clean }
}

/** 删除文件 / 文件夹（文件夹递归删除；这是**永久删除**，前端必须强确认） */
export function deleteEntry(id: number, relRaw: string): { deletedDirs: number; deletedFiles: number } {
  const { abs, rel } = resolveInProject(id, relRaw)
  if (!rel) throw bad('不能删除项目根目录')

  // 删除前统计（给前端一个可提示的量级）
  let deletedDirs = 0
  let deletedFiles = 0
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, d.name)
      if (d.isDirectory()) {
        deletedDirs++
        walk(child)
      } else {
        deletedFiles++
      }
    }
  }
  const st = statSync(abs)
  if (st.isDirectory()) {
    deletedDirs++
    walk(abs)
  } else {
    deletedFiles = 1
  }

  rmSync(abs, { recursive: true })
  return { deletedDirs, deletedFiles }
}
