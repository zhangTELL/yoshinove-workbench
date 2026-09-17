/** 验证作业行解析正则 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const html = readFileSync(path.resolve(__dirname, '../../.tmp-worklist-265-final.html'), 'utf-8')

const liRe = /<li onclick="goTask\(this\);"\s+data="([^"]+)"[^>]*aria-label="([^"]*)">([\s\S]*?)<\/li>/g
let m: RegExpExecArray | null
let count = 0
while ((m = liRe.exec(html))) {
  count++
  const status = m[3].match(/class="status fl">([^<]+)</)?.[1]?.trim()
  const rel = m[3].match(/剩余\s*(?:(\d+)\s*天)?\s*(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分钟)?/)
  console.log(`#${count} 标题=${m[2].split(';')[0].trim()} 状态=${status} 剩余=${rel?.slice(1).filter(Boolean).join(':') ?? '无'}`)
}
console.log('匹配条数:', count)
// 找不匹配的原因：打印 goTask 出现处的原始片段
const i = html.indexOf('goTask')
console.log('原始片段:', html.slice(i - 30, i + 260).replace(/\s+/g, ' '))
