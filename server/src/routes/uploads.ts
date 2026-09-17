import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyPluginAsync } from 'fastify'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const uploadsDir = path.resolve(__dirname, '../../data/uploads')
mkdirSync(uploadsDir, { recursive: true })

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  // 上传图片（课表背景等），返回可访问的 url
  app.post('/api/upload/image', async (req) => {
    const file = await req.file()
    if (!file) throw Object.assign(new Error('请选择图片文件'), { statusCode: 400 })
    const ext = EXT_BY_MIME[file.mimetype]
    if (!ext) throw Object.assign(new Error('仅支持 png/jpg/webp/gif 图片'), { statusCode: 400 })
    const buf = await file.toBuffer()
    if (buf.length > 10 * 1024 * 1024) throw Object.assign(new Error('图片不能超过 10MB'), { statusCode: 400 })
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(uploadsDir, name), buf)
    return { url: `/uploads/${name}` }
  })

  // 静态访问上传的图片
  app.get('/uploads/:name', async (req, reply) => {
    const { name } = req.params as { name: string }
    if (!/^[\w.-]+$/.test(name)) throw Object.assign(new Error('非法路径'), { statusCode: 400 })
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const mime = MIME_BY_EXT[ext]
    if (!mime) throw Object.assign(new Error('不支持的文件类型'), { statusCode: 404 })
    const { readFile } = await import('node:fs/promises')
    try {
      const buf = await readFile(path.join(uploadsDir, name))
      reply.type(mime).send(buf)
    } catch {
      throw Object.assign(new Error('文件不存在'), { statusCode: 404 })
    }
  })
}
