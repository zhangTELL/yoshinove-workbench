import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ComparisonInput } from '@wb/shared'
import { buildComparisonHtml } from '../src/utils/comparisonExport'

function input(): ComparisonInput {
  return { name: '鹈鹕骑自行车测试', prompt: '生成 SVG 或独立 HTML。', entries: [
    { id: 'svg', name: 'SVG 模型', format: 'svg', fileName: '作品.svg', code: '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="30" /></svg>' },
    { id: 'html', name: 'HTML 模型', format: 'html', fileName: '', code: '<!doctype html><html><body><button onclick="this.textContent=\'已点击\'">点击</button><script>window.fixture=1;</script></body></html>' },
    { id: 'hidden', name: '未选中的模型', format: 'html', fileName: '', code: '<main>不应出现在导出文件里的作品</main>' },
  ] }
}

function documents(html: string): string[] {
  const data = html.match(/<script id="comparison-documents" type="application\/json">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(data)
  return JSON.parse(data) as string[]
}

test('只包含勾选的模型，SVG 包装与 HTML 交互代码完整保留', () => {
  const topic = input()
  const exported = buildComparisonHtml(topic, ['svg', 'html'])
  assert.equal(exported.fileName, '鹈鹕骑自行车测试-模型对比.html')
  assert.equal(documents(exported.html).length, 2)
  assert.match(documents(exported.html)[0], /<svg/)
  assert.doesNotMatch(documents(exported.html)[0], /<\?xml/)
  assert.equal(documents(exported.html)[1], topic.entries[1].code)
  assert.doesNotMatch(exported.html, /不应出现在导出文件里的作品|未选中的模型/)
})

test('标题和提示词不能注入外层 HTML，作品脚本结束标签不会截断数据块', () => {
  const topic = input()
  topic.name = '<script>window.nameInjected=1</script>'
  topic.prompt = '</pre><script>window.promptInjected=1</script>'
  topic.entries[0].name = '"><script>window.modelInjected=1</script>'
  const { html, fileName } = buildComparisonHtml(topic, ['svg', 'html'])
  assert.match(html, /&lt;script&gt;window.nameInjected=1&lt;\/script&gt;/)
  assert.match(html, /&lt;\/pre&gt;&lt;script&gt;window.promptInjected=1&lt;\/script&gt;/)
  assert.equal((html.match(/<script\b/g) ?? []).length, 2)
  assert.match(documents(html)[1], /<script>window.fixture=1;<\/script>/)
  assert.doesNotMatch(fileName, /[<>:"/\\|?*]/)
})

test('导出最新草稿并支持一个模型，不修改输入数据', () => {
  const topic = input()
  topic.entries[1].code = '模型回复\n```html\n<main>尚未保存的新版本</main>\n```'
  const before = JSON.stringify(topic)
  const { html } = buildComparisonHtml(topic, ['html'])
  assert.equal(documents(html).length, 1)
  assert.match(documents(html)[0], /尚未保存的新版本/)
  assert.equal(JSON.stringify(topic), before)
})

test('没有选中作品或选中的作品全为空时给出明确错误，空槽位可随已完成作品一起导出', () => {
  const topic = input()
  assert.throws(() => buildComparisonHtml(topic, []), /请先勾选/)
  topic.entries[1].code = ''
  assert.throws(() => buildComparisonHtml(topic, ['html']), /请先为勾选/)
  const { html } = buildComparisonHtml(topic, ['svg', 'html'])
  assert.match(html, /暂未添加作品/)
  assert.equal(documents(html)[1], '')
})
