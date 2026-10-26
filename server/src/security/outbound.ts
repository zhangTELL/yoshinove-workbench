interface SafeFetchOptions {
  fetcher?: typeof fetch
  secrets?: readonly string[]
  allowRedirect?: (from: URL, to: URL) => boolean
}

/** 只允许 TLS 或用户明确配置的环回 HTTP，防止把凭据通过远端明文 HTTP 发出。 */
export function validateOutboundUrl(input: string | URL): URL {
  const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 })
  const value = String(input)
  if (/[\u0000-\u0020\u007f]/.test(value)) throw invalid('接口地址不能包含空白或控制字符')
  let url: URL
  try { url = new URL(value) } catch { throw invalid('接口地址必须是完整的 HTTPS 地址') }
  if (url.username || url.password) throw invalid('接口地址不能包含用户名或密码，请使用凭据输入框')
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname))) {
    throw invalid('远端接口必须使用 HTTPS，本机接口可使用 localhost、127.0.0.1 或 ::1 的 HTTP 地址')
  }
  return url
}

/** 上游可能在错误或调试响应里回显凭据；界面和日志都只应收到脱敏文本。 */
export function redactSensitiveError(value: unknown, secrets: readonly string[] = []): string {
  let text = value instanceof Error ? value.message : String(value)
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const form of new Set([secret, encodeURIComponent(secret), encodeURI(secret)])) text = text.split(form).join('[已隐藏]')
  }
  return text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/([?&](?:api_?key|token|access_token|secret|corpsecret|password)=)[^\s&#"']*/gi, '$1[已隐藏]')
    .replace(/((?:authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[已隐藏]')
    .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [已隐藏]')
    .slice(0, 1000)
}

/** 调试快照不保存认证字段，也不保存上游回显的已知凭据。 */
export function redactDebugValue(value: unknown, secrets: readonly string[] = []): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (/^(?:api[_-]?key|api[_-]?secret|authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|token|password|secret)$/i.test(key)) return '[已隐藏]'
    return typeof item === 'string' ? redactSensitiveError(item, secrets) : item
  })
}

/** 手动跟随同源跳转，绝不把带凭据的请求转发给第二个来源。 */
export async function safeFetch(input: string | URL, init: RequestInit = {}, { fetcher = fetch, secrets = [], allowRedirect }: SafeFetchOptions = {}): Promise<Response> {
  let url = validateOutboundUrl(input)
  let options: RequestInit = { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(30000) }
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetcher(url, options)
      if (init.redirect === 'manual' || ![301, 302, 303, 307, 308].includes(response.status)) return response
      if (init.redirect === 'error') {
        await response.body?.cancel()
        throw new Error('接口返回了不允许的跳转')
      }
      const location = response.headers.get('location')
      if (!location) return response
      const next = validateOutboundUrl(new URL(location, url))
      if (next.origin !== url.origin && !allowRedirect?.(url, next)) {
        await response.body?.cancel()
        throw new Error('接口发生跨来源跳转，已停止发送凭据；请核对接口地址')
      }
      if (redirects === 3) {
        await response.body?.cancel()
        throw new Error('接口跳转次数过多')
      }
      await response.body?.cancel()
      const method = (options.method || 'GET').toUpperCase()
      if (([301, 302].includes(response.status) && method === 'POST') || (response.status === 303 && method !== 'HEAD')) {
        const headers = new Headers(options.headers)
        headers.delete('content-type')
        headers.delete('content-length')
        options = { ...options, method: 'GET', body: undefined, headers }
      }
      url = next
    }
    throw new Error('接口跳转次数过多')
  } catch (error) {
    throw new Error(redactSensitiveError(error, secrets))
  }
}
