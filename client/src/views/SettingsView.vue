<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { appearance, applyThemePreset, resetAppearance, themeLocksMode } from '../stores/appearance'
import { THEME_PRESETS, themePreset } from '../utils/themePresets'

/**
 * 设置：工作台级个性化配置，**全部实时生效**（主题预置/外观/圆角/字号/语言），
 * 选择存在 localStorage 的 workbench.uiPrefs。
 *
 * 主题预置走三层变量（见 styles/tokens.css 的说明）：预设只声明 --wb-*，由 bridge.css
 * 统一映射到 Element Plus 的 --el-*，所以这里只负责"选一个 id"+ 把该主题的默认强调色/圆角写进外观设置。
 * ⚠️ 四套预置主题都是**浅色专用**，深色只属于「默认」——选中预置时明暗切换会被禁用（themeLocksMode）。
 *
 * 业务侧的配置入口不在这里：
 *   - 上课提醒的规则与推送通道 → 课表 → 上课提醒
 *   - 学习通 Cookie            → 学习通作业
 *   - 余额阈值与刷新间隔        → AI 实验区 → 账户余额
 *
 * 本页不发任何后端请求。
 */

const ACCENT_PRESETS = ['#409eff', '#007aff', '#7c5cff', '#e873a4', '#22a06b', '#e6a23c', '#f56c6c', '#14b8a6', '#6b7280']

const APPEARANCE_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'auto', label: '跟随系统' },
]

const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
]

const FONT_OPTIONS = [
  { value: 'small', label: '小' },
  { value: 'normal', label: '标准' },
  { value: 'large', label: '大' },
  { value: 'xlarge', label: '特大' },
]

const FONT_PX: Record<string, number> = { small: 13, normal: 14, large: 16, xlarge: 18 }
const previewSize = () => FONT_PX[appearance.fontScale] ?? 14

/** 卡片圆角 = 1.5×基础档（与 stores/appearance.ts 的推导保持一致，只为在提示里显示真实值） */
const cardRadius = computed(() => Math.max(3, Math.round(appearance.radius * 1.5)))

/** 当前主题是否锁定了明暗（预置主题都是浅色专用） */
const modeLocked = computed(() => themeLocksMode())
/** 当前主题预设（用于文案与强调色提示） */
const currentPreset = computed(() => themePreset(appearance.theme))

/** 手动改强调色后就不再跟随主题默认值——所以这里不做任何"记住主题默认色"的额外处理 */
function pickAccent(c: string) {
  appearance.accent = c
}

function pickTheme(id: string) {
  const p = themePreset(id)
  if (!p.ready) {
    ElMessage.info(`「${p.name}」还在做，先选 macOS 那套试试`)
    return
  }
  applyThemePreset(id)
  ElMessage.success(id === 'default' ? '已切回默认主题' : `已切换到「${p.name}」主题`)
}

function reset() {
  resetAppearance()
  ElMessage.success('已恢复默认外观')
}
</script>

<template>
  <div class="page">
    <el-alert
      type="success"
      :closable="false"
      show-icon
      title="这里的改动会立即生效"
      description="换完立即生效，刷新也不会丢。「主题」里已上线的可直接选、未上线的标注「规划中」；预置主题都是浅色专用，选中后深色会被禁用。其他设置不在这一页：上课提醒和推送方式在「课表 → 上课提醒」，学习通登录在「学习通作业」，余额提醒金额在「AI 实验区 → 账户余额」。"
    />

    <!-- ==================== 外观 ==================== -->
    <el-card class="card-appearance">
      <template #header>
        <div class="card-head">
          <span>外观</span>
          <el-button size="small" text @click="reset">恢复默认</el-button>
        </div>
      </template>

      <div class="field-grid">
        <div class="field">
          <div class="field-label">主题模式</div>
          <el-radio-group v-model="appearance.appearance" :disabled="modeLocked">
            <el-radio-button v-for="o in APPEARANCE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</el-radio-button>
          </el-radio-group>
          <div v-if="modeLocked" class="field-tip">
            「{{ currentPreset.name }}」是浅色专用主题，所以这里是锁定的；切回「默认」主题即可使用深色
          </div>
          <div v-else class="field-tip">选「跟随系统」，电脑切到深色时这里也会跟着变</div>
        </div>

        <div class="field">
          <div class="field-label">界面圆角</div>
          <el-slider v-model="appearance.radius" :min="0" :max="16" :step="2" />
          <div class="field-tip">按钮与输入框 {{ appearance.radius }}px、卡片 {{ cardRadius }}px、标签与滑块 {{ Math.max(2, Math.round(appearance.radius * 0.6)) }}px（同一档位派生出三种尺寸）</div>
        </div>

        <div class="field span-2">
          <div class="field-label">主题色</div>
          <div class="accent-row">
            <div class="swatches">
              <button
                v-for="c in ACCENT_PRESETS"
                :key="c"
                class="swatch"
                :class="{ active: appearance.accent === c }"
                :style="{ background: c }"
                :title="c"
                @click="pickAccent(c)"
              />
            </div>
            <div class="accent-demo">
              <span class="ad-btn" :style="{ background: appearance.accent }">按钮</span>
              <span class="ad-link" :style="{ color: appearance.accent }">链接文字</span>
              <span class="ad-bars">
                <i v-for="(h, i) in [55, 100, 40, 80, 65]" :key="i" :style="{ height: `${h}%`, background: appearance.accent }" />
              </span>
            </div>
          </div>
          <div class="field-tip">
            按钮、链接和图表的颜色
            <template v-if="modeLocked">。「{{ currentPreset.name }}」主题的默认强调色是 {{ currentPreset.accent }}，已自动应用，你也可以改成别的</template>
          </div>
        </div>
      </div>
    </el-card>

    <!-- ==================== 主题 ==================== -->
    <el-card class="card-theme">
      <template #header>
        <div class="card-head">
          <span>主题</span>
          <el-tag size="small" type="success" effect="plain">实时生效</el-tag>
        </div>
      </template>
      <div class="theme-grid">
        <div
          v-for="t in THEME_PRESETS"
          :key="t.id"
          class="theme-item"
          :class="{ active: appearance.theme === t.id, todo: !t.ready }"
          :title="t.ready ? '' : '规划中'"
          @click="pickTheme(t.id)"
        >
          <div class="theme-preview" :style="{ background: t.colors[1] }">
            <div class="tp-bar" :style="{ background: t.colors[0] }" />
            <div class="tp-line" :style="{ background: t.colors[2], width: '70%' }" />
            <div class="tp-line" :style="{ background: t.colors[2], width: '45%', opacity: 0.5 }" />
            <div class="tp-chip" :style="{ background: t.colors[0] }" />
            <div v-if="!t.ready" class="tp-todo">规划中</div>
          </div>
          <div class="theme-name">
            {{ t.name }}
            <el-icon v-if="appearance.theme === t.id" class="theme-check"><svg viewBox="0 0 1024 1024" width="1em" height="1em"><path fill="currentColor" d="M406.656 706.944 195.84 496.256a32 32 0 1 0-45.248 45.248l256 256a32 32 0 0 0 45.248 0l512-512a32 32 0 0 0-45.248-45.248L406.592 706.944Z"/></svg></el-icon>
          </div>
          <div class="theme-desc">{{ t.desc }}</div>
        </div>
      </div>
      <div class="theme-tip">预置主题只做浅色；「默认」是唯一支持深色的主题。切换主题会同时套用该主题的默认强调色与圆角，之后你可以自己调。</div>
    </el-card>

    <!-- ==================== 语言 ==================== -->
    <el-card>
      <template #header>语言</template>
      <div class="row">
        <div class="row-label">界面语言</div>
        <div class="row-body">
          <el-radio-group v-model="appearance.language">
            <el-radio-button v-for="o in LANGUAGE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</el-radio-button>
          </el-radio-group>
          <div class="row-tip">
            已生效：侧边导航、标签页标题、Element Plus 组件（日期面板 / 分页 / 表格空态）。功能页的内容文案暂为中文，逐步迁移。
          </div>
        </div>
      </div>
    </el-card>

    <!-- ==================== 字号 ==================== -->
    <el-card>
      <template #header>字号大小</template>
      <div class="row">
        <div class="row-label">界面字号</div>
        <div class="row-body">
          <el-radio-group v-model="appearance.fontScale">
            <el-radio-button v-for="o in FONT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</el-radio-button>
          </el-radio-group>
        </div>
      </div>
      <div class="font-preview">
        <div class="preview-label">预览</div>
        <div class="preview-text" :style="{ fontSize: `${previewSize()}px` }">
          课前 20 分钟提醒 · 高等数学 @ 教三楼 305
        </div>
        <div class="preview-sub" :style="{ fontSize: `${Math.max(11, previewSize() - 3)}px` }">
          正文示例：今天是第 3 周周一，共 2 门课，最近一项作业 2 天后截止。
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 内容区在 1600px 视口下有 1360px，别用小 max-width 把右侧空出来 */
  max-width: 1400px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 18px 24px;
}
.field.span-2 {
  grid-column: 1 / -1;
}
.field-label {
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin-bottom: 8px;
}
.field-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 8px;
  line-height: 1.7;
}
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  flex-shrink: 0;
}
.accent-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 20px;
}
.accent-demo {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 1;
  min-width: 240px;
  background: var(--el-fill-color-light);
  border-radius: var(--wb-radius-card);
  padding: 8px 14px;
}
.ad-btn {
  color: #fff;
  font-size: 12px;
  line-height: 1;
  padding: 7px 14px;
  border-radius: var(--wb-radius-base);
}
.ad-link {
  font-size: 13px;
  text-decoration: underline;
}
.ad-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 26px;
  margin-left: auto;
}
.ad-bars i {
  width: 7px;
  border-radius: var(--wb-radius-small) 2px 0 0;
  opacity: 0.85;
}
.swatch {
  width: 28px;
  height: 28px;
  border-radius: var(--wb-radius-base);
  border: 2px solid transparent;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08) inset;
  cursor: pointer;
  padding: 0;
  transition: transform 0.15s;
}
.swatch:hover {
  transform: scale(1.08);
}
.swatch.active {
  border-color: var(--el-text-color-primary);
  box-shadow: 0 0 0 2px var(--el-bg-color) inset;
}
.theme-grid {
  display: grid;
  /* 主题数会变（现 5 个），别写死列数：
     auto-fit + 200px 下限在宽屏排成一行、窄屏自动折行，且空轨道会被折叠、卡片自动撑满 */
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}
.theme-item {
  border: 1px solid var(--el-border-color);
  border-radius: var(--wb-radius-card);
  padding: 10px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.theme-item:hover {
  border-color: var(--el-color-primary-light-7);
}
.theme-item.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary) inset;
}
.theme-preview {
  height: 76px;
  border-radius: var(--wb-radius-base);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  position: relative;
  overflow: hidden;
}
.tp-bar {
  height: 8px;
  width: 40%;
  border-radius: var(--wb-radius-small);
}
.tp-line {
  height: 6px;
  border-radius: var(--wb-radius-small);
}
.tp-chip {
  position: absolute;
  right: 10px;
  bottom: 10px;
  width: 26px;
  height: 12px;
  border-radius: var(--wb-radius-base);
  opacity: 0.85;
}
.theme-name {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  display: flex;
  align-items: center;
  gap: 4px;
}
.theme-check {
  /* 勾选标记落在白色卡面上，但属于**卡片选中的状态提示**、旁边还有"卡片本身的高亮描边"在表达选中，
     所以这里保持主色不动（改暗会让"已选中"的观感变闷） */
  color: var(--el-color-primary);
}
.theme-desc {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}
/* 规划中的主题：压暗 + 明确标注，避免点了没反应 */
.theme-item.todo {
  opacity: 0.62;
}
.tp-todo {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 6px;
  border-radius: var(--wb-radius-small);
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
}
.theme-tip {
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.7;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.row-label {
  flex: 0 0 88px;
  min-width: 88px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 32px;
}
.row-body {
  flex: 1;
  min-width: 240px;
}
.row-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 8px;
  line-height: 1.7;
}
.font-preview {
  margin-top: 16px;
  background: var(--el-fill-color-light);
  border-radius: var(--wb-radius-card);
  padding: 14px 16px;
}
.preview-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}
.preview-text {
  color: var(--el-text-color-primary);
  line-height: 1.5;
}
.preview-sub {
  color: var(--el-text-color-regular);
  margin-top: 6px;
  line-height: 1.6;
}
</style>
