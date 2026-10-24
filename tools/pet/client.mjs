import { useState, useEffect, useRef, useCallback } from 'react'
import { jsx as h } from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { makePetUI } from '../../vendor/dsh-pet/src/client/pet.ts'
import { petBridge } from '../../vendor/dsh-pet/src/client/settings.ts'
import { initNotify, reloadNotifications, requestNotificationPermission } from '../../vendor/dsh-pet/src/client/notify.ts'

const hooks = { h, useState, useEffect, useRef, useCallback }
const PetOverlay = makePetUI(hooks)
export function mountPet(element) {
  const root = createRoot(element)
  const dispose = initNotify()
  root.render(h(PetOverlay, {}))
  return () => { root.unmount(); if (typeof dispose === 'function') dispose() }
}
export function reloadPetConfig(config) { petBridge.reload(config); void reloadNotifications() }
export const requestPetNotificationPermission = requestNotificationPermission
