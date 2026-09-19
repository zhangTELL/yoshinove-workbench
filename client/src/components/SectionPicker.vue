<script setup lang="ts">
import { ref } from 'vue'

const props = withDefaults(defineProps<{ start: number; end: number; count?: number }>(), { count: 12 })
const emit = defineEmits<{ (e: 'update:start', v: number): void; (e: 'update:end', v: number): void }>()

/** 两次点击确定区间：第一次点起始节，第二次点结束节 */
const anchor = ref<number | null>(null)

function onCell(n: number) {
  if (anchor.value === null) {
    anchor.value = n
    emit('update:start', n)
    emit('update:end', n)
  } else {
    const a = anchor.value
    anchor.value = null
    emit('update:start', Math.min(a, n))
    emit('update:end', Math.max(a, n))
  }
}

function isPicked(n: number): boolean {
  return n >= Math.min(props.start, props.end) && n <= Math.max(props.start, props.end)
}
</script>

<template>
  <div class="sp-wrap">
    <div class="sp-grid">
      <button
        v-for="n in count"
        :key="n"
        type="button"
        class="sp-cell"
        :class="{ picked: isPicked(n), anchor: anchor === n }"
        @click="onCell(n)"
      >
        {{ n }}
      </button>
    </div>
    <div class="sp-hint">
      <template v-if="anchor !== null">已选第 {{ anchor }} 节为开始，再点结束节次</template>
      <template v-else>当前：第 {{ Math.min(start, end) }} ~ {{ Math.max(start, end) }} 节</template>
    </div>
  </div>
</template>

<style scoped>
.sp-wrap {
  width: 100%;
}
.sp-grid {
  display: grid;
  grid-template-columns: repeat(v-bind('count'), 1fr);
  gap: 4px;
}
.sp-cell {
  height: 34px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--wb-radius-base);
  background: var(--el-bg-color);
  color: var(--el-text-color-regular);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.sp-cell:hover {
  border-color: var(--el-color-primary); /* 边框是"非文字"，主色 3:1 够用 */
  color: var(--wb-accent-text); /* 文字要 4.5:1，用更暗的变体 */
}
.sp-cell.picked {
  background: var(--el-color-primary);
  border-color: var(--el-color-primary);
  color: #fff;
}
.sp-cell.anchor {
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.35);
}
.sp-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
