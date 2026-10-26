/** 推送通道实现：PushPlus（微信）+ 企业微信应用消息 */
import { createHash } from 'node:crypto'
import { redactSensitiveError, safeFetch } from '../security/outbound.js'

export interface PushResult {
  ok: boolean
  detail: string
}

async function httpJson(url: string, init: RequestInit): Promise<{ status: number; body: any }> {
  const res = await safeFetch(url, { ...init, signal: AbortSignal.timeout(10000) })
  let body: any = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, body }
}

export async function sendPushPlus(token: string, title: string, content: string): Promise<PushResult> {
  if (!token) return { ok: false, detail: '未配置 PushPlus Token' }
  try {
    const { status, body } = await httpJson('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, title, content, template: 'txt' }),
    })
    if (status === 200 && body?.code === 200) return { ok: true, detail: '已推送到微信' }
    return { ok: false, detail: `PushPlus 返回 ${status}: ${redactSensitiveError(body?.msg ?? '未知错误', [token])}` }
  } catch (e) {
    return { ok: false, detail: `PushPlus 请求失败: ${redactSensitiveError(e, [token])}` }
  }
}

// 企业微信 access_token 缓存（有效期 7200s，提前失效前刷新）
let wecomToken: { value: string; expiresAt: number; configHash: string } | null = null

interface WecomConfig {
  corpId: string
  agentId: string
  secret: string
  toUser: string
}

async function getWecomToken(cfg: WecomConfig): Promise<string> {
  const configHash = createHash('sha256').update(cfg.corpId + '\0' + cfg.secret).digest('hex')
  if (wecomToken && wecomToken.configHash === configHash && wecomToken.expiresAt > Date.now()) return wecomToken.value
  const { status, body } = await httpJson(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.secret)}`,
    { method: 'GET' },
  )
  if (status !== 200 || !body?.access_token) {
    throw new Error(`获取企业微信 token 失败: ${redactSensitiveError(body?.errmsg ?? `HTTP ${status}`, [cfg.secret])}`)
  }
  wecomToken = { value: body.access_token, configHash, expiresAt: Date.now() + ((body.expires_in ?? 7200) - 300) * 1000 }
  return wecomToken.value
}

export async function sendWecom(cfg: WecomConfig, title: string, content: string): Promise<PushResult> {
  if (!cfg.corpId || !cfg.agentId || !cfg.secret) return { ok: false, detail: '未配置企业微信应用' }
  let token = ''
  try {
    token = await getWecomToken(cfg)
    const { status, body } = await httpJson(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: cfg.toUser || '@all',
        msgtype: 'text',
        agentid: Number(cfg.agentId),
        text: { content: `${title}\n${content}` },
      }),
    })
    if (status === 200 && body?.errcode === 0) return { ok: true, detail: '已推送到企业微信' }
    // token 失效则清缓存便于下次重取
    if (body?.errcode === 40014 || body?.errcode === 42001) wecomToken = null
    return { ok: false, detail: `企业微信返回 ${body?.errcode}: ${redactSensitiveError(body?.errmsg ?? '未知错误', [cfg.secret, token])}` }
  } catch (e) {
    return { ok: false, detail: `企业微信请求失败: ${redactSensitiveError(e, [cfg.secret, token])}` }
  }
}
