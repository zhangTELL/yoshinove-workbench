import { useState, useEffect, useRef, useCallback } from 'react'
import { jsx as h } from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { makePetUI } from '../../vendor/dsh-pet/src/client/pet.ts'
import { makePetConfigSection, zh } from '../../vendor/dsh-pet/src/client/settings.ts'
import { initNotify } from '../../vendor/dsh-pet/src/client/notify.ts'

const hooks = { h, useState, useEffect, useRef, useCallback }
const dictionary = {
  ...zh, nav: '桌宠配置',
  workStatusEnabledHint: '跟随工作台 AI 的思考、处理、待确认、完成和出错状态切换动画。',
  modelHint: '对话和碎碎念均使用侧栏中配置的 DeepSeek V4.1 Flash；历史条数控制桌宠每次对话携带的记忆。',
  modelFollow: 'DeepSeek V4.1 Flash（工作台）',
  modelFieldHint: '模型固定为 DeepSeek V4.1 Flash，Key 在工作台 AI 侧栏填写。',
  'storage.package': '桌宠程序（随工作台提供，无需单独安装或卸载）',
  uninstallTitle: '停用与数据管理',
  uninstallStep1: '1. 将显示位置改为「都不显示」并保存，即可停用桌宠。',
  uninstallStep2: '2. 要清理数据时，先停止工作台后端，再备份或删除自己的桌宠数据目录。',
  uninstallCmd: '桌宠数据与工作台数据库分开保存。',
}
const t = key => dictionary[key] ?? key
const PetOverlay = makePetUI(hooks)
const PetSettings = makePetConfigSection({ ...hooks, t })
export function mountPet(element, settings = false) {
  const root = createRoot(element)
  const dispose = settings ? () => {} : initNotify()
  root.render(h(settings ? PetSettings : PetOverlay, {}))
  return () => { root.unmount(); if (typeof dispose === 'function') dispose() }
}
