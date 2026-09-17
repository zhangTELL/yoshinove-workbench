#!/usr/bin/env node
/**
 * 不依赖任何第三方库，直接解析 PNG 校验透明度：
 * 解析 IHDR / IDAT → zlib 解压 → 反滤波 → 统计 alpha 分布。
 * 用途：验证 favicon 成品确实「背景透明」，而不是靠看图猜。
 *
 * 用法：node tools/icon/png_alpha_check.mjs client/public/*.png
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function decode(file) {
  const buf = readFileSync(file)
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG 文件')

  let pos = 8
  let ihdr = null
  const idat = []
  let plte = null
  let trns = null
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'PLTE') plte = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!ihdr) throw new Error('缺少 IHDR')
  if (ihdr.interlace !== 0) throw new Error('隔行扫描 PNG 暂不支持')

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType]
  if (!channels) throw new Error(`未知颜色类型 ${ihdr.colorType}`)
  const bpp = Math.ceil((channels * ihdr.bitDepth) / 8)
  const stride = Math.ceil((ihdr.width * channels * ihdr.bitDepth) / 8)
  const raw = inflateSync(Buffer.concat(idat))

  // 反滤波
  const out = Buffer.alloc(stride * ihdr.height)
  let rp = 0
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      cur[x] = v & 0xff
    }
  }
  return { ihdr, channels, bpp, stride, pixels: out, plte, trns }
}

function alphaStats(img) {
  const { ihdr, channels, bpp, stride, pixels } = img
  const total = ihdr.width * ihdr.height
  let fullyTransparent = 0
  let partial = 0
  let opaque = 0
  const sample = (x, y) => {
    const off = y * stride + x * bpp
    if (ihdr.colorType === 6) return pixels[off + 3]
    if (ihdr.colorType === 4) return pixels[off + 1]
    if (ihdr.colorType === 3) {
      const idx = pixels[off]
      return img.trns && idx < img.trns.length ? img.trns[idx] : 255
    }
    return 255 // RGB / 灰度：无 alpha 通道
  }
  for (let y = 0; y < ihdr.height; y++) {
    for (let x = 0; x < ihdr.width; x++) {
      const a = sample(x, y)
      if (a === 0) fullyTransparent++
      else if (a < 255) partial++
      else opaque++
    }
  }
  const corners = [
    [0, 0],
    [ihdr.width - 1, 0],
    [0, ihdr.height - 1],
    [ihdr.width - 1, ihdr.height - 1],
  ].map(([x, y]) => sample(x, y))
  return { total, fullyTransparent, partial, opaque, corners }
}

let failed = 0
for (const file of process.argv.slice(2)) {
  try {
    const img = decode(file)
    const s = alphaStats(img)
    const hasAlphaChannel = img.ihdr.colorType === 4 || img.ihdr.colorType === 6 || !!img.trns
    const ok = hasAlphaChannel && s.corners.every((a) => a === 0) && s.fullyTransparent > s.total * 0.3
    if (!ok) failed++
    console.log(
      `${ok ? '✅' : '❌'} ${file}\n` +
        `   ${img.ihdr.width}x${img.ihdr.height} 颜色类型=${img.ihdr.colorType} 位深=${img.ihdr.bitDepth} 通道=${img.channels} alpha通道=${hasAlphaChannel ? '有' : '无'}\n` +
        `   四角 alpha = [${s.corners.join(', ')}]  透明 ${(s.fullyTransparent / s.total * 100).toFixed(1)}% / 半透明 ${(s.partial / s.total * 100).toFixed(1)}% / 不透明 ${(s.opaque / s.total * 100).toFixed(1)}%`,
    )
  } catch (e) {
    failed++
    console.log(`❌ ${file}  解析失败: ${e.message}`)
  }
}
process.exit(failed ? 1 : 0)
