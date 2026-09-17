/**
 * P8-4：项目 Git 详情（分支 / 领先落后 / 最近提交 / 未提交文件）
 *
 * 只读：全部走 git 的查询类命令，不做任何写操作。
 * 所有命令都有超时 + 失败降级——git 环境异常时列表页不能因此挂掉。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { db } from '../db/index.js'
import { projects } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code })

function git(dir: string, args: string[], timeout = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { timeout, maxBuffer: 2 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 200)))
      else resolve(stdout)
    })
  })
}

export interface GitCommit {
  hash: string
  short: string
  author: string
  date: string
  subject: string
}

export interface GitDirtyFile {
  /** 暂存区状态（M/A/D/R…，'?'=未跟踪） */
  x: string
  path: string
}

export interface GitDetail {
  hasGit: boolean
  branch: string | null
  /** 领先 / 落后 upstream 的提交数（没有 upstream 时为 null） */
  ahead: number | null
  behind: number | null
  commits: GitCommit[]
  dirtyFiles: GitDirtyFile[]
  dirtyCount: number
}

export async function readGitDetail(projectId: number): Promise<GitDetail> {
  const row = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!row) throw bad('项目不存在', 404)
  const dir = row.path
  if (!existsSync(path.join(dir, '.git'))) {
    return { hasGit: false, branch: null, ahead: null, behind: null, commits: [], dirtyFiles: [], dirtyCount: 0 }
  }

  const detail: GitDetail = {
    hasGit: true,
    branch: null,
    ahead: null,
    behind: null,
    commits: [],
    dirtyFiles: [],
    dirtyCount: 0,
  }

  // 分支名（detached HEAD 时给短 hash）
  try {
    const out = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    detail.branch = out === 'HEAD' ? (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim() + '（未在分支上）' : out
  } catch {
    detail.branch = null
  }

  // 领先 / 落后（没有 upstream 时静默降级）
  try {
    const [behind, ahead] = (await git(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).trim().split(/\s+/)
    detail.behind = Number(behind) || 0
    detail.ahead = Number(ahead) || 0
  } catch {
    detail.ahead = null
    detail.behind = null
  }

  // 最近提交
  try {
    const out = await git(dir, ['log', '-n', '12', '--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s', '--date=iso'])
    detail.commits = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, short, author, date, ...rest] = line.split('\t')
        return { hash, short, author, date, subject: rest.join('\t') }
      })
  } catch {
    detail.commits = []
  }

  // 未提交文件（porcelain v1：XY <path>，重命名是 "R  old -> new"）
  try {
    const out = await git(dir, ['status', '--porcelain=v1', '--untracked-files=normal'])
    detail.dirtyFiles = out
      .split('\n')
      .filter((l) => l.length > 3)
      .map((l) => ({ x: l.slice(0, 2).trim() || '?', path: l.slice(3).trim() }))
    detail.dirtyCount = detail.dirtyFiles.length
  } catch {
    detail.dirtyFiles = []
    detail.dirtyCount = 0
  }

  return detail
}
