/**
 * HTML / SVG 预览的文档包装（AI 实验区的沙箱渲染与项目文件预览共用）
 *
 * 两个必须遵守的约束（都踩过坑）：
 *  ① **不要给 svg 叠加 `height:auto`**：在 flex 容器里会被算成 0 高 → 白屏；
 *     正确做法是给 svg 设 max-width / max-height，容器负责居中。
 *  ② 样式别写成 `html,body{display:flex}`：那会把根元素也变成 flex 容器，
 *     某些页面会出现整页错位。
 */
export function wrapPreviewDoc(code: string, opts: { padding?: number; maxHeight?: string } = {}): string {
  const pad = opts.padding ?? 16
  const maxSize = opts.maxHeight ?? 'calc(100vh - 64px)'
  // 已经是完整文档就原样交给 iframe
  if (/^\s*<(?:!doctype|html)\b/i.test(code)) return code

  const style = [
    'html,body{margin:0;background:#fff;color:#111;font-family:system-ui,sans-serif}',
    `body{padding:${pad}px}`,
  ]
  if (/^\s*<svg\b/i.test(code)) {
    style.push(`body{padding:0;display:flex;align-items:center;justify-content:center;min-height:${opts.maxHeight ?? '100vh'}}`)
    style.push(`svg{max-width:100%;max-height:${maxSize}}`)
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${style.join('')}</style></head><body>${code}</body></html>`
}
