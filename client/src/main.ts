import { createPinia } from 'pinia'
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
// 变量层三段，顺序不能乱（后者依赖前者，主题要能覆盖契约的默认值）：
//   tokens.css 语义契约 --wb-* → bridge.css 映射到 EP 的 --el-* → themes/*.css 主题预设
import './styles/tokens.css'
import './styles/bridge.css'
import './styles/themes/macos.css'
import './styles/themes/claude.css'
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
