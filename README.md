# Yoshinove工作台

面向个人的学生工作台：把课表、上课提醒、作业 DDL、健康跑打卡（里程/步数记录与图表分析）、成绩绩点、笔记和 AI 实验整合到一个本地 Web 应用里。

当前形态是**本地 Web 应用**（前后端在本机跑）

---

## 功能一览

| 模块 | 内容 |
|---|---|
| **首页** | 今日课程时间轴（含上课中/已下课状态）、待办作业、临近倒计日、健康跑快捷打卡、低余额提醒、快捷入口。问候语里的称呼**点一下就能改**，并同步到浏览器标签页标题（存 `ui.displayName`，未设置时显示「同学」） |
| **课表** | 教务课表 **PDF 上传解析**（几何网格 + 规则正则，不用 LLM 猜）、校对编辑、周视图（周次/单双周过滤/今日高亮/冲突课程并排分栏）、背景图与节次时间配置 |
| **上课提醒** | 多条规则（课前 N 分钟 × 内容模板 × 通道）、每分钟对齐扫描、去重；配套的推送通道凭据（PushPlus / 企业微信 / 浏览器桌面通知）同页配置 |
| **学习通作业** | Cookie 登录、定时同步作业列表、按提交状态分组、截止剩余时间与 DDL 提醒、**只显示本学期**（按课程开课时间判定） |
| **笔记** | Vditor IR 模式（资源全本地化，不依赖外网）、Markdown 批量导入与整页拖拽、Typora 主题一键导入并实时套用到编辑区 |
| **AI 实验区** | 各开放平台**余额与套餐额度监控**（含趋势/消耗分析图表）、Prompt 库（`{变量}` + 用例 + 版本）、多模型并排对比、SVG/HTML 沙箱渲染 |
| **日常工具** | 健康跑打卡（日历 + 连续/周/月统计）、倒计日、成绩绩点（教务 Excel 一键导入 + 自动换算 GPA + 图表分析）、番茄钟 |
| **项目管理** | **手动扫描**指定目录（可调系统文件夹选择框选路径；按 git / README / AI 标记 / 构建文件**打分**识别，先预览勾选再导入）、**可嵌套的自建分类**与软件内改名（与磁盘结构解耦）、**技术栈识别**（读 `package.json` 依赖与各语言清单，覆盖 Vue/React/Java/Python/C++/C# 等，可一键重新识别）、**应用内文件浏览与轻量编辑**（Monaco 语法高亮，HTML/SVG/Markdown 预览，保存自动备份 .bak，新建/重命名/删除）、**Git 详情面板**（分支/领先落后/最近提交/未提交文件）、带 index.html 的项目**一键本地预览**、**在本地应用中打开**（分体按钮：真实应用图标 + 下拉菜单，App Paths 注册表 / 卸载记录 / 版本化目录多路探测，只列出本机验证到启动器的应用）、收藏与备注 |
| **设置** | 外观（深浅色 / 主题色 / 圆角，实时生效）、字号缩放、界面语言（外壳与组件库，内容文案渐进迁移）、主题预置卡（占位） |

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vue 3 + TypeScript + Vite + Element Plus + Pinia + ECharts（端口 `5173`） |
| 后端 | Node.js + Fastify + TypeScript（`tsx watch`，端口 `5175`） |
| 数据 | SQLite（better-sqlite3 + drizzle-orm，WAL 模式） |
| 定时 | 自研 scheduler，随后端进程启动，每分钟第 1.5 秒对齐扫描 |
| 共享 | `shared/` 放前后端共用的类型与纯函数 |
| 外部 | 学习通（超星）、PushPlus、企业微信 —— 均为**只读出站**请求 |

---

## 环境要求

> ⚠️ **这两条是硬约束，不满足会直接启动失败。**

| 要求 | 原因 |
|---|---|
| **Node.js 26** | `better-sqlite3` v12+ 需按 Node 26 的 ABI 编译。用 Node 22 会报 `ERR_DLOPEN_FAILED: NODE_MODULE_VERSION 147 vs 127` |
| **pnpm 11** | 原生包构建放行写在根目录 `pnpm-workspace.yaml` 的 `allowBuilds` 里，pnpm 只认这个配置 |

本机验证过的版本：Node `v26.2.0` + pnpm `11.18.0`。

> 如果机器上装了多个 Node，注意确认 `node -v` 是 26。常见情况是 shell 的 PATH 里有更新的 Node，而项目需要的是 26。

---

## 快速开始

```bash
# 1. 安装依赖（必须在仓库根目录）
pnpm install

# 2. 准备 Vditor 运行时资源（未随仓库分发，约 22MB，只需执行一次）
#    macOS / Linux
cp -r client/node_modules/vditor/dist client/public/vditor/dist
#    Windows PowerShell
#    Copy-Item client/node_modules/vditor/dist client/public/vditor/dist -Recurse -Force

# 3. 同时启动前后端
pnpm dev
```

启动后打开 <http://127.0.0.1:5173>。

> **第 2 步是干什么的**：`client/public/vditor/` 是约 22MB 的第三方编辑器资源，笔记页与 Markdown 预览通过 `cdn: '/vditor'` 从这里加载，因此已被 `.gitignore` 排除（内容与 `node_modules/vditor/dist` 完全一致，可随时重新拷贝）。跳过它，**笔记页与 Markdown 预览会因加载不到运行时资源而失效**，其余功能不受影响。

只想起其中一端：

```bash
pnpm dev:server    # 仅后端
pnpm dev:client    # 仅前端
```

---

## 目录结构

```
├── client/                      # Vue 3 前端
│   ├── src/views/               # 每个功能一个 View（首页/课表/学习通/笔记/AI/工具/设置）
│   ├── src/components/          # SectionPicker（点格选节次）、PushChannelCard（推送通道配置卡）
│   ├── public/                  # favicon 等静态资源（Vditor 运行时也在这里，见「快速开始」第 2 步）
│   ├── index.html               # 声明 favicon
│   └── vite.config.ts           # 端口 5173 + 代理
├── server/                      # Fastify 后端
│   ├── src/index.ts             # 入口：注册路由 + 启动调度器
│   ├── src/db/                  # better-sqlite3 + drizzle + 建表/轻量迁移
│   ├── src/routes/              # 各模块 HTTP 路由
│   ├── src/services/            # 业务服务（PDF 解析、推送、学习通、余额适配器…）
│   ├── src/scheduler/           # 定时扫描（上课提醒、作业同步、余额轮询）
│   ├── scripts/                 # 调试脚本（排查学习通接口时很有用）
│   └── data/                    # 运行时数据，不入版本库
├── shared/src/index.ts          # 前后端共享类型与纯函数
├── 图标.png                     # favicon 源图（白底 1773×2364，成品在 client/public/）
├── tools/icon/                  # 图标生成：抠白底（边缘 flood fill）+ 出各档成品 + 透明度自检
├── 交接文档.md                   # ★ 开发交接：实现细节、接口契约、踩坑清单
└── 开发计划.md                   # 需求与阶段进度
```

---

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 并行启动前后端 |
| `pnpm dev:server` / `pnpm dev:client` | 单独启动某一端 |
| `pnpm typecheck` | 全量类型检查（前端 `vue-tsc` + 后端 `tsc`） |
| `pnpm build` | 构建全部子包 |
| `pnpm --filter server dev` | 只跑后端（调试后端时常用） |

---

## 注意

1. 课程表功能虽仿照**WakeUp课程表**设计，但并没有做同款教务系统一键导入，仅支持本地PDF上传
2. 课程表导入、成绩导入分别仅支持**PDF格式**和**Excel格式**
3. PushPlus微信推送需要**实名认证和付费**
4. 主题目前只有默认样式，其他均为**占位符**，计划后续新增几款UI主题

## 鸣谢

- DeepSeek
- GLM
