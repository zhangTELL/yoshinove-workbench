/**
 * 「在本地应用中打开」——**仿照 deepseek-harness 的 open-in-app 实现**
 * （参考：@deepseek-ai/dsh-host-open-in-app 的 catalog / resolver / launch 三段设计）
 *
 * 三条与旧实现的关键差别（旧实现「点了打不开」的根因就在这里）：
 *  ① **启动方式**：`spawn(cmd, argv, { detached, stdio:'ignore', windowsHide:false })` +
 *     **看护窗口**（窗口内非 0 退出才算失败，窗口结束时仍在运行 = 已启动并继续运行）+ `unref()`。
 *     旧实现用 execFile 等退出码，而 IDE 这类进程会一直活着 → 判定逻辑整个反了。
 *  ② **文件资源管理器必须「直接 spawn `explorer.exe <目录>`」**（`file` 定位器 + 普通 argv 启动）。
 *     ⚠️ 别照搬上游 DSH 那条「走 OS shell 的 open verb（`Invoke-Item`）」——**在本机实测是坏的**：
 *     `Invoke-Item` / `Start-Process` 都会创建**永不显示**的窗口（Win32 查得到窗口、坐标正常，
 *     但 `IsWindowVisible=false`，截屏也看不到），用户看到的就是「点了没反应」。
 *     另外 explorer 是交棒型：交棒后立刻退出且**退出码为 1**，所以标了 `handoff`（见下）。
 *  ③ **解析与启动分离**：启动器在本机**解析一次并缓存**，点击时直接用已验证的启动器，
 *     绝不重新检测；只有启动报 ENOENT（启动器消失）时才重新解析该条目一次。
 *
 * 验证这类「原生窗口有没有出来」的功能，**不能只看接口返回的 launched**：
 * 用窗口枚举（可见性/前台）+ 真实桌面截屏验收，方法见 skill `windows-native-ui-verify`。
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code })

// ==================== 目录（编译期固定，只收 Windows 上可验证启动器的条目） ====================

type Launch = { command: string; args: string[] }

type Locator =
  | { kind: 'app-paths'; exe: string; args: string[] }
  | { kind: 'install-record'; displayNamePrefix: string; relativeLauncher: string; args: string[] }
  | { kind: 'file'; candidates: string[]; args: string[] }
  | { kind: 'scan'; root: string; namePrefix: string; relativeLauncher: string; args: string[] }
  | { kind: 'cli'; name: string; args: string[] }

interface CatalogEntry {
  id: string
  label: string
  /**
   * 该启动器是「交棒型」：启动后立刻退出，把活交给已存在的实例。
   * 这类进程的**退出码不是失败信号**（explorer.exe 交棒后固定返回 1），
   * 只有 spawn 本身失败（ENOENT 等）才算没打开。
   */
  handoff?: boolean
  locators: Locator[]
}

/** 路径占位符：与 DSH 一致（`{path}`），没有参数带它时把目录追加到 argv 末尾 */
const PATH_TOKEN = '{path}'

const CATALOG: CatalogEntry[] = [
  {
    // 文件资源管理器：**必须直接派生 explorer.exe**，不能走 shell 的 open verb。
    // 本机实测（Win11 + 本服务由后台任务拉起）：
    //   `Invoke-Item` / `Start-Process`（都走 ShellExecute）→ 窗口进程被创建但窗口**永不显示**
    //   （Win32 查到 CabinetWClass 存在、坐标正常，但 IsWindowVisible=false；截屏也确认桌面上没有）。
    //   直接 spawn `explorer.exe <目录>` → 窗口正常显示且被激活到前台。
    // 另：explorer.exe 交棒后**立刻退出且退出码为 1**，所以它的退出码不能当失败信号（handoff）。
    id: 'explorer',
    label: '文件资源管理器',
    handoff: true,
    locators: [{ kind: 'file', candidates: ['${SystemRoot}/explorer.exe'], args: [] }],
  },
  {
    id: 'vscode',
    label: 'VS Code',
    locators: [
      { kind: 'app-paths', exe: 'Code.exe', args: [] },
      { kind: 'install-record', displayNamePrefix: 'Microsoft Visual Studio Code', relativeLauncher: 'Code.exe', args: [] },
      { kind: 'file', candidates: ['${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe', '${ProgramFiles}/Microsoft VS Code/Code.exe'], args: [] },
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    locators: [
      { kind: 'app-paths', exe: 'Cursor.exe', args: [] },
      { kind: 'install-record', displayNamePrefix: 'Cursor', relativeLauncher: 'Cursor.exe', args: [] },
      { kind: 'file', candidates: ['${LOCALAPPDATA}/Programs/cursor/Cursor.exe'], args: [] },
    ],
  },
  {
    id: 'intellij',
    label: 'IntelliJ IDEA',
    locators: [
      { kind: 'scan', root: '${ProgramFiles}/JetBrains', namePrefix: 'IntelliJ IDEA', relativeLauncher: 'bin/idea64.exe', args: [] },
      { kind: 'install-record', displayNamePrefix: 'IntelliJ IDEA', relativeLauncher: 'bin/idea64.exe', args: [] },
    ],
  },
  {
    id: 'pycharm',
    label: 'PyCharm',
    locators: [
      { kind: 'scan', root: '${ProgramFiles}/JetBrains', namePrefix: 'PyCharm', relativeLauncher: 'bin/pycharm64.exe', args: [] },
      { kind: 'install-record', displayNamePrefix: 'PyCharm', relativeLauncher: 'bin/pycharm64.exe', args: [] },
    ],
  },
  {
    id: 'webstorm',
    label: 'WebStorm',
    locators: [
      { kind: 'scan', root: '${ProgramFiles}/JetBrains', namePrefix: 'WebStorm', relativeLauncher: 'bin/webstorm64.exe', args: [] },
      { kind: 'install-record', displayNamePrefix: 'WebStorm', relativeLauncher: 'bin/webstorm64.exe', args: [] },
    ],
  },
  {
    id: 'sublimetext',
    label: 'Sublime Text',
    locators: [
      { kind: 'app-paths', exe: 'sublime_text.exe', args: [] },
      { kind: 'install-record', displayNamePrefix: 'Sublime Text', relativeLauncher: 'sublime_text.exe', args: [] },
      { kind: 'file', candidates: ['${ProgramFiles}/Sublime Text/sublime_text.exe'], args: [] },
    ],
  },
  {
    id: 'gitbash',
    label: 'Git Bash',
    locators: [
      { kind: 'install-record', displayNamePrefix: 'Git version', relativeLauncher: 'git-bash.exe', args: [`--cd=${PATH_TOKEN}`] },
      { kind: 'file', candidates: ['${ProgramFiles}/Git/git-bash.exe'], args: [`--cd=${PATH_TOKEN}`] },
    ],
  },
  {
    id: 'windowsterminal',
    label: 'Windows Terminal',
    locators: [{ kind: 'cli', name: 'wt', args: ['-d'] }],
  },
]

// ==================== 环境与候选展开 ====================

/**
 * 启动前清理继承来的凭据变量（对齐 DSH 的 scrubbedParentEnv）：
 * 本应用自己带着一堆 API Key，不应该把它们传给被打开的应用。
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/key|secret|token|password|passwd|credential/i.test(k)) continue
    out[k] = v
  }
  return out
}

/** 展开 `${VAR}` 模板；有未定义变量时返回 null（与 DSH 一致，不猜路径） */
function expandCandidate(tpl: string): string | null {
  let unset = false
  const expanded = tpl.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
    const v = process.env[name]
    if (v === undefined) {
      unset = true
      return ''
    }
    return v
  })
  return unset ? null : expanded.replace(/\//g, path.sep)
}

/** 展开注册表值里的 `%VAR%`；有未定义变量返回 null */
function expandRegistryValue(value: string): string | null {
  let unset = false
  const expanded = value.replace(/%([^%]+)%/g, (_m, name: string) => {
    const v = process.env[name]
    if (v === undefined) {
      unset = true
      return ''
    }
    return v
  })
  return unset ? null : expanded
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 进程内解析 PATH 名字（PATH/PATHEXT stat，不经 shell、不用 which） */
function resolveExecutable(name: string): string | null {
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  const hasExt = /\.[a-z0-9]+$/i.test(name)
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const base = path.join(dir, name)
    if (hasExt) {
      if (isFile(base)) return base
      continue
    }
    for (const ext of exts) {
      const withExt = base + ext.toLowerCase()
      if (isFile(withExt)) return withExt
      const upper = base + ext.toUpperCase()
      if (isFile(upper)) return upper
    }
  }
  return null
}

// ==================== Windows 注册表（App Paths + Uninstall 记录） ====================

const APP_PATHS_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
]
const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

interface InstallRecord {
  displayName: string
  installLocation?: string
  displayIcon?: string
}

interface RegistryView {
  /** 小写 exe 名 → 绝对路径 */
  appPaths: Map<string, string>
  installRecords: InstallRecord[]
}

/**
 * 解析 `reg.exe query <root> /s` 的输出。
 * 值列用 `REG_SZ`/`REG_EXPAND_SZ` 类型标记识别，而不是默认值标记——后者会随系统语言本地化
 * （中文系统是 `(默认)`，英文是 `(Default)`）。
 */
function parseRegistryDump(dump: string): Map<string, Map<string, string>> {
  const keys = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const line of dump.split(/\r?\n/)) {
    if (/^HK/.test(line)) {
      current = new Map()
      keys.set(line.trim(), current)
      continue
    }
    const m = /^\s+(.*?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line)
    if (!m || !current) continue
    const name = /^\(.*\)$/.test(m[1]) ? '(Default)' : m[1]
    current.set(name, m[3].trim())
  }
  return keys
}

function regQuery(root: string, timeout = 10000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', root, '/s'], { timeout, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => {
      resolve(err ? null : stdout) // 根不存在/无权限：这个根不贡献任何条目
    })
  })
}

/** 一趟解析里只读一次注册表 */
async function readRegistryView(): Promise<RegistryView> {
  const appPaths = new Map<string, string>()
  const installRecords: InstallRecord[] = []

  for (const root of APP_PATHS_ROOTS) {
    const dump = await regQuery(root)
    if (!dump) continue
    for (const [key, values] of parseRegistryDump(dump)) {
      const exe = key.slice(key.lastIndexOf('\\') + 1).toLowerCase()
      const target = values.get('(Default)')
      if (!exe.endsWith('.exe') || target === undefined || appPaths.has(exe)) continue
      const expanded = expandRegistryValue(target.replace(/^"|"$/g, ''))
      if (expanded !== null) appPaths.set(exe, expanded)
    }
  }

  for (const root of UNINSTALL_ROOTS) {
    const dump = await regQuery(root)
    if (!dump) continue
    for (const values of parseRegistryDump(dump).values()) {
      const displayName = values.get('DisplayName')
      if (displayName === undefined) continue
      installRecords.push({
        displayName,
        installLocation: values.get('InstallLocation'),
        displayIcon: values.get('DisplayIcon'),
      })
    }
  }

  return { appPaths, installRecords }
}

/** Uninstall 记录能证明存在的启动器（证明不了就当没有） */
function recordLauncher(record: InstallRecord, relativeLauncher: string): string | null {
  if (record.installLocation) {
    const base = expandRegistryValue(record.installLocation.replace(/^"|"$/g, ''))
    if (base !== null) {
      const candidate = path.join(base, relativeLauncher.replace(/\//g, path.sep))
      if (isFile(candidate)) return candidate
    }
  }
  if (record.displayIcon) {
    // DisplayIcon 可能是 `C:\x\app.exe,0` 或带引号
    const cleaned = expandRegistryValue(record.displayIcon.replace(/,-?\d+$/, '').replace(/^"|"$/g, '').trim())
    if (cleaned !== null && cleaned.toLowerCase().endsWith('.exe') && isFile(cleaned)) return cleaned
  }
  return null
}

/** JetBrains 这类「版本化安装目录」：取版本号最大的那个 */
function newestVersionedDir(root: string, namePrefix: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  const matched = entries
    .filter((n) => n.toLowerCase().startsWith(namePrefix.toLowerCase()))
    .map((n) => ({ name: n, version: (n.match(/\d+(\.\d+)*/)?.[0] ?? '').split('.').map(Number) }))
    .filter((e) => e.version.length > 0)
  if (!matched.length) return null
  matched.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const d = (b.version[i] ?? 0) - (a.version[i] ?? 0)
      if (d !== 0) return d
    }
    return a.name.localeCompare(b.name)
  })
  return path.join(root, matched[0].name)
}

// ==================== 解析 ====================

export interface ResolvedApp {
  id: string
  label: string
  /** 用于提取真实图标的可执行文件（提取不到就为 null，前端用占位字形） */
  iconSource: string | null
  /** 交棒型启动器（见 CatalogEntry.handoff） */
  handoff: boolean
  _launch: Launch
}

async function resolveLocator(loc: Locator, view: RegistryView): Promise<{ launch: Launch; iconSource: string | null } | null> {
  switch (loc.kind) {
    case 'app-paths': {
      const hit = view.appPaths.get(loc.exe.toLowerCase())
      if (!hit || !isFile(hit)) return null
      return { launch: { command: hit, args: loc.args }, iconSource: hit }
    }
    case 'install-record': {
      const prefix = loc.displayNamePrefix.toLowerCase()
      for (const rec of view.installRecords) {
        if (!rec.displayName.toLowerCase().startsWith(prefix)) continue
        const exe = recordLauncher(rec, loc.relativeLauncher)
        if (exe) return { launch: { command: exe, args: loc.args }, iconSource: exe }
      }
      return null
    }
    case 'file': {
      for (const tpl of loc.candidates) {
        const p = expandCandidate(tpl)
        if (p && isFile(p)) return { launch: { command: p, args: loc.args }, iconSource: p }
      }
      return null
    }
    case 'scan': {
      const root = expandCandidate(loc.root)
      if (!root) return null
      const dir = newestVersionedDir(root, loc.namePrefix)
      if (!dir) return null
      const exe = path.join(dir, loc.relativeLauncher.replace(/\//g, path.sep))
      if (!isFile(exe)) return null
      return { launch: { command: exe, args: loc.args }, iconSource: exe }
    }
    case 'cli': {
      const exe = resolveExecutable(loc.name)
      if (!exe) return null
      return { launch: { command: exe, args: loc.args }, iconSource: exe }
    }
    default:
      return null
  }
}

let cache: Promise<Map<string, ResolvedApp>> | null = null

/** 整趟解析（每进程一次，首个需要的请求触发；已安装的新应用要重启后出现） */
async function resolveAll(): Promise<Map<string, ResolvedApp>> {
  const map = new Map<string, ResolvedApp>()
  if (process.platform !== 'win32') return map // 本版本只做 Windows
  const view = await readRegistryView()
  for (const entry of CATALOG) {
    for (const loc of entry.locators) {
      const hit = await resolveLocator(loc, view)
      if (hit) {
        map.set(entry.id, { id: entry.id, label: entry.label, iconSource: hit.iconSource, handoff: entry.handoff ?? false, _launch: hit.launch })
        break
      }
    }
  }
  return map
}

function resolvedApps(): Promise<Map<string, ResolvedApp>> {
  cache ??= resolveAll()
  return cache
}

/** 该条目只重新解析一次（启动器消失时自愈用） */
async function reResolveOne(id: string): Promise<void> {
  const map = await resolvedApps()
  const entry = CATALOG.find((c) => c.id === id)
  map.delete(id)
  if (!entry) return
  const view = await readRegistryView()
  for (const loc of entry.locators) {
    const hit = await resolveLocator(loc, view)
    if (hit) {
      map.set(entry.id, { id: entry.id, label: entry.label, iconSource: hit.iconSource, handoff: entry.handoff ?? false, _launch: hit.launch })
      return
    }
  }
}

export interface AppSummary {
  id: string
  label: string
  available: boolean
}

export async function listApps(): Promise<AppSummary[]> {
  const map = await resolvedApps()
  // 菜单顺序 = 目录顺序，且只列出本机验证到启动器的条目（DSH：只显示主机能验证的条目）
  return CATALOG.filter((c) => map.has(c.id)).map((c) => ({ id: c.id, label: map.get(c.id)!.label, available: true }))
}

// ==================== 启动 ====================

/** 把目录塞进 argv：有 `{path}` 就替换，否则追加（与 DSH 一致） */
function launchArgs(args: string[], target: string): string[] {
  return args.some((a) => a.includes(PATH_TOKEN)) ? args.map((a) => a.replaceAll(PATH_TOKEN, target)) : [...args, target]
}

/**
 * detached 派生一个启动器（对齐 DSH 的 launchDetachedApp）：
 * 子进程拿到清理过凭据的环境、不持有 stdio 管道、活得比本进程久；
 * Windows GUI 保持可见（windowsHide 不设）。
 * 「启动成功」与「进程退出」解耦——IDE 会一直活着，所以只在看护窗口内失败才算失败。
 *
 * `handoff` = 交棒型启动器（explorer.exe 这类，交棒后立刻退出且退出码为 1）：
 * 它的退出码不表示结果，因此**只有 spawn 失败才算失败**。
 */
function launchDetached(
  command: string,
  args: string[],
  watchMs: number,
  handoff = false,
): Promise<'launched' | 'missing' | 'failed'> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env: scrubbedEnv(),
      })
    } catch (e) {
      resolve((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed')
      return
    }
    const settle = (r: 'launched' | 'missing' | 'failed') => {
      if (settled) return
      settled = true
      clearTimeout(watch)
      child.unref()
      resolve(r)
    }
    const watch = setTimeout(() => settle('launched'), watchMs)
    child.on('error', (e) => settle((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed'))
    child.on('exit', (code) => settle(code === 0 || handoff ? 'launched' : 'failed'))
  })
}

export type LaunchOutcome = 'launched' | 'missing' | 'failed'

const WATCH_MS = 1200

/** 在某个应用中打开一个目录 */
export async function openInApp(appId: string, target: string): Promise<{ outcome: LaunchOutcome; label: string }> {
  if (!isDir(target)) throw bad('这个目录不存在或不是一个文件夹')
  const map = await resolvedApps()
  let app = map.get(appId)
  if (!app) {
    // 可能是启动器刚被卸载：重新解析一次该条目
    await reResolveOne(appId)
    app = map.get(appId)
  }
  if (!app) throw bad('这个应用现在不可用（可能已被卸载），刷新页面看看最新列表', 409)

  const run = () =>
    launchDetached(
      app!._launch.command,
      launchArgs(app!._launch.args, target),
      WATCH_MS,
      app!.handoff,
    )

  let outcome = await run()
  if (outcome === 'missing') {
    // 启动器消失 → 重新解析该条目一次（对齐 DSH：卸载方向立即自愈）
    await reResolveOne(appId)
    const again = map.get(appId)
    if (!again) throw bad('这个应用已经不在本机了，已从列表移除', 409)
    app = again
    outcome = await run()
  }
  return { outcome, label: app.label }
}

// ==================== 应用图标（真实图标，Windows：ExtractAssociatedIcon） ====================

const EXTRACT_ICON_PS1 = [
  'param([string]$Source, [string]$Target)',
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Drawing',
  '$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Source)',
  'if ($null -eq $icon) { exit 1 }',
  '$bitmap = $icon.ToBitmap()',
  '$bitmap.Save($Target, [System.Drawing.Imaging.ImageFormat]::Png)',
  '',
].join('\n')

const iconCache = new Map<string, Buffer | null>()

/**
 * 提取某个应用的真实图标（PNG）。
 * 脚本写进临时文件后用 `-File` + 位置参数调用，路径不经过命令行解析（对齐 DSH 的做法）。
 * 提取不到返回 null，前端渲染通用占位字形。
 */
export async function appIcon(appId: string): Promise<Buffer | null> {
  if (iconCache.has(appId)) return iconCache.get(appId)!
  const map = await resolvedApps()
  const app = map.get(appId)
  const source = app?.iconSource ?? null
  if (!source || !isFile(source)) {
    iconCache.set(appId, null)
    return null
  }
  const buf = await new Promise<Buffer | null>((resolve) => {
    let dir: string | null = null
    try {
      dir = mkdtempSync(path.join(os.tmpdir(), 'wb-open-in-app-'))
      const script = path.join(dir, 'extract-icon.ps1')
      const out = path.join(dir, 'icon.png')
      writeFileSync(script, EXTRACT_ICON_PS1, 'utf8')
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, source, out],
        { timeout: 10000, windowsHide: true },
        (err) => {
          if (err) {
            resolve(null)
          } else {
            try {
              resolve(readFileSync(out))
            } catch {
              resolve(null)
            }
          }
          if (dir) {
            try {
              rmSync(dir, { recursive: true, force: true })
            } catch {
              /* 临时目录清理失败无所谓 */
            }
          }
        },
      )
    } catch {
      resolve(null)
    }
  })
  iconCache.set(appId, buf)
  return buf
}
