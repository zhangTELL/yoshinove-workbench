/**
 * 本地项目扫描器（P8）
 *
 * 设计依据见 `P8-项目管理-设计方案.md` 第三节（本机只读试扫实测）：
 *  - 「有 README 或 package.json 就算项目」会大面积误判（IDE 插件目录、monorepo 子包、
 *    工具工作区全都命中），所以采用**打分 + 阈值 + 嵌套折叠**；
 *  - 用户目录 + 非系统盘全扫只要 0.3s，因此不为性能牺牲覆盖面，改为严格排除真实噪声源。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db, sqlite } from '../db/index.js'
import { excludeRules, projects } from '../db/schema.js'

// ==================== 排除规则（内置，实测驱动） ====================

/**
 * 名称级排除：依赖/构建产物、包管理器与语言缓存、应用与工具数据、系统目录。
 * ⚠️ 必须包含 Windows 遗留 junction 名（Application Data / Local Settings / My Documents …），
 * 虽然遍历时还会跳过符号链接，但双保险可以避免万一被当成真实目录而反复遍历。
 */
export const BUILTIN_NAME_EXCLUDES = [
  // 依赖与构建产物
  'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.svelte-kit',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.ipynb_checkpoints', 'vendor', 'obj', 'bower_components', '.terraform', '.parcel-cache',
  '.gradle', '.m2',
  // 包管理器 / 语言运行时缓存
  '.npm', '.pnpm-store', '.yarn', '.bun', '.nuget', '.cargo', '.rustup', '.conda', '.dotnet',
  '.jbr', '.jdks', '.local', 'pipx', '.matplotlib', '.modelscope', '.cache', '.templateengine',
  '.electron', '.gradle-cache', '.eslintcache',
  // 应用数据 / 工具数据（含 AI 工具自身目录与 IDE 插件目录）
  'AppData', 'Application Data', 'Local Settings', 'My Documents', 'NetHood', 'PrintHood',
  'Recent', 'SendTo', 'Templates', 'Cookies', '「开始」菜单', 'Start Menu', '.config', '.ssh',
  '.claude', '.codex', '.codebuddy', '.copilot', '.agents', '.agent-browser', '.playwright-mcp',
  '.cursor', '.continue', '.junie', '.aider', '.trae-cn', '.cursor-server', '.vscode-server',
  '.dsh', '.hub', '.sheetagent', '.codex-session-delete', '.claude-code-gui', '.cc-switch',
  '.chromium-browser-snapshots', '.crawl4ai', '.doubao', '.oh-my-posh', '.playwright', '.docker',
  '.android', 'extensions', 'site-packages', 'Lib', 'Scripts', 'Share', 'include',
  '.vscode', '.idea', '.history', 'logs', '.DS_Store', '.thumbnails', 'WinSxS',
  // 系统
  '$Recycle.Bin', 'System Volume Information', 'Windows', 'Program Files', 'Program Files (x86)',
  'ProgramData', 'Recovery', 'PerfLogs', 'MSOCache', 'Intel', 'AMD', 'NVIDIA', 'Config.Msi',
  'OneDriveTemp', 'GPUCache', 'Temp', 'tmp',
]

/**
 * 路径级排除（正则，命中即整棵子树跳过）：
 * IDE / 工具安装目录、工具工作区、日期时间命名的临时目录。
 */
export const BUILTIN_PATH_PATTERNS = [
  '[\\\\/](?:IDEA|PyCharm|WebStorm|GoLand|CLion|DataGrip|Rider|PhpStorm|AppCode|RubyMine)[^\\\\/]*[\\\\/]',
  '[\\\\/]Trae CN[\\\\/]',
  '[\\\\/]visual studio[\\\\/]',
  '[\\\\/]\\.zcode[\\\\/]',
  '[\\\\/]\\.workbuddy[\\\\/]',
  '[\\\\/]WorkBuddy[\\\\/]',
  '[\\\\/]\\.agent-reach[\\\\/]',
  '\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}', // 2026-09-15-22-38-56 这类临时工作目录
]

// ==================== 项目标记与打分 ====================

/** 构建/工程文件（命中即 +15，每多一个 +5，上限 +25） */
export const BUILD_MARKERS = [
  'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'cargo.toml', 'go.mod',
  'pyproject.toml', 'requirements.txt', 'setup.py', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'cmakelists.txt', 'makefile', 'composer.json', 'gemfile', 'pubspec.yaml', 'tsconfig.json',
  'deno.json', '*.sln', '*.csproj',
]

/** 文档标记 */
const DOC_MARKERS = ['readme.md', 'readme.txt', 'readme', 'license', 'changelog.md']

/** AI 辅助工具标记（文件或目录） */
export const AI_MARKERS = [
  '.claude', '.codex', '.codebuddy', '.cursor', '.continue', '.junie', '.aider', '.windsurf',
  'claude.md', 'agents.md', '.cursorrules', '.aider.conf.yml',
]

/** 技术栈推断：标记 → 标签 */
const STACK_RULES: { label: string; hit: (names: Set<string>) => boolean }[] = [
  { label: 'Vue', hit: (n) => n.has('vue.config.ts') || n.has('vue.config.js') },
  { label: 'Vite', hit: (n) => n.has('vite.config.ts') || n.has('vite.config.js') },
  { label: 'Next.js', hit: (n) => n.has('next.config.js') || n.has('next.config.mjs') || n.has('next.config.ts') },
  { label: 'Node.js', hit: (n) => n.has('package.json') },
  { label: 'TypeScript', hit: (n) => n.has('tsconfig.json') },
  { label: 'Rust', hit: (n) => n.has('cargo.toml') },
  { label: 'Go', hit: (n) => n.has('go.mod') },
  { label: 'Python', hit: (n) => n.has('pyproject.toml') || n.has('requirements.txt') || n.has('setup.py') },
  { label: 'Java', hit: (n) => n.has('pom.xml') || n.has('build.gradle') || n.has('build.gradle.kts') },
  { label: 'C/C++', hit: (n) => n.has('cmakelists.txt') || n.has('makefile') || n.has('*.sln') },
  { label: 'PHP', hit: (n) => n.has('composer.json') },
  { label: 'Ruby', hit: (n) => n.has('gemfile') },
  { label: 'Flutter', hit: (n) => n.has('pubspec.yaml') },
]

export interface ScanCandidate {
  dir: string
  name: string
  score: number
  markers: string[]
  stack: string[]
  hasGit: boolean
  parentPath: string | null
}

const THRESHOLD_PROJECT = 50 // ≥50：有 git 等强信号
const THRESHOLD_WEAK = 15 // 15~49：弱信号（折叠展示，可收藏提升）

/** 单目录打分；score 为 0 表示不是候选 */
function scoreDir(dir: string, names: Set<string>): { score: number; markers: string[]; stack: string[] } {
  const markers: string[] = []
  let score = 0

  if (names.has('.git')) {
    score += 50
    markers.push('git')
  }
  if (names.has('.hg') || names.has('.svn')) {
    score += 40
    markers.push('vcs')
  }

  const buildHits = BUILD_MARKERS.filter((m) => (m.startsWith('*.') ? false : names.has(m)))
  if (buildHits.length) {
    score += 15 + Math.min(buildHits.length - 1, 2) * 5
    markers.push(`build:${buildHits.length}`)
  }

  if (DOC_MARKERS.some((m) => names.has(m))) {
    score += 20
    markers.push('doc')
  }

  const aiHits = AI_MARKERS.filter((m) => names.has(m))
  if (aiHits.length) {
    score += 15
    markers.push('ai')
  }

  const stack = STACK_RULES.filter((r) => r.hit(names)).map((r) => r.label)
  const hasGit = names.has('.git')
  return { score, markers, stack: stack.slice(0, 4) }
}

/** 读取 README 摘要（前 4KB，去掉常见 Markdown 标记，截 200 字） */
function readmeExcerpt(dir: string): string | null {
  try {
    const files = readdirSync(dir)
    const real = files.find((n) => ['readme.md', 'readme.txt', 'readme'].includes(n.toLowerCase()))
    if (!real) return null
    const raw = readFileSync(path.join(dir, real), 'utf8').slice(0, 4096)
    const text = raw
      .replace(/```[\s\S]*?```/g, ' ') // 代码块
      .replace(/<!--[\s\S]*?-->/g, ' ') // HTML 注释
      .replace(/<[^>]*>/g, ' ') // 内联 HTML 标签（README 里很常见）
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
      .replace(/^\s{0,3}#{1,6}\s*/gm, '') // 标题符号
      .replace(/^\s*[-:|]{3,}\s*$/gm, ' ') // 表格分隔行
      .replace(/[*_>`|]/g, '') // 强调与表格竖线
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
    return text.slice(0, 200) || null
  } catch {
    return null
  }
}

// ==================== git 元数据 ====================

const GIT_TIMEOUT = 5000

function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim())
    })
  })
}

export interface GitInfo {
  branch: string | null
  lastCommit: string | null
  lastAuthor: string | null
  lastSubject: string | null
  remote: string | null
  dirty: number
}

/** 一次拿齐 git 摘要：3 个子进程（log / status / remote），失败一律降级为空 */
async function readGitInfo(dir: string): Promise<GitInfo> {
  const [logLine, statusOut, remote] = await Promise.all([
    git(dir, ['log', '-1', '--format=%aI%x1f%an%x1f%s']),
    git(dir, ['status', '--porcelain', '--untracked-files=no']),
    git(dir, ['remote', 'get-url', 'origin']),
  ])
  const [iso, author, subject] = logLine ? logLine.split('\x1f') : []
  return {
    branch: null, // 由 status --porcelain 的 ## 行解析，省一次 spawn
    lastCommit: iso || null,
    lastAuthor: author || null,
    lastSubject: subject || null,
    remote: remote || null,
    dirty: statusOut ? statusOut.split('\n').filter(Boolean).length : 0,
  }
}

/** status 里其实带分支信息，这里单独解析（git status 不带 --branch 就没有，另起一次很便宜） */
async function readBranch(dir: string): Promise<string | null> {
  const b = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return b && b !== 'HEAD' ? b : null
}

// ==================== 配置 ====================
//
// 注意：本功能**不做自动扫描**（不扫全盘、不扫用户目录）。
// 扫描必须由用户显式指定一个或几个根目录，结果只做「预览」，勾选后才导入列表。

export interface ScanConfig {
  roots: string[]
  depth: number
}

export function getScanConfig(): ScanConfig {
  const row = sqlite.prepare(`SELECT value FROM settings WHERE key = 'projects.roots'`).get() as { value: string } | undefined
  const depthRow = sqlite.prepare(`SELECT value FROM settings WHERE key = 'projects.depth'`).get() as { value: string } | undefined
  let roots: string[] = []
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value)
      if (Array.isArray(parsed)) roots = parsed.map(String)
    } catch {
      /* 配置坏了就当空 */
    }
  }
  const depth = depthRow?.value ? Number(depthRow.value) : 3
  return { roots, depth: Math.min(Math.max(Number.isFinite(depth) ? depth : 3, 1), 8) }
}

export function saveScanConfig(patch: Partial<ScanConfig>): ScanConfig {
  const stmt = sqlite.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
  if (Array.isArray(patch.roots)) stmt.run('projects.roots', JSON.stringify(patch.roots))
  if (typeof patch.depth === 'number') stmt.run('projects.depth', String(Math.min(Math.max(Math.round(patch.depth), 1), 8)))
  return getScanConfig()
}

/** 排除规则：内置 + 用户自建（都从 DB 读，便于界面上增删） */
function loadExcludes(): { names: Set<string>; pathRes: RegExp[] } {
  const names = new Set(BUILTIN_NAME_EXCLUDES.map((n) => n.toLowerCase()))
  const patterns = [...BUILTIN_PATH_PATTERNS]
  try {
    const rules = db.select().from(excludeRules).all()
    for (const r of rules) {
      if (r.kind === 'name') names.add(r.pattern.toLowerCase())
      else patterns.push(r.pattern)
    }
  } catch {
    /* 首次启动表还没建好时忽略 */
  }
  const pathRes: RegExp[] = []
  for (const p of patterns) {
    try {
      pathRes.push(new RegExp(p, 'i'))
    } catch {
      /* 坏正则跳过 */
    }
  }
  return { names, pathRes }
}

// ==================== 扫描状态与执行 ====================

export interface ScanResult {
  at: string
  ms: number
  dirsScanned: number
  candidates: number
  roots: string[]
  depth: number
}

/** 预览给前端的一条候选（不写库，勾选后才导入） */
export interface ScanCandidateView extends ScanCandidate {
  /** 是否已经在列表里了 */
  imported: boolean
  gitBranch?: string | null
  gitLastCommit?: string | null
  gitLastAuthor?: string | null
  gitLastSubject?: string | null
  readmeExcerpt?: string | null
}

export interface ScanState {
  running: boolean
  startedAt: string | null
  dirsScanned: number
  hits: number
  current: string
  cancelRequested: boolean
  lastResult: ScanResult | null
  error: string | null
  /** 扫描完成后的候选列表（预览用） */
  candidates: ScanCandidateView[]
}

const state: ScanState = {
  running: false,
  startedAt: null,
  dirsScanned: 0,
  hits: 0,
  current: '',
  cancelRequested: false,
  lastResult: null,
  error: null,
  candidates: [],
}

export function getScanState(): ScanState {
  if (!state.lastResult) {
    const row = sqlite.prepare(`SELECT value FROM settings WHERE key = 'projects.lastScan'`).get() as { value: string } | undefined
    if (row?.value) {
      try {
        state.lastResult = JSON.parse(row.value) as ScanResult
      } catch {
        /* ignore */
      }
    }
  }
  return state
}

export function clearScanPreview(): void {
  state.candidates = []
}

export function cancelScan(): void {
  if (state.running) state.cancelRequested = true
}

const MAX_DIRS = 200000

/** 执行一次扫描（异步；只产出预览，不写 projects 表） */
export function startScan(cfg: ScanConfig): ScanState {
  if (state.running) return state
  state.running = true
  state.startedAt = new Date().toISOString()
  state.dirsScanned = 0
  state.hits = 0
  state.current = ''
  state.cancelRequested = false
  state.error = null
  state.candidates = []

  void runScan(cfg)
    .catch((e) => {
      state.error = (e as Error).message
    })
    .finally(() => {
      state.running = false
      state.current = ''
    })
  return state
}

async function runScan(cfg: ScanConfig): Promise<void> {
  const t0 = Date.now()
  const { names: skipNames, pathRes: skipPaths } = loadExcludes()
  const candidates: ScanCandidate[] = []

  const stack = cfg.roots.map((root) => ({ dir: root, depth: 0 }))
  const rootSet = new Set(cfg.roots.map((r) => path.resolve(r).toLowerCase()))

  while (stack.length && state.dirsScanned < MAX_DIRS) {
    if (state.cancelRequested) break
    const { dir, depth } = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 权限不足/已被删除：跳过
    }
    state.dirsScanned++
    state.current = dir

    const names = new Set(entries.map((e) => e.name.toLowerCase()))

    if (!rootSet.has(path.resolve(dir).toLowerCase())) {
      const { score, markers, stack: techStack } = scoreDir(dir, names)
      if (score >= THRESHOLD_WEAK) {
        candidates.push({
          dir,
          name: path.basename(dir),
          score,
          markers,
          stack: techStack,
          hasGit: names.has('.git'),
          parentPath: null,
        })
        state.hits = candidates.length
      }
    }

    if (depth >= cfg.depth) continue
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.isSymbolicLink()) continue // 不跟随链接/junction，避免成环
      const lower = e.name.toLowerCase()
      if (skipNames.has(lower)) continue
      const child = path.join(dir, e.name)
      if (skipPaths.some((re) => re.test(child))) continue
      stack.push({ dir: child, depth: depth + 1 })
    }
  }

  // 嵌套折叠：祖先里已有候选时，标记 parentPath
  const candSet = new Set(candidates.map((c) => path.resolve(c.dir).toLowerCase()))
  for (const c of candidates) {
    let p = path.dirname(path.resolve(c.dir))
    while (p && p !== path.dirname(p)) {
      if (candSet.has(p.toLowerCase())) {
        c.parentPath = p
        break
      }
      p = path.dirname(p)
    }
  }

  // git 元数据：并发 4，仅对有 .git 的候选
  const gitDirs = candidates.filter((c) => c.hasGit)
  const gitInfos = new Map<string, GitInfo & { branch: string | null }>()
  const queue = [...gitDirs]
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      const info = await readGitInfo(item.dir)
      info.branch = await readBranch(item.dir)
      gitInfos.set(item.dir, info)
    }
  })
  await Promise.all(workers)

  // 补上 git 摘要与 README 摘要（预览里直接可见），并标注「已在列表里」
  const known = new Set(db.select().from(projects).all().map((r) => path.resolve(r.path).toLowerCase()))
  const view: ScanCandidateView[] = candidates
    .sort((a, b) => b.score - a.score)
    .map((c) => {
      const g = gitInfos.get(c.dir)
      return {
        ...c,
        imported: known.has(path.resolve(c.dir).toLowerCase()),
        // 复用扫描器已有的字段填充逻辑，预览里就能看到分支/最近提交/README
        score: c.score,
        markers: c.markers,
        stack: c.stack,
        hasGit: c.hasGit,
        parentPath: c.parentPath,
        ...(g
          ? {
              gitBranch: g.branch,
              gitLastCommit: g.lastCommit,
              gitLastSubject: g.lastSubject,
              gitLastAuthor: g.lastAuthor,
            }
          : {}),
        readmeExcerpt: readmeExcerpt(c.dir),
      } as ScanCandidateView
    })

  state.candidates = view
  const result: ScanResult = {
    at: new Date().toISOString(),
    ms: Date.now() - t0,
    dirsScanned: state.dirsScanned,
    candidates: candidates.length,
    roots: cfg.roots,
    depth: cfg.depth,
  }
  state.lastResult = result
  sqlite
    .prepare(`INSERT INTO settings (key, value) VALUES ('projects.lastScan', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(result))
}

/** 供列表接口排序用的「最近提交时间」兜底：文件系统 mtime */
export function dirMtime(dir: string): string | null {
  try {
    return statSync(dir).mtime.toISOString()
  } catch {
    return null
  }
}

// ==================== 导入（勾选确认后写库） ====================

async function describeDir(dir: string): Promise<ProjectMeta> {
  const names = new Set(readdirSync(dir).map((n) => n.toLowerCase()))
  const { score, markers, stack } = scoreDir(dir, names)
  const hasGit = names.has('.git')
  let git: (GitInfo & { branch: string | null }) | null = null
  if (hasGit) {
    git = await readGitInfo(dir)
    git.branch = await readBranch(dir)
  }
  return {
    path: dir,
    name: path.basename(dir),
    score,
    markers,
    stack,
    hasGit,
    gitBranch: git?.branch ?? null,
    gitLastCommit: git?.lastCommit ?? null,
    gitLastAuthor: git?.lastAuthor ?? null,
    gitLastSubject: git?.lastSubject ?? null,
    gitRemote: git?.remote ?? null,
    gitDirty: hasGit ? (git?.dirty ?? 0) : null,
    readmeExcerpt: readmeExcerpt(dir),
  }
}

/**
 * 把勾选的项目写进列表（幂等：按 path upsert）。
 * 已存在的记录只补元数据，**用户字段（分类/收藏/别名/备注/标签/最近打开）保持不动**。
 */
export async function importProjects(
  paths: string[],
  categoryId: number | null,
  source = 'scan',
): Promise<{ added: number; existed: number; skipped: string[] }> {
  const now = new Date().toISOString()
  let added = 0
  let existed = 0
  const skipped: string[] = []

  for (const raw of paths) {
    const abs = path.resolve(String(raw))
    let meta: ProjectMeta
    try {
      meta = await describeDir(abs)
    } catch {
      skipped.push(abs)
      continue
    }
    const old = db.select().from(projects).where(eq(projects.path, abs)).get()
    if (old) {
      existed++
      db.update(projects)
        .set({
          score: meta.score,
          markers: JSON.stringify(meta.markers),
          stack: JSON.stringify(meta.stack),
          hasGit: meta.hasGit ? 1 : 0,
          gitBranch: meta.gitBranch,
          gitLastCommit: meta.gitLastCommit,
          gitLastAuthor: meta.gitLastAuthor,
          gitLastSubject: meta.gitLastSubject,
          gitRemote: meta.gitRemote,
          gitDirty: meta.gitDirty,
          readmeExcerpt: meta.readmeExcerpt ?? old.readmeExcerpt,
          // 重新导入时如果指定了分类才覆盖
          ...(categoryId != null ? { categoryId } : {}),
          hidden: 0,
          updatedAt: now,
        })
        .where(eq(projects.id, old.id))
        .run()
      continue
    }
    db.insert(projects)
      .values({
        path: abs,
        name: meta.name,
        source,
        score: meta.score,
        markers: JSON.stringify(meta.markers),
        stack: JSON.stringify(meta.stack),
        hasGit: meta.hasGit ? 1 : 0,
        gitBranch: meta.gitBranch,
        gitLastCommit: meta.gitLastCommit,
        gitLastAuthor: meta.gitLastAuthor,
        gitLastSubject: meta.gitLastSubject,
        gitRemote: meta.gitRemote,
        gitDirty: meta.gitDirty,
        readmeExcerpt: meta.readmeExcerpt,
        categoryId,
        firstSeenAt: now,
        updatedAt: now,
      })
      .run()
    added++
  }
  return { added, existed, skipped }
}

export interface ProjectMeta {
  path: string
  name: string
  score: number
  markers: string[]
  stack: string[]
  hasGit: boolean
  gitBranch: string | null
  gitLastCommit: string | null
  gitLastAuthor: string | null
  gitLastSubject: string | null
  gitRemote: string | null
  gitDirty: number | null
  readmeExcerpt: string | null
}

/** 单独添加一个目录（手动添加） */
export async function describeOne(dir: string): Promise<ProjectMeta> {
  return describeDir(dir)
}

// ==================== 应用内目录浏览（不依赖桌面，任何环境都能用） ====================

export interface DirEntry {
  name: string
  path: string
  /** 该目录看起来像不像项目（有 .git / README / 构建文件），给选择器加个绿点 */
  looksLikeProject: boolean
}

export interface DirListing {
  current: string
  parent: string | null
  entries: DirEntry[]
  /** 盘符与主目录，供选择器“回到顶层” */
  roots: { name: string; path: string }[]
}

const MAX_ENTRIES = 800

/** 可用起点：所有存在的盘符 + 用户主目录 */
export function listRoots(): { name: string; path: string }[] {
  const roots: { name: string; path: string }[] = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:\\`
    if (existsSync(drive)) roots.push({ name: `${letter}: 盘`, path: drive })
  }
  const home = process.env.USERPROFILE
  if (home && existsSync(home)) roots.unshift({ name: '用户目录', path: home })
  return roots
}

/**
 * 列出一个目录下的子目录（只给目录名，不读文件内容）。
 * 跳过符号链接/junction，避免选择器里出现循环入口。
 */
export function listDirs(target?: string): DirListing {
  const current = target && existsSync(target) ? path.resolve(target) : (listRoots()[0]?.path ?? 'C:\\')
  let entries: DirEntry[] = []
  try {
    const dirents = readdirSync(current, { withFileTypes: true })
    entries = dirents
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .slice(0, MAX_ENTRIES)
      .map((e) => {
        const full = path.join(current, e.name)
        let looksLikeProject = false
        try {
          const names = new Set(readdirSync(full).map((n) => n.toLowerCase()))
          looksLikeProject = names.has('.git') || names.has('readme.md') || names.has('package.json')
        } catch {
          /* 无权限：当作普通目录 */
        }
        return { name: e.name, path: full, looksLikeProject }
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  } catch {
    entries = []
  }
  const parentPath = path.dirname(current)
  return {
    current,
    parent: parentPath && parentPath !== current ? parentPath : null,
    entries,
    roots: listRoots(),
  }
}

// ==================== 系统目录框的「路径反查」====================
/**
 * 前端用浏览器原生目录选择框（`showDirectoryPicker`）拿到的是**句柄**——
 * 浏览器出于安全永远不给绝对路径。所以前端把「目录名 + 第一层子项名」当指纹传过来，
 * 这里在本机常见位置（用户目录 + 各盘符）按 **名字精确匹配 + 子项交集** 反查真实路径。
 *
 * 只读目录名，不读任何文件内容；同名 + 子项高度吻合才会命中，多命中时交给用户确认。
 */
export interface LocateCandidate {
  path: string
  name: string
  /** 命中指纹的子项数 */
  matched: number
  /** 该目录第一层子项总数 */
  total: number
}

export interface LocateResult {
  candidates: LocateCandidate[]
  scanned: number
  ms: number
}

const LOCATE_MAX_DEPTH = 4
const LOCATE_MAX_DIRS = 30000
const LOCATE_LIMIT = 20

export function locateFolder(name: string, children: string[]): LocateResult {
  const t0 = Date.now()
  const target = String(name ?? '').trim().toLowerCase()
  if (!target) return { candidates: [], scanned: 0, ms: 0 }
  const wanted = new Set(children.map((c) => String(c).toLowerCase()).filter(Boolean))

  const { names: skipNames, pathRes: skipPaths } = loadExcludes()
  const found: LocateCandidate[] = []
  let scanned = 0

  const stack = listRoots().map((r) => ({ dir: r.path, depth: 0 }))
  while (stack.length && scanned < LOCATE_MAX_DIRS) {
    const { dir, depth } = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 权限不足/已删除：跳过
    }
    scanned++

    const base = path.basename(dir)
    if (base.toLowerCase() === target) {
      const childSet = new Set(entries.map((e) => e.name.toLowerCase()))
      let matched = 0
      for (const w of wanted) if (childSet.has(w)) matched++
      // 有指纹时要求交集占比 ≥ 0.6（同一目录在别处也有同名子项的概率很低）
      const ratio = wanted.size ? matched / wanted.size : 1
      if (!wanted.size || ratio >= 0.6) {
        found.push({ path: dir, name: base, matched, total: entries.length })
      }
    }

    if (depth >= LOCATE_MAX_DEPTH) continue
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue
      const lower = e.name.toLowerCase()
      if (skipNames.has(lower)) continue
      const child = path.join(dir, e.name)
      if (skipPaths.some((re) => re.test(child))) continue
      stack.push({ dir: child, depth: depth + 1 })
    }
  }

  found.sort((a, b) => {
    const ra = a.total ? a.matched / a.total : 0
    const rb = b.total ? b.matched / b.total : 0
    return rb - ra || a.path.localeCompare(b.path, 'zh-Hans-CN')
  })
  return { candidates: found.slice(0, LOCATE_LIMIT), scanned, ms: Date.now() - t0 }
}
