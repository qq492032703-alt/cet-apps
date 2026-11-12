# 把 cet-practice 做成安卓 App（闲鱼售卖版）落地方案

> 结论先行：**走「前端离线化 + Capacitor 打壳」路线（方案 B）**——把 Python 后端的数据和业务逻辑搬到纯前端（IndexedDB），用 Capacitor 生成原生安卓工程打 APK。理由：买家装完就能离线刷题，APK 体积可控、稳定、无需服务器、无需上架应用商店，最适合闲鱼个人售卖。若只想"最快出货、后端零改动"，备选方案 A（Chaquopy 内嵌 Python），但 APK 会很大且兼容性要调。

---

## 一、项目现状（已核实）

| 项 | 内容 |
|---|---|
| 前端 | React 18 + TypeScript + Vite 5 + react-router-dom 6，构建产物 `frontend/dist`（纯静态） |
| 后端 | Python FastAPI + uvicorn + SQLite，`backend/app/main.py` 1509 行，**30 个 `/api/*` 端点** |
| 数据 | 168 套试卷 / 8341 道题（CET4+CET6+考研），听力 76 个 `.m4a` |
| 数据位置 | 源码仓库**不含** `seed/cet6.db` 与音频，需从 v1.1.0 发布包提取（865MB，已验证可下载） |
| 现有打包 | PyInstaller + `packaging/launcher.py` 启动本地 `127.0.0.1:8765` uvicorn 再开浏览器（仅 Windows/macOS） |
| 业务状态 | 答题会话 sessions、错题本 wrong_book、收藏 favorites、笔记 notes、标记 marks、报告 report、备份 |

> 关键点：这不是一个纯静态网页，它靠 Python 后端存"答题进度/错题/收藏/笔记/报告"。安卓方案的核心矛盾就是——**这套 Python 后端怎么进手机**。

---

## 二、三条路线对比

| 方案 | 做法 | 优点 | 缺点 | 体积 |
|---|---|---|---|---|
| **A. Chaquopy 内嵌 Python** | 在 APK 里塞一个 CPython 运行时，跑原 FastAPI+uvicorn+SQLite，Capacitor WebView 访问 `http://127.0.0.1:PORT` | 后端代码 0 改动，功能 100% 保留 | APK 巨大；uvicorn/asyncio 在 Android 兼容调试坑多；Chaquopy 商业发布需授权；启动服务时序复杂 | 800MB~1.2GB |
| **B. 纯前端离线化（推荐）** | 把 `cet6.db` 导出为静态 JSON 打包进 App，用 Dexie(IndexedDB) 重建本地库，把 30 个端点逻辑用 TS 重写 | 稳定、纯离线、启动快、无 Python、无服务器；最适合长期卖 | 需重写一批数据层逻辑（CRUD 为主，工作量中等） | 几十~200MB（音频压缩后） |
| C. 远程服务器 + WebView 壳 | VPS 部署 FastAPI，App 指向 `https://api.xxx` | 改动最小 | 要服务器/要联网/隐私/长期成本/断网废 | 几 MB（但依赖网络） |

> 结论：C 断网即废、闲鱼买家在教室宿舍没网，直接排除；A 体积和兼容是硬伤；**B 是做成"能长期卖的产品"的正解**。

---

## 三、方案 B 详细步骤

### 步骤 1 — 备齐数据
```bash
# 已后台下载中：build-input/v1.1.0-Windows-x64.zip
python packaging/fetch_release_data.py      # 从 zip 提取 seed/cet6.db -> build-input/ , 解出 resources/*.m4a (76个)
```
校验：papers=168、questions=8341、sessions/wrong_book/favorites/notes 全为 0（干净库）。

### 步骤 2 — 把只读题库导出成静态 JSON
`scripts/export_static.py`（已写好）从 `cet6.db` 读 `papers / questions / section_materials / kaoyan_canonical / answer_checks`，按卷分片导出到 `frontend/public/data/`：
- `data/index.json`：试卷列表（供 `listPapers`）
- `data/paper/<paper_key>.json`：单卷明细（questions + section_materials + kaoyan_canonical + answer_checks，供 `paperDetail`）

### 步骤 3 — 最小改造：只替换 api.ts 一个函数（核心洞见）
**前端所有网络请求都收敛在 `frontend/src/api.ts` 的 `api(path, init)` 一个函数里**（页面/组件几乎零散点）。所以不需要改任何页面，只要把 `api()` 改成一个"本地后端分派器"：

| path 前缀 | 本地实现 |
|---|---|
| `/api/papers`、`/api/papers/{key}` | 读 `public/data/**.json`（fetch 静态文件） |
| `/api/sessions*`（建卷/保存/交卷/结果/历史） | Dexie `sessions` 表 + 判分逻辑（翻 main.py `submit_session`/`_normalize_answer`） |
| `/api/review/wrong`、`/api/favorites/*`、`/api/notes/*`、`/api/marks*` | Dexie 对应表 CRUD |
| `/api/report` | 前端聚合 `history + result_json`（或翻 main.py 聚合逻辑） |
| `/api/audio/{key}` | 指向 `public/audio/*.m4a` 本地文件 |
| `/api/questions/{uid}`、`/api/pdfs` | 读分片 JSON；PDF 对照功能在手机上可降级隐藏 |

这样页面代码 **0 改动**，只新增 `localBackend.ts` + 改 `api.ts` 的实现，风险和工期都大幅下降（数据层约 1–2 天，不是 2–4 天）。

### 步骤 4 — 音频本地化
- 用 ffmpeg 把 76 个 m4a 转码压缩（如 128k→64k 单声道），体积可压到 100–200MB。
- 放进 `frontend/public/audio/`，`AudioPlayer` 用相对路径播放；Capacitor 里走本地 file:// 或 assets。

### 步骤 5 — Capacitor 打安卓壳
```bash
cd frontend
npm i @capacitor/core @capacitor/cli @capacitor/android
npx cap init "CET刷题" com.yourname.cet --web-dir=dist
npm run build
npx cap add android
npx cap sync android
# 打开 Android Studio 或直接命令行 gradle 出 APK
cd android && ./gradlew assembleRelease
```

### 步骤 6 — 签名 & 出包
```bash
keytool -genkey -v -keystore cet.keystore -alias cet -keyalg RSA -keysize 2048 -validity 10000
# 配置 signingConfigs 后 assembleRelease -> app-release.apk
```
买家手机"允许未知来源"即可安装（安卓侧载）。**iOS 用户装不了**，闲鱼文案要写清"仅安卓"。

### 步骤 7 — 售卖增强（可选但建议）
- **授权码/激活**：首次启动要求输入激活码（本地校验 + 简单算法），防止一码多机倒卖。
- **改名换皮**：换 App 名/图标/启动图，去掉原项目任何 GitHub/作者痕迹。
- **隐私**：全部数据只存本机 IndexedDB，不上传，卖点写"纯离线、不联网、不收集信息"。

---

## 四、工作量与时间（方案 B）

| 环节 | 预估 |
|---|---|
| 数据下载+导出 JSON | 0.5 天 |
| 数据层 TS 重写（30 端点） | 2–4 天 |
| 音频压缩+本地化 | 0.5 天 |
| Capacitor 工程+打包+签名 | 1 天 |
| 调 UI 适配手机 / 测试 | 1–2 天 |
| **合计** | **约 5–8 个工作日**（熟悉前端的话更快） |

## 五、风险提醒
1. **题库版权**：历年真题+听力有版权归属，公开售卖存在被投诉下架/追责风险，建议自用/小范围，文案规避"官方/真题原版"字样。
2. **APK 体积**：带听力版必须压音频，否则 800MB+ 影响闲鱼传输和安装。
3. **iOS**：只能出安卓 APK，苹果需企业签/TestFlight，成本高，先做安卓。
4. **Chaquopy（若选 A）**：商业发布要授权，注意合规成本。

---

## 六、已启动的验证
- [进行中] 后台下载 v1.1.0 发布包（数据库+音频）
- [进行中] 后台 `npm ci && npm run build` 验证前端能否直接构建
- [待做] 数据导出脚本 / Capacitor 工程骨架
