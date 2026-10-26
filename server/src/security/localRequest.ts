import type { FastifyInstance } from 'fastify'

interface LocalRequestOptions {
  apiPort: number
  webPort?: number
}

/** Origin 不能防住没有 Origin 的同源 GET，Host 也必须限定为本机入口。 */
export function registerLocalRequestGuard(app: FastifyInstance, { apiPort, webPort = 5173 }: LocalRequestOptions) {
  if (![apiPort, webPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) throw new Error('工作台端口配置无效')
  const hosts = new Set(['127.0.0.1', 'localhost'].map(host => `${host}:${apiPort}`))
  if (apiPort === 80) { hosts.add('127.0.0.1'); hosts.add('localhost') }
  const origins = new Set(['127.0.0.1', 'localhost'].map(host => new URL(`http://${host}:${webPort}`).origin))
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host
    if (typeof host !== 'string' || !hosts.has(host.toLowerCase())) {
      return reply.code(403).send({ message: '不允许此主机访问本地接口' })
    }
    // 全锁笔记 iframe 使用不透明来源，只放行已匹配的只读图片/主题路由。
    const staticAsset = (request.method === 'GET' || request.method === 'HEAD') && ['/uploads/:name', '/themes/:file'].includes(request.routeOptions.url ?? '')
    const origin = request.headers.origin
    if (origin !== undefined && !origins.has(origin) && !(staticAsset && origin === 'null')) {
      return reply.code(403).send({ message: '不允许此来源访问本地接口' })
    }
    if (request.headers['sec-fetch-site'] === 'cross-site' && !staticAsset) {
      return reply.code(403).send({ message: '不允许跨站访问本地接口' })
    }
  })
  return origins
}
