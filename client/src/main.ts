import { createPinia } from 'pinia'
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/theme.css'
import App from './App.vue'
import router from './router'
import { loadDisplayName } from './stores/profile'
import { initAppearance } from './stores/appearance'

// 外观要先于挂载应用，避免首帧闪烁
initAppearance()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')

// 称呼影响标签页标题，启动时先取一次；取到后 watch 会把标题刷掉，不用阻塞挂载
void loadDisplayName()
