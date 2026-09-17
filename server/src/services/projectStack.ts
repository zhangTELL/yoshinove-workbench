/**
 * 技术栈推断（内容级）。
 *
 * 为什么单独一个模块：**只看根目录的文件名根本不够**——
 * Vue/React 写在 `package.json` 的依赖里；Java 工程可能只有 `src/` 下的 `.java` 文件、
 * 没有 pom/gradle；C++ 工程可能只体现在 `.cpp/.h` 文件上。旧实现只拿根目录文件名去匹配
 * 少数几个固定清单名，结果就是「只有 Node.js 和 TypeScript 认得出来」。
 *
 * 三类证据互补（都只看文件**名**与小体积清单**内容**，绝不读源码正文）：
 *  ① 清单/构建文件（package.json、pom.xml、CMakeLists.txt、Cargo.toml …）—— 最权威；
 *  ② 少量清单的内容（package.json 依赖表、pom 里的 spring-boot、CMake 里的 Qt/SFML）；
 *  ③ 源码文件扩展名统计 —— 兜底（有工程只有源码、没有任何清单）。
 *
 * 只读根目录往下 `MAX_DEPTH` 层，跳过依赖/产物/IDE 目录，总量封顶，
 * 因此对每个项目的开销都是「几百次 stat」级别，可以放心对全部已登记项目重跑。
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** 不参与技术栈统计的目录：依赖、产物、缓存、IDE 元数据 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '.vs', '.gradle', '.mvn', '.settings',
  'dist', 'build', 'out', 'output', 'target', 'bin', 'obj', 'vendor', 'coverage', 'release', 'debug',
  '.next', '.nuxt', '.output', '.cache', '.parcel-cache', '.turbo', '.svelte-kit',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  'packages', 'bower_components', '.history', 'cmake-build-debug', 'cmake-build-release',
])

/** 需要「看文件名」的清单（内容无关） */
const MANIFEST_NAMES = new Set([
  'package.json', 'tsconfig.json', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'cmakelists.txt', 'cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'setup.py',
  'pipfile', 'composer.json', 'gemfile', 'pubspec.yaml', 'dockerfile', 'docker-compose.yml',
])

/**
 * 遍历深度：**Java/Kotlin/C# 的包路径天然很深**（`src/main/java/com/x/y/*.java` 就是第 5 层），
 * 只走 2 层会把这类工程整个漏掉（实测 `StudentSystem` 的源码在 `src/com/itheima/**`，
 * 深度 2 时识别结果为空）。代价用文件数/目录数双重封顶来控制，不靠浅深度。
 */
const MAX_DEPTH = 5
const MAX_FILES = 4000
const MAX_DIRS = 400
const MAX_LABELS = 6

/** 输出顺序（只影响展示次序，不影响是否命中） */
const ORDER = [
  'Vue', 'React', 'Angular', 'Svelte', 'Solid', 'Next.js', 'Nuxt', 'Electron', 'Tauri',
  'NestJS', 'Express', 'Fastify', 'Three.js', 'Vite', 'TypeScript', 'Node.js', 'Tailwind CSS',
  'Java', 'Spring Boot', 'Android', 'Kotlin', 'C#/.NET', 'C/C++', 'Qt', 'SFML',
  'Python', 'Go', 'Rust', 'PHP', 'Ruby', 'Flutter', 'Dart', 'Swift', 'Lua', 'Docker',
]

/** npm 依赖名 → 标签 */
const NPM_RULES: { dep: string; label: string }[] = [
  { dep: 'vue', label: 'Vue' },
  { dep: 'react', label: 'React' },
  { dep: '@angular/core', label: 'Angular' },
  { dep: 'svelte', label: 'Svelte' },
  { dep: 'solid-js', label: 'Solid' },
  { dep: 'next', label: 'Next.js' },
  { dep: 'nuxt', label: 'Nuxt' },
  { dep: 'electron', label: 'Electron' },
  { dep: '@tauri-apps/api', label: 'Tauri' },
  { dep: '@nestjs/core', label: 'NestJS' },
  { dep: 'express', label: 'Express' },
  { dep: 'fastify', label: 'Fastify' },
  { dep: 'three', label: 'Three.js' },
  { dep: 'vite', label: 'Vite' },
  { dep: 'typescript', label: 'TypeScript' },
  { dep: 'tailwindcss', label: 'Tailwind CSS' },
]

/** 扩展名 → 标签（兜底证据） */
const EXT_RULES: { ext: string; label: string }[] = [
  { ext: '.vue', label: 'Vue' },
  { ext: '.java', label: 'Java' },
  { ext: '.kt', label: 'Kotlin' },
  { ext: '.kts', label: 'Kotlin' },
  { ext: '.py', label: 'Python' },
  { ext: '.c', label: 'C/C++' },
  { ext: '.cc', label: 'C/C++' },
  { ext: '.cpp', label: 'C/C++' },
  { ext: '.cxx', label: 'C/C++' },
  { ext: '.h', label: 'C/C++' },
  { ext: '.hpp', label: 'C/C++' },
  { ext: '.hh', label: 'C/C++' },
  { ext: '.cs', label: 'C#/.NET' },
  { ext: '.csproj', label: 'C#/.NET' },
  // Visual Studio 的 C++ 工程文件：有它就一定是 C++ 工程
  // （注意 `.sln` / `.slnx` 是「解决方案」，里面可能装任何语言的工程，别拿来判定语言——
  //   曾因此把只有 `.vcxproj` 的 C++ 项目标成 C#/.NET）
  { ext: '.vcxproj', label: 'C/C++' },
  { ext: '.go', label: 'Go' },
  { ext: '.rs', label: 'Rust' },
  { ext: '.php', label: 'PHP' },
  { ext: '.rb', label: 'Ruby' },
  { ext: '.dart', label: 'Dart' },
  { ext: '.swift', label: 'Swift' },
  { ext: '.lua', label: 'Lua' },
]

/** 读一个小文本文件（清单都很小；读不到就返回空串） */
function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8').slice(0, 200_000)
  } catch {
    return ''
  }
}

/** 推断一个项目的技术栈标签（已排序、已去重、已截断） */
export function detectStack(dir: string): string[] {
  const extCount = new Map<string, number>()
  const manifests = new Map<string, string>() // 清单文件名（小写）→ 绝对路径（取首个）
  let fileCount = 0
  let dirCount = 0

  const walk = (cur: string, depth: number): void => {
    if (depth > MAX_DEPTH || fileCount > MAX_FILES || dirCount > MAX_DIRS) return
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      return
    }
    dirCount++
    for (const e of entries) {
      if (fileCount > MAX_FILES || dirCount > MAX_DIRS) return
      const lower = e.name.toLowerCase()
      if (e.isDirectory()) {
        if (e.isSymbolicLink() || SKIP_DIRS.has(lower)) continue
        walk(path.join(cur, e.name), depth + 1)
        continue
      }
      if (!e.isFile()) continue
      fileCount++
      const ext = path.extname(lower)
      if (ext) extCount.set(ext, (extCount.get(ext) ?? 0) + 1)
      if (MANIFEST_NAMES.has(lower) && !manifests.has(lower)) manifests.set(lower, path.join(cur, e.name))
    }
  }
  walk(dir, 0)

  const hits = new Set<string>()
  const hasManifest = (name: string) => manifests.has(name)
  const ext = (e: string) => extCount.get(e) ?? 0

  // ---------- ① JS/TS 生态：读 package.json 的依赖表 ----------
  const pkgFiles: string[] = []
  for (const [name, abs] of manifests) {
    if (name === 'package.json') pkgFiles.push(abs)
  }
  if (hasManifest('package.json')) hits.add('Node.js')
  if (hasManifest('tsconfig.json')) hits.add('TypeScript')

  const deps = new Set<string>()
  for (const p of pkgFiles) {
    try {
      const pkg = JSON.parse(readText(p) || '{}') as Record<string, Record<string, string> | undefined>
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const d of Object.keys(pkg[key] ?? {})) deps.add(d.toLowerCase())
      }
    } catch {
      /* 单个 package.json 坏了不影响其它判断 */
    }
  }
  for (const r of NPM_RULES) if (deps.has(r.dep)) hits.add(r.label)

  // ---------- ② 各语言清单 / 构建文件 ----------
  if (hasManifest('pom.xml')) {
    hits.add('Java')
    if (/spring-boot/i.test(readText(manifests.get('pom.xml')!))) hits.add('Spring Boot')
  }
  for (const g of ['build.gradle', 'build.gradle.kts']) {
    if (!hasManifest(g)) continue
    const text = readText(manifests.get(g)!)
    if (/com\.android\.application/i.test(text)) hits.add('Android')
    else hits.add('Java')
    if (/spring-boot/i.test(text)) hits.add('Spring Boot')
  }
  for (const p of ['pyproject.toml', 'requirements.txt', 'setup.py', 'pipfile']) {
    if (hasManifest(p)) hits.add('Python')
  }
  if (hasManifest('cmakelists.txt')) {
    hits.add('C/C++')
    const text = readText(manifests.get('cmakelists.txt')!)
    if (/find_package\s*\(\s*Qt/i.test(text) || /Qt\d*::/i.test(text)) hits.add('Qt')
    if (/\bSFML\b/i.test(text)) hits.add('SFML')
  }
  if (hasManifest('cargo.toml')) hits.add('Rust')
  if (hasManifest('go.mod')) hits.add('Go')
  if (hasManifest('composer.json')) hits.add('PHP')
  if (hasManifest('gemfile')) hits.add('Ruby')
  if (hasManifest('pubspec.yaml')) hits.add('Flutter')
  if (hasManifest('dockerfile') || hasManifest('docker-compose.yml')) hits.add('Docker')

  // ---------- ③ 源码扩展名兜底 ----------
  for (const r of EXT_RULES) if (ext(r.ext) > 0) hits.add(r.label)

  return [...hits]
    .sort((a, b) => {
      const ia = ORDER.indexOf(a)
      const ib = ORDER.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    .slice(0, MAX_LABELS)
}
