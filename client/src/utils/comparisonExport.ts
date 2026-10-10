import { normalizeComparisonCode } from '@wb/shared'
import type { ComparisonInput } from '@wb/shared'
import { escapeHtml } from './escapeHtml'
import { wrapComparisonPreview } from './previewDoc'

/** 只导出当前勾选的作品；正文与作品文档分别转义，作品脚本只在隔离 iframe 内运行。 */
export function buildComparisonHtml(topic: ComparisonInput, selectedIds: readonly string[]): { html: string; fileName: string } {
  const selected = new Set(selectedIds)
  const entries = topic.entries.filter((entry) => selected.has(entry.id)).map((entry, index) => {
    try { return { ...entry, name: entry.name.trim() || `模型 ${index + 1}`, ...normalizeComparisonCode(entry.code) } }
    catch (e) { throw new Error(`${entry.name || `模型 ${index + 1}`}：${(e as Error).message}`) }
  })
  if (!entries.length) throw new Error('请先勾选要导出的模型')
  if (!entries.some((entry) => entry.code)) throw new Error('请先为勾选的模型添加 SVG 或 HTML 作品')

  const name = topic.name.trim() || '未命名对比主题'
  const fileName = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120).replace(/[. ]+$/, '') || '模型作品'}-模型对比.html`
  const documents = entries.map((entry) => wrapComparisonPreview(entry.code))
  // script 原始文本区不会做 HTML 实体解码，转义 < 防止作品中的 </script> 提前结束数据块。
  const data = JSON.stringify(documents).replace(/</g, '\\u003c')
  const cards = entries.map((entry, index) => `
    <article class="model-card">
      <header><h2>${escapeHtml(entry.name)}</h2>${entry.code ? `<span class="format">${entry.format.toUpperCase()}</span>` : ''}</header>
      ${entry.fileName ? `<p class="source">${escapeHtml(entry.fileName)}</p>` : ''}
      ${entry.code ? `<div class="preview-slot" data-preview="${index}" data-title="${escapeHtml(entry.name)} 的作品预览"></div>` : '<div class="placeholder">暂未添加作品</div>'}
    </article>`).join('')

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} · 模型作品对比</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#faf8f5;color:#302d29;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif}
main{max-width:1680px;margin:0 auto;padding:28px}
.page-head{margin-bottom:22px}
h1{margin:0 0 8px;font-size:26px;overflow-wrap:anywhere}
.meta{margin:0;color:#80786f;font-size:13px}
details{margin-bottom:20px;padding:14px 16px;background:#fff;border:1px solid #e9e3dc;border-radius:10px}
summary{cursor:pointer;font-size:14px}
pre{margin:12px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px;line-height:1.7}
.gallery{overflow-x:auto;padding-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(${Math.min(3, entries.length)},minmax(280px,1fr));gap:16px}
.model-card{min-width:0;overflow:hidden;background:#fff;border:1px solid #e9e3dc;border-radius:10px}
.model-card header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px;border-bottom:1px solid #eee8e2}
h2{margin:0;font-size:16px;overflow-wrap:anywhere}
.format{flex-shrink:0;border:1px solid #edd5c9;border-radius:5px;color:#b46443;padding:2px 6px;font-size:11px}
.source{margin:0;padding:8px 16px;color:#80786f;font-size:12px;overflow-wrap:anywhere}
.preview-slot,.placeholder{height:460px;background:#fff}
.preview-slot iframe{display:block;width:100%;height:100%;border:0;background:#fff}
.placeholder{display:flex;align-items:center;justify-content:center;color:#80786f}
noscript{display:block;margin:18px 0;color:#9b492c}
@media(max-width:600px){main{padding:16px}h1{font-size:22px}}
</style>
</head>
<body>
<main>
  <header class="page-head"><h1>${escapeHtml(name)}</h1><p class="meta">${entries.length} 个模型 · 模型作品对比</p></header>
  ${topic.prompt.trim() ? `<details><summary>共同提示词</summary><pre>${escapeHtml(topic.prompt)}</pre></details>` : ''}
  <div class="gallery"><div class="grid">${cards}
  </div></div>
  <noscript>请启用浏览器 JavaScript 以查看作品预览。</noscript>
</main>
<script id="comparison-documents" type="application/json">${data}</script>
<script>
const documents = JSON.parse(document.getElementById('comparison-documents').textContent);
const slots = document.querySelectorAll('[data-preview]');
function syncPreviews() {
  for (const slot of slots) {
    if (document.visibilityState !== 'visible') {
      slot.replaceChildren();
      continue;
    }
    if (slot.firstChild) continue;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.title = slot.dataset.title;
    frame.srcdoc = documents[Number(slot.dataset.preview)];
    slot.appendChild(frame);
  }
}
document.addEventListener('visibilitychange', syncPreviews);
syncPreviews();
</script>
</body>
</html>`
  return { html, fileName }
}
