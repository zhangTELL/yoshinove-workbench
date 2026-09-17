<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { post, put, get } from '../api/http'

/**
 * 推送通道凭据（PushPlus / 企业微信 / 浏览器桌面通知）。
 *
 * 这三样是被多个模块共用的「通道凭据」：上课提醒、学习通 DDL 提醒、API 余额告警都走它。
 * 但配置入口放在「课表 → 上课提醒」里——因为提醒规则的通道选择就在同一个页面，
 * 用户改完「走哪个通道」能立刻往下看到「通道凭据填在哪」。
 *
 * 组件自带加载与保存，只写自己的键（notification.pushplusToken / notification.wecom），
 * 不碰 notification.rules —— 避免把同一页面里提醒规则的改动覆盖掉。
 */

const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const testResults = ref<{ channel: string; ok: boolean; detail: string }[]>([])

const notification = reactive({
  pushplusToken: '',
  wecom: {
    corpId: '',
    agentId: '',
    secret: '',
    toUser: '@all',
  },
})

const TEST_CHANNEL_OPTIONS = [
  { value: 'browser', label: '浏览器通知' },
  { value: 'pushplus', label: 'PushPlus（微信）' },
  { value: 'wecom', label: '企业微信' },
]
const testChannels = ref<string[]>(['browser'])

/** 按已填写的凭据给出默认测试通道，省得每次手动勾 */
function defaultTestChannels(): string[] {
  const out = ['browser']
  if (notification.pushplusToken) out.push('pushplus')
  if (notification.wecom.corpId && notification.wecom.agentId && notification.wecom.secret) out.push('wecom')
  return out
}

onMounted(async () => {
  try {
    const saved = await get<Record<string, unknown>>('/api/settings')
    if (typeof saved['notification.pushplusToken'] === 'string') notification.pushplusToken = saved['notification.pushplusToken']
    if (saved['notification.wecom']) Object.assign(notification.wecom, saved['notification.wecom'])
    testChannels.value = defaultTestChannels()
  } finally {
    loading.value = false
  }
})

async function save(): Promise<boolean> {
  saving.value = true
  try {
    await put('/api/settings', {
      'notification.pushplusToken': notification.pushplusToken,
      'notification.wecom': notification.wecom,
    })
    ElMessage.success('通道凭据已保存')
    return true
  } catch (e) {
    ElMessage.error(`保存失败：${(e as Error).message}`)
    return false
  } finally {
    saving.value = false
  }
}

async function requestBrowserPermission() {
  if (!('Notification' in window)) {
    ElMessage.error('此浏览器不支持桌面通知')
    return
  }
  const perm = await Notification.requestPermission()
  if (perm === 'granted') {
    new Notification('工作台通知测试', { body: '桌面通知已开启 ✔' })
    ElMessage.success('浏览器通知已授权')
  } else {
    ElMessage.warning('浏览器通知未授权：' + perm)
  }
}

/** 先保存当前填写的凭据，再按勾选的通道发测试 */
async function sendTest() {
  if (!testChannels.value.length) {
    ElMessage.warning('请先勾选要测试的通道')
    return
  }
  const ok = await save()
  if (!ok) return
  testing.value = true
  testResults.value = []
  try {
    testResults.value = await post<typeof testResults.value>('/api/notifications/test', { channels: testChannels.value })
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    testing.value = false
  }
}

const channelName: Record<string, string> = {
  browser: '浏览器通知',
  pushplus: 'PushPlus（微信）',
  wecom: '企业微信',
}
</script>

<template>
  <el-card v-loading="loading">
    <template #header>
      <div class="card-head">
        <span>推送通道</span>
        <span class="head-sub">上课提醒、作业截止提醒、余额不足提醒都用这里的账号</span>
      </div>
    </template>

    <el-form label-width="140px" style="max-width: 640px">
      <el-divider content-position="left">PushPlus（微信）</el-divider>
      <el-form-item label="PushPlus Token">
        <el-input v-model="notification.pushplusToken" placeholder="在 pushplus.plus 注册后获取" show-password />
      </el-form-item>
      <el-divider content-position="left">企业微信应用消息</el-divider>
      <el-form-item label="企业 ID (corpId)">
        <el-input v-model="notification.wecom.corpId" />
      </el-form-item>
      <el-form-item label="应用 AgentId">
        <el-input v-model="notification.wecom.agentId" />
      </el-form-item>
      <el-form-item label="应用 Secret">
        <el-input v-model="notification.wecom.secret" show-password />
      </el-form-item>
      <el-form-item label="接收用户">
        <el-input v-model="notification.wecom.toUser" placeholder="@all 或成员账号，多个用 | 分隔" />
      </el-form-item>
      <el-form-item label="桌面通知权限">
        <el-button text type="primary" @click="requestBrowserPermission">测试浏览器桌面通知权限</el-button>
        <span class="form-tip">只有页面开着的时候才收得到</span>
      </el-form-item>
    </el-form>

    <div class="tips">
      企业微信配置步骤：注册企业微信 → 管理后台「应用管理」→ 创建自建应用 → 把 CorpId / AgentId / Secret 填入上方 →
      在成员的微信中关注「微工作台」即可在微信里收到推送。
    </div>

    <el-divider />

    <div class="test-bar">
      <span class="rule-label">测试通道：</span>
      <el-checkbox-group v-model="testChannels" size="small">
        <el-checkbox-button v-for="o in TEST_CHANNEL_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</el-checkbox-button>
      </el-checkbox-group>
      <el-button :loading="saving" @click="save">保存</el-button>
      <el-button type="warning" plain :loading="testing" @click="sendTest">发送测试通知</el-button>
      <span class="form-tip">点测试会先保存你填的内容</span>
    </div>

    <div v-if="testResults.length" class="test-results">
      <div v-for="r in testResults" :key="r.channel" class="test-result-row">
        <el-tag :type="r.ok ? 'success' : 'danger'" size="small">{{ channelName[r.channel] ?? r.channel }}</el-tag>
        <span>{{ r.detail }}</span>
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
}
.head-sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.rule-label {
  color: var(--el-text-color-regular);
  font-size: 13px;
}
.tips {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.8;
  background: #f4f4f5;
  border-radius: 6px;
  padding: 10px 14px;
}
.form-tip {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-left: 8px;
}
.test-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.test-results {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.test-result-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
</style>
