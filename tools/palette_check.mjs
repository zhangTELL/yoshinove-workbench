/**
 * 主题配色数值验证（口径来自 tokens.css / 交接文档，2026-09-20 起）：
 *   · 文字类（accent-text / chart-*-text / 状态色文字族）：对 bg、surface、light-9 三处 ≥4.5:1
 *   · 色块类（状态色 / 图表系列 / 阈值色）：对最亮表面 ≥3:1
 *   · 图表 8 系列两两 RGB 欧氏距离 ≥45（色觉友好）
 *   · 阈值色 / 强调色之间也要分得开（与 accent 的距离 ≥45）
 * 用法：node tools/palette_check.mjs   （改配色改下面的 CANDIDATES 再跑）
 */

// ---- 巫女·和风（miko）候选：日本传统色 ----
const CANDIDATES = {
  bg: '#FBFAF5', // 生成り
  surface: '#F8F4E6', // 象牙
  accent: '#EB6101', // 朱
  accentText: ['#B04A00', '#A64308', '#9E3E06', '#B8470B'],
  // 色块族（≥3:1）
  success: ['#4F9D6B', '#55A173', '#4A9A66', '#58A07C'],
  warning: ['#B47E12', '#AA7A0A', '#B08114', '#AE7C10'],
  danger: ['#D0453C', '#C73E3A', '#CC4139', '#C63A34'],
  // 文字族（≥4.5:1，对 surface）
  successText: ['#35754F', '#2F6B47', '#3A7D55'],
  warningText: ['#85620C', '#7E5D0B', '#8F6A0E'],
  dangerText: ['#A8322B', '#9E2B25', '#A53029'],
  light9: { success: '#EAF3EC', warning: '#F9F4E4', danger: '#F9ECEA' },
  chart: [
    ['瑠璃', '#2A5CAA'],
    ['浅葱', '#2E8B94'],
    ['琥珀', '#B5722D'],
    ['蘇芳', '#A23B5C'],
    ['藤', '#7A64B0'],
    ['松葉', '#4E8D62'],
    ['珊瑚', '#C6547D'],
    ['鈍色', '#5E5C60'],
  ],
}

const hex = (h) => {
  const m = h.replace('#', '')
  const s = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}
const lum = ([r, g, b]) => {
  const f = (v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a, b) => {
  const [l1, l2] = [lum(hex(a)), lum(hex(b))].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
const dist = (a, b) => {
  const [x, y] = [hex(a), hex(b)]
  return Math.round(Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0)))
}
const mixWhite = (h, n) => {
  const [r, g, b] = hex(h)
  const m = (v) => Math.round(v + (255 - v) * (n / 100))
  return `#${[m(r), m(g), m(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

let fail = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${label.padEnd(46)} ${detail}`)
  if (!ok) fail++
}

console.log('== 基底 ==')
check('text 墨 on bg/surface', contrast(CANDIDATES.bg, '#2B2028') > 4.5 && contrast(CANDIDATES.surface, '#2B2028') > 4.5,
  `bg ${contrast(CANDIDATES.bg, '#2B2028').toFixed(2)} / surface ${contrast(CANDIDATES.surface, '#2B2028').toFixed(2)}`)

console.log('== accent-text（对 bg / surface / light-9 底 都要 ≥4.5）==')
const light9 = mixWhite(CANDIDATES.accent, 90)
for (const c of CANDIDATES.accentText) {
  const cs = [CANDIDATES.bg, CANDIDATES.surface, light9].map((s) => contrast(s, c))
  check(`${c}`, Math.min(...cs) >= 4.5, cs.map((v) => v.toFixed(2)).join(' / ') + `   (light-9=${light9})`)
}

console.log('== 状态色 色块族（对 surface ≥3）+ 文字族（对 surface ≥4.5）==')
for (const k of ['success', 'warning', 'danger']) {
  const block = CANDIDATES[k].map((c) => [c, contrast(CANDIDATES.surface, c)])
  check(`${k} 色块`, block.some(([, v]) => v >= 3), block.map(([c, v]) => `${c} ${v.toFixed(2)}`).join(' | '))
  const text = CANDIDATES[`${k}Text`].map((c) => [c, contrast(CANDIDATES.surface, c)])
  check(`${k}Text 文字`, text.some(([, v]) => v >= 4.5), text.map(([c, v]) => `${c} ${v.toFixed(2)}`).join(' | '))
}
console.log('   light-9 底上的文字族复核：')
for (const k of ['success', 'warning', 'danger']) {
  const best = CANDIDATES[`${k}Text`].find((c) => contrast(CANDIDATES.surface, c) >= 4.5)
  check(`${best} on ${k}-light-9`, contrast(CANDIDATES.light9[k], best) >= 4.5,
    `${CANDIDATES.light9[k]} → ${contrast(CANDIDATES.light9[k], best).toFixed(2)}`)
}

console.log('== 图表 8 系列（对 surface ≥3，两两距离 ≥45）==')
const chosen = []
for (const [name, c] of CANDIDATES.chart) {
  const ok = contrast(CANDIDATES.surface, c) >= 3
  if (ok) chosen.push([name, c])
  check(`${name} ${c}`, ok, `contrast ${contrast(CANDIDATES.surface, c).toFixed(2)}`)
}
let minPair = Infinity
let minPairNames = ''
for (let i = 0; i < chosen.length; i++)
  for (let j = i + 1; j < chosen.length; j++) {
    const d = dist(chosen[i][1], chosen[j][1])
    if (d < minPair) {
      minPair = d
      minPairNames = `${chosen[i][0]}↔${chosen[j][0]}`
    }
  }
check('两两最小距离 ≥45', minPair >= 45, `min ${minPair} (${minPairNames})`)

console.log('== 阈值色 / 状态色 与 accent 的距离（≥45）==')
const accent = CANDIDATES.accent
for (const k of ['success', 'warning', 'danger']) {
  const c = CANDIDATES[k].find((x) => contrast(CANDIDATES.surface, x) >= 3) ?? CANDIDATES[k][0]
  check(`${k} ${c} ↔ accent`, dist(c, accent) >= 45, `dist ${dist(c, accent)}`)
}

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项未通过`)
process.exit(fail === 0 ? 0 : 1)
