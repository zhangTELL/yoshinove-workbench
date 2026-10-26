/** 元数据只保留仓库定位，不保存远程 URL 中夹带的登录凭据。 */
export function sanitizeGitRemote(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:' || url.protocol === 'http:') url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|key|auth|pass|secret|signature|^sig$)/i.test(key)) url.searchParams.delete(key)
    }
    url.hash = ''
    return url.href
  } catch {
    // SCP 风格 SSH 地址没有口令字段；畸形 HTTP 地址也不能原样泄漏认证段。
    return raw.replace(/^(https?:\/\/)[^/]*@/i, '$1').replace(/([?&](?:[^=&]*(?:token|key|auth|pass|secret|signature)|sig)[^=&]*=)[^&#]*/gi, '$1[已隐藏]')
  }
}

/** 读取 Git 元信息时禁止仓库自定义 fsmonitor 与外部 diff 命令。 */
export const READ_ONLY_GIT_OPTIONS = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.hooksPath=']
