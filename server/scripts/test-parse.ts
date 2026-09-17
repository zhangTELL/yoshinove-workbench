/** 独立验证脚本：pnpm --filter server test:parse [pdf路径] */
import { readFileSync } from 'node:fs'
import { parseSchedulePdf } from '../src/services/pdf-parser.js'

const file = process.argv[2] || '../张特奥(2026-2027-1)课表.pdf'
const data = new Uint8Array(readFileSync(file))
const result = await parseSchedulePdf(data)
console.log('学期提示:', result.semesterNameHint)
console.log('诊断:', JSON.stringify(result.diagnostics, null, 2))
console.log(`解析出 ${result.cells.length} 个课程安排：`)
for (const c of result.cells) {
  console.log(
    `周${c.weekday} 第${c.startSection}-${c.endSection}节 | ${c.name} | ${c.teacher} | ${c.room} | 学分${c.credit} | ${c.examType} | 周[${c.weeks.join(',')}]${c.weekParity !== 'all' ? c.weekParity : ''}`,
  )
  console.log('  raw:', JSON.stringify(c.rawText))
}
