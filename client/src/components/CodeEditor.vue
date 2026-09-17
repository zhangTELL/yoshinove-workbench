<!--
  Monaco 代码编辑器（懒加载封装）

  为什么单独抽组件：Monaco 体积大（完整包约 5MB），只在真正打开文件时才 import，
  首屏与其它页面完全不受影响（Vite 会把它切成独立 chunk）。

  worker 的处理：Monaco 需要 Web Worker 才能正常工作。Vite 用 `?worker` 语法把
  worker 单独打包，再由 MonacoEnvironment.getWorker 按语言分发（少了它编辑器会
  报 "Unexpected usage" 并退化成只读文本域）。
-->
<template>
  <div ref="host" class="code-editor" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 文件内容（v-model） */
    modelValue: string
    /** Monaco 的 languageId（由服务端按扩展名给出） */
    language?: string
    /** 只读（二进制 / 超大文件 / 预览态） */
    readonly?: boolean
    /** 浅色还是深色 */
    theme?: 'light' | 'dark'
  }>(),
  { language: 'plaintext', readonly: false, theme: 'light' },
)

const emit = defineEmits<{
  'update:modelValue': [v: string]
  /** Ctrl/Cmd + S */
  save: []
}>()

const host = ref<HTMLElement | null>(null)

let monaco: typeof import('monaco-editor') | null = null
let editor: import('monaco-editor').editor.IStandaloneCodeEditor | null = null
let loading: Promise<void> | null = null
/** 程序化 setValue 时要抑制 update 事件，否则会把自己的写入再 emit 回去 */
let silent = false

type MonacoModule = typeof import('monaco-editor')

/** 全局只初始化一次 worker 分发 */
let monacoReady: Promise<MonacoModule> | null = null
async function loadMonaco(): Promise<MonacoModule> {
  if (monacoReady) return monacoReady
  monacoReady = (async () => {
    const [m, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all([
      import('monaco-editor'),
      // ⚠️ 路径不能写 `monaco-editor/esm/...`：该包的 exports 字段把 `./*` 映射到 `./esm/vs/*`，
      // 再带 esm/vs 前缀会解析成 esm/vs/esm/vs/... 而构建失败。`.js` 后缀必须显式写出。
      import('monaco-editor/editor/editor.worker.js?worker'),
      import('monaco-editor/language/json/json.worker.js?worker'),
      import('monaco-editor/language/css/css.worker.js?worker'),
      import('monaco-editor/language/html/html.worker.js?worker'),
      import('monaco-editor/language/typescript/ts.worker.js?worker'),
    ])
    // 必须早于 editor.create，否则 worker 用的是默认（不存在的）路径
    ;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker(_moduleId: string, label: string) {
        if (label === 'json') return new jsonWorker.default()
        if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker.default()
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker.default()
        if (label === 'typescript' || label === 'javascript') return new tsWorker.default()
        return new editorWorker.default()
      },
    }
    // vite 对 CJS/ESM interop 的包装：有 editor 就用本体，否则取 default
    return ((m as unknown as { editor?: unknown }).editor ? m : (m as unknown as { default: MonacoModule }).default) as MonacoModule
  })()
  return monacoReady
}

async function mount() {
  if (editor || !host.value) return
  if (loading) return loading
  loading = (async () => {
    const m = await loadMonaco()
    monaco = m
    if (!host.value) return
    editor = m.editor.create(host.value, {
      value: props.modelValue,
      language: props.language,
      theme: props.theme === 'dark' ? 'vs-dark' : 'vs',
      readOnly: props.readonly,
      automaticLayout: true, // 容器尺寸变化（对话框动画 / 窗口缩放）自动跟随
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      fontFamily: "Consolas, 'Cascadia Mono', 'JetBrains Mono', monospace",
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      tabSize: 2,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      stickyScroll: { enabled: false },
      padding: { top: 10, bottom: 10 },
    })
    editor.onDidChangeModelContent(() => {
      if (silent) return
      emit('update:modelValue', editor!.getValue())
    })
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => emit('save'))
  })()
  return loading
}

/** 外部（父组件）调用：等编辑器真的就绪 */
defineExpose({
  ready: () => mount(),
  focus: () => editor?.focus(),
  /** 让 Monaco 重新量一次尺寸（对话框从隐藏变可见后用） */
  layout: () => editor?.layout(),
  /** 跳到某一行（预览跳转用，暂未接 UI） */
  revealLine: (n: number) => editor?.revealLineInCenter(n),
})

watch(
  () => props.modelValue,
  (v) => {
    void mount()
    if (!editor) return
    if (editor.getValue() === v) return
    silent = true
    editor.setValue(v)
    silent = false
  },
)

watch(
  () => props.language,
  (lang) => {
    const model = editor?.getModel()
    if (model && lang && monaco) monaco.editor.setModelLanguage(model, lang)
  },
)

watch(
  () => props.readonly,
  (ro) => editor?.updateOptions({ readOnly: ro }),
)

watch(
  () => props.theme,
  (t) => monaco?.editor.setTheme(t === 'dark' ? 'vs-dark' : 'vs'),
)

onMounted(() => {
  void mount()
})

onBeforeUnmount(() => {
  editor?.dispose()
  editor = null
})
</script>

<style scoped>
.code-editor {
  width: 100%;
  height: 100%;
  min-height: 200px;
  overflow: hidden;
  border-radius: 6px;
}
</style>
