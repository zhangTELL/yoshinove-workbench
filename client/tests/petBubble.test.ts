import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectBubbleSlot } from '../../vendor/dsh-pet/src/shared/bubble-priority.js'

test('完成状态不能遮住已生成的 AI 正文', () => {
  const state = { workState: 'success', work: true, speech: true, balance: false }
  const text = { work: '对话完成', whisper: '你好，这是实际的 AI 回复。', balance: '余额', none: '' }
  assert.equal(text[selectBubbleSlot(state)], '你好，这是实际的 AI 回复。')
})

test('关闭工作状态联动仍显示回复，没有正文时仍能展示完成状态', () => {
  assert.equal(selectBubbleSlot({ workState: 'success', work: false, speech: true, balance: false }), 'whisper')
  assert.equal(selectBubbleSlot({ workState: 'success', work: true, speech: false, balance: true }), 'work')
})

test('失败状态保持优先，余额和进行中状态仍按原有规则展示', () => {
  assert.equal(selectBubbleSlot({ workState: 'error', work: true, speech: true, balance: true }), 'work')
  assert.equal(selectBubbleSlot({ workState: 'working', work: true, speech: true, balance: true }), 'whisper')
  assert.equal(selectBubbleSlot({ workState: 'working', work: true, speech: false, balance: true }), 'balance')
  assert.equal(selectBubbleSlot({ workState: 'working', work: true, speech: false, balance: false }), 'work')
  assert.equal(selectBubbleSlot({ workState: null, work: false, speech: false, balance: false }), 'none')
})
