/** 统一 API 客户端 */
export async function api<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(options?.headers as Record<string, string>) }
  if (options?.body) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`
    try {
      const body = await res.json()
      if (body?.message) msg = body.message
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export function get<T>(path: string): Promise<T> {
  return api<T>(path)
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) })
}

export function del<T>(path: string): Promise<T> {
  return api<T>(path, { method: 'DELETE' })
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) })
}

export async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(path, { method: 'POST', body: form })
  if (!res.ok) {
    let msg = `上传失败 (${res.status})`
    try {
      const body = await res.json()
      if (body?.message) msg = body.message
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}
