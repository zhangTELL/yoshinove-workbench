import { validateOutboundUrl } from './outbound.js'

const AUTH_QUERY = /^(?:apikey|apisecret|accesstoken|refreshtoken|token|secret|password|corpsecret|authorization|auth|signature|credential|xamzcredential|xamzsignature|xamzsecuritytoken)$/i
const isAuthQuery = (name: string) => AUTH_QUERY.test(name.replace(/[_-]/g, ''))

export function profileAddressSecrets(value: string): string[] {
  try {
    const url = new URL(value, 'https://workbench.invalid')
    return [url.username, url.password, ...[...url.searchParams].filter(([key]) => isAuthQuery(key)).map(([, item]) => item)].filter(Boolean)
  } catch { return [] }
}

export function redactProfileAddress(value: string): string {
  if (!profileAddressSecrets(value).length) return value
  const url = new URL(value, 'https://workbench.invalid')
  url.username = ''; url.password = ''
  for (const name of [...url.searchParams.keys()]) if (isAuthQuery(name)) url.searchParams.set(name, '[已隐藏]')
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return url.href
  return (value.startsWith('/') ? url.pathname : url.pathname.slice(1)) + url.search + url.hash
}

/** 配置入口只接受不含凭据的地址；合法协议内部生成的认证查询参数不受影响。 */
export function validateProfileAddress(value: string, absolute: boolean): string {
  if (!value) return value
  if (absolute || /^[a-z][a-z\d+.-]*:/i.test(value)) validateOutboundUrl(value)
  if (/[\u0000-\u0020\u007f]/.test(value)) throw Object.assign(new Error('接口地址不能包含空白或控制字符'), { statusCode: 400 })
  if (profileAddressSecrets(value).length) throw Object.assign(new Error('接口地址中不能包含 Key、Token 或密码，请填写到凭据输入框'), { statusCode: 400 })
  return value
}
