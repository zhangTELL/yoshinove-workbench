import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  // Monaco 只在打开文件时才用：预打包成单个依赖文件，避免 dev 下几千个模块请求
  optimizeDeps: {
    include: ['monaco-editor'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5175',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:5175',
        changeOrigin: true,
      },
      '/themes': {
        target: 'http://127.0.0.1:5175',
        changeOrigin: true,
      },
    },
  },
})
