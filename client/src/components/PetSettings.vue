<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { get, post } from '../api/http'
import { editablePetConfig, type PetConfig, type PetConfigMeta, type PetSettingsConfig } from '../pet/config'
import { useUnsavedChanges } from '../composables/useUnsavedChanges'

const draft = ref<PetSettingsConfig>()
const initial = ref('')
const selected = ref('')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const extraCount = ref(0)
const meta = ref<PetConfigMeta>()
let runtime: typeof import('../pet/runtime.js') | undefined
let extraIds = new Set<string>()
const current = computed(() => draft.value?.pets.find(pet => pet.id === selected.value))
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== initial.value)
useUnsavedChanges(dirty, () => save(), '桌宠设置')

const displays = [{ value: 'web', label: '仅网页' }, { value: 'desktop', label: '仅桌面' }, { value: 'both', label: '网页和桌面' }, { value: 'none', label: '隐藏' }]
const corners = [{ value: 'bottom-right', label: '右下角' }, { value: 'bottom-left', label: '左下角' }, { value: 'top-right', label: '右上角' }, { value: 'top-left', label: '左上角' }]
const fonts = [{ value: 'candy', label: '软糖体' }, { value: 'yahei', label: '微软雅黑' }, { value: 'youyuan', label: '幼圆' }, { value: 'kaiti', label: '楷体' }, { value: 'simsun', label: '宋体' }, { value: 'comic', label: 'Comic Sans' }, { value: 'system', label: '系统字体' }]
const petSwitches = [{ key: 'balanceEnabled', label: '余额提示' }, { key: 'whisperEnabled', label: '自动碎碎念' }, { key: 'workStatusEnabled', label: '跟随 AI 工作状态' }, { key: 'fixedEnabled', label: '固定位置' }] as const
const globalSwitches = [{ key: 'notificationsEnabled', label: '系统通知' }, { key: 'whisperImageEnabled', label: '碎碎念配图' }, { key: 'chatImageEnabled', label: '对话配图' }, { key: 'confineToScreen', label: '限制桌面宠物不越出屏幕' }] as const
const physicsNumbers = [{ key: 'gravity', label: '重力', min: 0, step: 100 }, { key: 'restitution', label: '反弹系数', min: 0, max: 1, step: 0.05 }, { key: 'groundFriction', label: '地面摩擦', min: 0, step: 0.05 }, { key: 'throwPower', label: '抛掷力度', min: 0.01, step: 0.1 }] as const
const storageLabels: Record<string, string> = { userData: '用户数据', electron: '桌面运行环境', package: '桌宠程序', desktopCache: '桌面缓存', electronCache: '运行环境下载缓存' }

function apply(config: PetConfig) {
  draft.value = editablePetConfig(config.main)
  initial.value = JSON.stringify(draft.value)
  if (!draft.value.pets.some(pet => pet.id === selected.value)) selected.value = draft.value.pets[0]?.id ?? ''
  const extras = Object.entries(config).filter(([key]) => key !== 'main').flatMap(([, value]) => value.pets)
  extraCount.value = extras.length
  extraIds = new Set(extras.map(pet => pet.id))
  runtime?.reloadPetConfig(config)
}
async function load() {
  loading.value = true
  error.value = ''
  try {
    const [config, module] = await Promise.all([get<PetConfig>('/dsh-pet-7340/config'), import('../pet/runtime.js')])
    runtime = module
    apply(config)
    void get<PetConfigMeta>('/dsh-pet-7340/config/meta').then(value => { meta.value = value }).catch(() => {})
  } catch (cause) { error.value = (cause as Error).message }
  finally { loading.value = false }
}
async function writeConfig(payload: PetSettingsConfig, force = false): Promise<PetConfig> {
  const response = await fetch('/dsh-pet-7340/config' + (force ? '?force=1' : ''), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  if (response.status === 409 && !force) {
    await ElMessageBox.confirm('本地桌宠配置已损坏，继续保存会重建配置并覆盖其中无法读取的内容。建议先备份配置文件。', '重建桌宠配置', { type: 'warning', confirmButtonText: '重建并保存', cancelButtonText: '取消' })
    return writeConfig(payload, true)
  }
  if (!response.ok) throw new Error('桌宠设置保存失败，请检查配置后重试')
  return response.json() as Promise<PetConfig>
}
async function save(): Promise<boolean> {
  if (!draft.value || saving.value || loading.value) return false
  saving.value = true
  error.value = ''
  try {
    const latest = await get<PetConfig>('/dsh-pet-7340/config')
    if (JSON.stringify(editablePetConfig(latest.main)) !== initial.value) throw new Error('桌宠设置已在其他位置更新，请重新载入后再保存。')
    apply(await writeConfig(editablePetConfig(draft.value)))
    ElMessage.success('桌宠设置已保存')
    return true
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close') error.value = cause instanceof Error ? cause.message : '保存失败，请重试'
    return false
  } finally { saving.value = false }
}
function addPet() {
  if (!draft.value?.pets.length) return
  const pet = JSON.parse(JSON.stringify(draft.value.pets[0])) as PetSettingsConfig['pets'][number]
  let index = 1
  while (draft.value.pets.some(value => value.id === 'pet' + index) || extraIds.has('pet' + index)) index++
  pet.id = 'pet' + index
  pet.name = '桌宠 ' + index
  draft.value.pets.push(pet)
  selected.value = pet.id
}
async function removePet() {
  if (!draft.value || !current.value) return
  if (draft.value.pets.length <= 1) { ElMessage.info('至少保留一只桌宠，可将显示位置设为隐藏'); return }
  try {
    await ElMessageBox.confirm(`删除“${current.value.name}”？保存后生效。`, '删除桌宠', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    draft.value.pets = draft.value.pets.filter(pet => pet.id !== selected.value)
    selected.value = draft.value.pets[0].id
  } catch { /* 取消删除 */ }
}
async function reset() {
  try {
    await ElMessageBox.confirm('恢复内置桌宠列表及默认设置？当前自定义偏好会被覆盖。', '恢复桌宠默认设置', { type: 'warning', confirmButtonText: '恢复默认', cancelButtonText: '取消' })
  } catch { return }
  saving.value = true
  error.value = ''
  try { apply(await post<PetConfig>('/dsh-pet-7340/config')); ElMessage.success('已恢复桌宠默认设置') }
  catch (cause) { error.value = (cause as Error).message }
  finally { saving.value = false }
}
async function notificationPermission() {
  const result = await runtime?.requestPetNotificationPermission()
  if (!result?.ok) { ElMessage.warning('请在浏览器的网站权限中允许通知'); return false }
  return true
}
async function testNotification() {
  if (await notificationPermission()) {
    new Notification('桌宠测试通知', { body: '桌宠系统通知已就绪。', icon: '/dsh-pet-7340/pic/notify-test.png' })
    ElMessage.success('测试通知已发送')
  }
}
onMounted(() => { void load() })
</script>

<template>
  <section class="pet-settings" aria-label="桌宠设置">
    <el-card v-loading="loading">
      <template #header><div class="pet-card-head"><span>桌宠</span><el-button type="primary" :loading="saving" :disabled="loading || !draft" @click="save">保存桌宠设置</el-button></div></template>
      <p class="pet-description">网页和独立桌面窗口共用配置。双击或右键桌宠即可快速对话，桌面端也支持 Ctrl+Alt+K。</p>
      <p class="pet-description">对话与碎碎念使用 AI 助手中填写的 DeepSeek Key，启用自动碎碎念会使用 API 额度。</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon><el-button text :disabled="saving" @click="load">重新载入</el-button></el-alert>
      <template v-if="draft">
        <div class="pet-list-bar"><el-tabs v-model="selected"><el-tab-pane v-for="pet in draft.pets" :key="pet.id" :label="pet.name || pet.id" :name="pet.id" /></el-tabs><el-button :disabled="saving" @click="addPet">添加桌宠</el-button></div>
        <p v-if="extraCount" class="pet-description">另有 {{ extraCount }} 只由文件配置的桌宠，请在对应配置文件中编辑。</p>
        <el-form v-if="current" label-position="top" :disabled="saving">
          <div class="pet-fields pet-fields-three">
            <el-form-item label="名字"><el-input v-model="current.name" maxlength="64" aria-label="桌宠名字" /></el-form-item>
            <el-form-item label="大小（宽度 px）"><el-input-number v-model="current.size" :min="60" :step="10" controls-position="right" aria-label="桌宠大小" /></el-form-item>
            <el-form-item label="显示位置"><el-select v-model="current.display" aria-label="桌宠显示位置"><el-option v-for="item in displays" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
            <el-form-item label="初始位置"><el-select v-model="current.position.corner" aria-label="桌宠初始位置"><el-option v-for="item in corners" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
            <el-form-item label="水平偏移（px）"><el-input-number v-model="current.position.marginX" controls-position="right" aria-label="桌宠水平偏移" /></el-form-item>
            <el-form-item label="垂直偏移（px）"><el-input-number v-model="current.position.marginY" controls-position="right" aria-label="桌宠垂直偏移" /></el-form-item>
          </div>
          <div class="pet-fields pet-fields-four"><el-form-item v-for="item in petSwitches" :key="item.key" :label="item.label"><el-switch v-model="current[item.key]" :aria-label="item.label" /></el-form-item></div>
          <el-button type="danger" plain :disabled="saving" @click="removePet">删除当前桌宠</el-button>
        </el-form>
      </template>
    </el-card>
    <template v-if="draft">
      <el-card><template #header>全局行为</template><el-form label-position="top" :disabled="saving"><div class="pet-fields pet-fields-four"><el-form-item v-for="item in globalSwitches" :key="item.key" :label="item.label"><el-switch v-model="draft[item.key]" :aria-label="item.label" @change="(value: string | number | boolean) => { if (item.key === 'notificationsEnabled' && value === true) void notificationPermission() }" /></el-form-item></div></el-form></el-card>
      <el-card><template #header>桌宠字体</template><el-form label-position="top" :disabled="saving"><div class="pet-fields pet-fields-three">
        <el-form-item label="字体"><el-select v-model="draft.font.family" aria-label="桌宠字体"><el-option v-for="item in fonts" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item label="字号（px）"><el-input-number v-model="draft.font.size" :min="4" :max="200" controls-position="right" aria-label="桌宠字号" /></el-form-item>
        <el-form-item label="随桌宠大小缩放"><el-switch v-model="draft.font.followPet" aria-label="桌宠字号随大小缩放" /></el-form-item>
      </div></el-form></el-card>
      <el-card><template #header>AI 对话</template><p class="pet-description">对话和碎碎念均使用 DeepSeek V4.1 Flash，API Key 在 AI 助手设置中填写。</p><el-form label-position="top" :disabled="saving"><div class="pet-fields pet-fields-three">
        <el-form-item label="携带最近对话条数"><el-input-number v-model="draft.chatMemoryRounds" :min="0" :precision="0" controls-position="right" aria-label="桌宠对话历史条数" /></el-form-item>
        <el-form-item label="对话配图张数上限（0 为不限）"><el-input-number v-model="draft.chatImageLimit" :min="0" :precision="0" controls-position="right" aria-label="桌宠对话配图上限" /></el-form-item>
      </div></el-form></el-card>
      <el-card><template #header>拖拽与抛掷</template><el-form label-position="top" :disabled="saving"><div class="pet-fields pet-fields-four">
        <el-form-item v-for="item in physicsNumbers" :key="item.key" :label="item.label"><el-input-number v-model="draft.physics[item.key]" :min="item.min" :max="'max' in item ? item.max : undefined" :step="item.step" controls-position="right" :aria-label="item.label" /></el-form-item>
        <el-form-item label="碰到顶部时反弹"><el-switch v-model="draft.physics.ceilingBounce" aria-label="碰到顶部时反弹" /></el-form-item>
        <el-form-item label="宠物之间碰撞"><el-switch v-model="draft.physics.petCollision" aria-label="宠物之间碰撞" /></el-form-item>
      </div></el-form></el-card>
      <el-card><div class="pet-actions"><el-button type="primary" :loading="saving" @click="save">保存桌宠设置</el-button><el-button :disabled="saving" @click="reset">恢复默认设置</el-button><el-button :disabled="saving || !runtime" @click="testNotification">测试系统通知</el-button><el-tag v-if="dirty" type="warning">有未保存的修改</el-tag></div></el-card>
    </template>
    <el-card v-if="meta"><el-collapse><el-collapse-item title="配置文件与存储位置" name="storage"><el-descriptions :column="1" border><el-descriptions-item label="用户配置">{{ meta.user }}</el-descriptions-item><el-descriptions-item label="内置配置">{{ meta.default }}</el-descriptions-item><el-descriptions-item label="自定义动画">{{ meta.animations }}</el-descriptions-item><el-descriptions-item label="表情包">{{ meta.memes }}</el-descriptions-item><el-descriptions-item v-for="item in meta.storage" :key="item.key" :label="storageLabels[item.key] || item.key">{{ item.path }}</el-descriptions-item></el-descriptions></el-collapse-item></el-collapse></el-card>
  </section>
</template>

<style scoped>
.pet-settings { display: grid; gap: 20px; width: 100%; min-width: 0; container-type: inline-size; }
.pet-settings :deep(.el-card) { min-width: 0; }
.pet-card-head,.pet-actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.pet-actions { justify-content: flex-start; }
.pet-actions .el-button { margin-left: 0; }
.pet-description { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; margin: 0 0 12px; }
.pet-list-bar { display: flex; align-items: center; gap: 16px; margin: 20px 0 12px; }
.pet-list-bar .el-tabs { flex: 1; min-width: 0; }
.pet-list-bar :deep(.el-tabs__content) { display: none; }
.pet-fields { display: grid; gap: 0 24px; }
.pet-fields-three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.pet-fields-four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.pet-fields :deep(.el-input-number),.pet-fields :deep(.el-select) { width: 100%; }
.pet-settings :deep(.el-descriptions__content) { overflow-wrap: anywhere; word-break: break-all; }
@container (max-width: 900px) { .pet-fields-three,.pet-fields-four { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 520px) { .pet-fields-three,.pet-fields-four { grid-template-columns: minmax(0, 1fr); } .pet-list-bar { flex-wrap: wrap; } .pet-list-bar .el-tabs { flex-basis: 100%; } }
</style>
