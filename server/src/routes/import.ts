import type { FastifyPluginAsync } from 'fastify'
import { parseSchedulePdf } from '../services/pdf-parser.js'

export const importRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/import/pdf', async (req) => {
    const file = await req.file()
    if (!file) throw Object.assign(new Error('请上传 PDF 文件'), { statusCode: 400 })
    const buf = await file.toBuffer()
    if (buf.subarray(0, 5).toString() !== '%PDF-') {
      throw Object.assign(new Error('文件不是有效的 PDF'), { statusCode: 400 })
    }
    return parseSchedulePdf(new Uint8Array(buf))
  })
}
