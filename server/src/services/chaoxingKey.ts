/**
 * 学习通作业的「稳定标识」。
 *
 * 为什么必须独立于 deadline/status：截止时间是从列表页的相对文本「剩余 X 天 X 小时 X 分钟」
 * 换算出来的绝对时间，提交状态也会随作业进展变化 —— 这些字段每次抓取都可能不同。
 * 一旦把它们算进幂等键（历史实现是 `course|title|deadline`），同一条作业在
 * 「上次有截止时间、这次没有（或相反）」时就会被当成新作业重复插入。
 *
 * 身份只能来自作业本身的固有属性：
 *   1. 学习通 URL 里的 workId（+ courseId）—— 同一份作业在所有抓取里都一致，最可靠；
 *   2. 退路：课程名 + 标题的归一化串（大小写、空白、全半角括号统一）。
 */

/** 归一化文本：去空白、统一括号、小写（中文相关的正则别用 \w） */
export function normText(s: string): string {
  return s
    .replace(/[\s\u3000]/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .toLowerCase()
}

/** 课程+标题的退化标识（URL 里没有 workId 时使用） */
export function textKeyOf(courseName: string, title: string): string {
  return `t:${normText(courseName)}|${normText(title)}`
}

/** 计算作业的稳定标识 */
export function workKeyOf(w: { url?: string | null; courseName: string; title: string }): string {
  const url = w.url ?? ''
  const workId = /[?&]workId=(\d+)/.exec(url)?.[1]
  const courseId = /[?&]courseId=(\d+)/.exec(url)?.[1]
  if (workId) return courseId ? `cx:${courseId}:${workId}` : `cx:w:${workId}`
  return textKeyOf(w.courseName, w.title)
}
