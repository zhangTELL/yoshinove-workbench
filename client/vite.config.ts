import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const webPort = Number(process.env.WORKBENCH_WEB_PORT ?? process.env.WORKBENCH_HTTP_PORT ?? 5173)
const apiPort = Number(process.env.PORT ?? 5175)
if (![webPort, apiPort].every(port => Number.isInteger(port) && port >= 1 && port <= 65535) || webPort === apiPort) throw new Error('网页和后端端口配置无效')
const apiTarget = `http://127.0.0.1:${apiPort}`

export default defineConfig({
  plugins: [vue()],
  // Monaco 只在打开文件时才用：预打包成单个依赖文件，避免 dev 下几千个模块请求
  optimizeDeps: {
    include: ['monaco-editor'],
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/dsh-pet-7340': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/uploads': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/themes': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
