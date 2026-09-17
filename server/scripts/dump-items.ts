/** 调试：dump 全部文本项与检测到的网格结构 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
async function main() {
  const lib: any = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'))
  const data = new Uint8Array(readFileSync(process.argv[2] || '../张特奥(2026-2027-1)课表.pdf'))
  const doc = await lib.getDocument({
    data,
    cMapUrl: path.join(pkgDir, 'cmaps') + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(pkgDir, 'standard_fonts') + path.sep,
    useSystemFonts: false,
  }).promise

  for (let pno = 1; pno <= doc.numPages; pno++) {
    const page = await doc.getPage(pno)
    const viewport = page.getViewport({ scale: 1 })
    console.log(`===== PAGE ${pno} viewport=${JSON.stringify(viewport.viewBox)} rotate=${page.rotate}`)
    const content = await page.getTextContent()
    const items: any[] = []
    for (const item of content.items) {
      if (!item.str?.trim()) continue
      const t = lib.Util.transform(viewport.transform, item.transform)
      items.push({ x: t[4], y: t[5], fs: +Math.hypot(t[2], t[3]).toFixed(1), str: item.str })
    }
    items.sort((a, b) => a.y - b.y || a.x - b.x)
    for (const it of items) console.log(`y=${it.y.toFixed(1).padStart(7)} x=${it.x.toFixed(1).padStart(7)} fs=${it.fs} | ${it.str}`)
  }
}
main()
