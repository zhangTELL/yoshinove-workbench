import path from 'node:path'
import { createRequire } from 'node:module'
import type { CourseCellInput, WeekParity } from '@wb/shared'

const require = createRequire(import.meta.url)

/** pdfjs-dist legacy 构建（Node 环境无 worker）；cmaps 用于解码 STSong-Light 等标准 CJK CID 字体 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfjsModule = any
let pdfjsCache: { lib: PdfjsModule; cMapUrl: string; standardFontDataUrl: string } | null = null
async function getPdfjs() {
  if (!pdfjsCache) {
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'))
    pdfjsCache = {
      lib,
      cMapUrl: path.join(pkgDir, 'cmaps') + path.sep,
      standardFontDataUrl: path.join(pkgDir, 'standard_fonts') + path.sep,
    }
  }
  return pdfjsCache
}

interface TextItem {
  str: string
  /** 显示坐标系（已处理页面旋转），x 向右、y 向下，scale=1 */
  x: number
  y: number
  fontSize: number
}

interface Line {
  y: number
  fontSize: number
  text: string
}

interface ColRange {
  idx: number
  left: number
  right: number
}

interface PageData {
  items: TextItem[]
  colRanges: ColRange[]
  tableBottom: number
}

export interface ParsedCell extends CourseCellInput {
  /** 该单元格原始文本，供校对界面比对 */
  rawText: string
}

export interface ParseResult {
  cells: ParsedCell[]
  semesterNameHint: string | null
  diagnostics: {
    pageCount: number
    columnsFound: number
    sectionRowsFound: number
    cellCount: number
    warnings: string[]
  }
}

const WEEKDAY_HEADER = ['一', '二', '三', '四', '五', '六', '日']
/** 行距阈值：本格式格内行距 12~13.5，格间最小空隙 15.5 */
const CELL_SPLIT_GAP = 14.5

export async function parseSchedulePdf(data: Uint8Array): Promise<ParseResult> {
  const { lib, cMapUrl, standardFontDataUrl } = await getPdfjs()
  const warnings: string[] = []
  let semesterNameHint: string | null = null

  const doc = await lib.getDocument({
    data,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise

  const pages: PageData[] = []
  let colRanges: ColRange[] = []
  let totalSectionRows = 0

  for (let pno = 1; pno <= doc.numPages; pno++) {
    const page = await doc.getPage(pno)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items: TextItem[] = []
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue
      const t = lib.Util.transform(viewport.transform, item.transform)
      items.push({ str: item.str, x: t[4], y: t[5], fontSize: Math.hypot(t[2], t[3]) || item.height || 10 })
    }
    const joined = items.map((i) => i.str).join('')
    const sm = joined.match(/(\d{4})\s*-\s*(\d{4})\s*(?:学年)?\s*第\s*(\d+)\s*学期/)
    if (sm && !semesterNameHint) semesterNameHint = `${sm[1]}-${sm[2]}第${sm[3]}学期`

    // ---- 表头列：星期一~星期日（续页没有表头则沿用之前的列范围）----
    const headerMap = new Map<number, number>()
    for (const it of items) {
      const m = it.str.match(/星期\s*([一二三四五六日天])/)
      if (!m) continue
      const idx = WEEKDAY_HEADER.indexOf(m[1] === '天' ? '日' : m[1])
      if (idx >= 0 && !headerMap.has(idx)) headerMap.set(idx, it.x + it.str.length * it.fontSize * 0.5)
    }
    if (headerMap.size >= 3) {
      const header = [...headerMap.entries()].map(([idx, xCenter]) => ({ idx, xCenter })).sort((a, b) => a.xCenter - b.xCenter)
      colRanges = header.map((h, i) => ({
        idx: h.idx,
        left: i === 0 ? h.xCenter - 55 : (header[i - 1].xCenter + h.xCenter) / 2,
        right: i === header.length - 1 ? h.xCenter + 55 : (h.xCenter + header[i + 1].xCenter) / 2,
      }))
    }

    // ---- 节次行锚点与表格底部（用于排除页脚）----
    const labelColRight = colRanges.length ? colRanges[0].left : 0
    const sectionAnchors = new Map<number, number>()
    for (const it of items) {
      if (it.x >= labelColRight) continue
      const t = it.str.trim()
      if (/^\d{1,2}$/.test(t)) {
        const n = parseInt(t, 10)
        if (n >= 1 && n <= 15 && !sectionAnchors.has(n)) sectionAnchors.set(n, it.y)
      }
    }
    totalSectionRows += sectionAnchors.size
    const tableBottom = sectionAnchors.size ? Math.max(...sectionAnchors.values()) + 45 : viewport.height

    pages.push({ items, colRanges, tableBottom })
  }

  if (!colRanges.length) {
    return {
      cells: [],
      semesterNameHint,
      diagnostics: { pageCount: doc.numPages, columnsFound: 0, sectionRowsFound: totalSectionRows, cellCount: 0, warnings: ['未能定位星期表头，文件可能不是课程表'] },
    }
  }
  if (totalSectionRows < 5) warnings.push(`节次行仅识别到 ${totalSectionRows} 个，解析可能不完整`)

  const labelColRight = colRanges[0].left

  // ---- 逐列独立提取行并聚单元格，随后跨页拼接 ----
  const cells: ParsedCell[] = []
  for (const col of colRanges) {
    const colCells: { page: number; lines: Line[] }[] = []
    for (const page of pages) {
      const colItems = page.items
        .filter((it) => it.x >= col.left && it.x < col.right && it.y <= page.tableBottom)
        .filter((it) => !/^星期\s*[一二三四五六日天]$/.test(it.str.trim()))
        .sort((a, b) => a.y - b.y)
      const lines: Line[] = []
      for (const it of colItems) {
        const last = lines[lines.length - 1]
        if (last && Math.abs(last.y - it.y) < Math.max(3, it.fontSize * 0.45)) {
          last.text += it.str
        } else {
          lines.push({ y: it.y, fontSize: it.fontSize, text: it.str })
        }
      }
      let bucket: Line[] = []
      for (const ln of lines) {
        const last = bucket[bucket.length - 1]
        if (last && Math.abs(ln.y - last.y) < CELL_SPLIT_GAP) bucket.push(ln)
        else {
          if (bucket.length) colCells.push({ page: pages.indexOf(page), lines: bucket })
          bucket = [ln]
        }
      }
      if (bucket.length) colCells.push({ page: pages.indexOf(page), lines: bucket })
    }

    // 跨页拼接：上一页末单元格缺"学分"字段说明被分页截断
    const mergedCells: { page: number; lines: Line[] }[] = []
    for (const cell of colCells) {
      const prev = mergedCells[mergedCells.length - 1]
      if (prev && cell.page === prev.page + 1) {
        const prevText = prev.lines.map((l) => l.text).join('')
        if (!/学分[:：]/.test(prevText)) {
          prev.lines.push(...cell.lines)
          continue
        }
      }
      mergedCells.push(cell)
    }

    for (const c of mergedCells) {
      const rawText = c.lines.map((l) => l.text.trim()).join('\n')
      const parsed = parseCellText(c.lines)
      if (parsed) cells.push({ ...parsed, weekday: col.idx + 1, rawText })
    }
  }

  // 按节次/星期排序输出
  cells.sort((a, b) => a.weekday - b.weekday || a.startSection - b.startSection)

  return {
    cells,
    semesterNameHint,
    diagnostics: {
      pageCount: doc.numPages,
      columnsFound: colRanges.length,
      sectionRowsFound: totalSectionRows,
      cellCount: cells.length,
      warnings,
    },
  }
}

/** 从单元格文本提取课程字段；无节次标记时返回 null */
function parseCellText(lines: Line[]): Omit<ParsedCell, 'weekday' | 'rawText'> | null {
  const full = lines.map((l) => l.text).join('')
  const secMatch = full.match(/\(\s*(\d{1,2})\s*-\s*(\d{1,2})\s*节\s*\)/)
  if (!secMatch) return null
  const startSection = parseInt(secMatch[1], 10)
  const endSection = parseInt(secMatch[2], 10)

  // 课程名：节次标记之前的所有 fs≈9 行（长课程名会折行）
  const nameLines: string[] = []
  for (const ln of lines) {
    if (ln.text.includes(secMatch[0])) break
    if (ln.fontSize >= 8.7) nameLines.push(ln.text)
  }
  let name = nameLines.join('').trim()
  const badge = name.match(/[★○☆△✓]+$/)?.[0] ?? ''
  name = name.replace(/[★○☆△✓]+$/, '').trim()
  if (!name || name.length > 40) return null

  // 周次：9-16周 / 3周,6周,12周 / 1-2周,4-5周（换行断开的数字已拼接）
  const weeks: number[] = []
  const weekRe = /(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*周/g
  let wm: RegExpExecArray | null
  while ((wm = weekRe.exec(full))) {
    const a = parseInt(wm[1], 10)
    const b = wm[2] ? parseInt(wm[2], 10) : a
    for (let w = a; w <= b; w++) if (w >= 1 && w <= 30 && !weeks.includes(w)) weeks.push(w)
  }

  let weekParity: WeekParity = 'all'
  if (/[(（]\s*双\s*[)）]|双周/.test(full)) weekParity = 'even'
  else if (/[(（]\s*单\s*[)）]|单周/.test(full)) weekParity = 'odd'

  const field = (label: string) => {
    const m = full.match(new RegExp(`${label}:([^/]+)`))
    return m ? m[1].trim() : ''
  }
  const room = field('场地')
  const teacher = field('教师')
  const examType = field('考核方式')
  const credit = parseFloat(field('学分')) || 0
  const classCode = full.match(/教学班:\(?\d{4}-\d{4}-\d\)?-([A-Z]{2}\d+-\d+)/)?.[1] ?? ''

  return {
    name,
    teacher,
    room,
    credit,
    examType,
    startSection,
    endSection,
    weeks,
    weekParity,
    note: [badge, classCode ? `教学班:${classCode}` : ''].filter(Boolean).join(' '),
  }
}
