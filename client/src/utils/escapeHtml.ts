/**
 * HTML 转义：用户输入（笔记标题等）拼进 HTML 模板前必须过这一道。
 * 2026-10-01 审查修复 #2：笔记标题原样进 <title>/<h1>，`<svg onload=…>` 这类标题
 * 能在预览 iframe（无 sandbox）里执行脚本并摸到父页面——凡是「拼 HTML 字符串」的地方，
 * 插槽一律先 escapeHtml。
 */
const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c])
}
