# 安卓 App 制作与售卖手册（英语研习室）

> 把 cet-practice（React + FastAPI 桌面项目）改造成**纯离线安卓 App**，可直接在闲鱼等平台侧载售卖。
> 核心改造：FastAPI 后端全部换成 `frontend/src/localBackend.ts`（IndexedDB + 静态 JSON），页面零改动。

## 一、成品

- **APK 路径**：`C:\Users\Administrator\Desktop\CET-英语研习室-v1.0.apk`（约 276 MB，已签名；16kbps 单声道音频，音质够用、体积更小）
- 包名 `com.englishstudy.cet`，显示名「英语研习室」，versionName 1.0
- 支持 Android 5.0+（minSdk 22），targetSdk 34
- **纯离线**：不联网即可用，做题进度/错题/收藏/笔记全部存在手机本机（IndexedDB）
- 内容：CET-4（46 套）+ CET-6（76 套）+ 考研（46 套）= **168 套真题、8341 道题**，听力音频 76 个

## 二、整体架构（为什么这么做）

原项目是「浏览器前端 + 本地 Python 服务」。安卓不能直接跑 Python（Chaquopy 方案 APK 巨大且兼容坑多）。
本项目所有请求都收敛在 `frontend/src/api.ts` 的 `api()` 一个函数里，于是只把这一层换成前端本地实现：

- `frontend/src/localBackend.ts`：用 Dexie(IndexedDB) 存用户数据，用 `public/data/*.json` 存题库，1:1 复刻后端 29 个 `/api` 的语义（判分/报告/错题/收藏/笔记/标记/备份）。
- 题库静态化：`scripts/export_static.py` 把 SQLite 导出成 `frontend/public/data/`（index.json + 每卷一个分片）。
- 音频：`scripts/build_audio.py` 从发布包提取并转 24k 单声道 AAC，写到 `frontend/public/audio/`。
- 打壳：Capacitor 6 把前端 `dist/` 打进 WebView，`gradlew assembleRelease` 出签名 APK。

## 三、冒烟验证（已通过）

`frontend/verify_web.cjs`（puppeteer-core 驱动真实 Edge）：
```
cd frontend
python -m http.server 8102 --bind 127.0.0.1   # 在 dist 目录起服务
node verify_web.cjs http://127.0.0.1:8102/
```
结果：页面正常渲染四级/六级/考研切换、76 套试卷、3315 客观题、年份分组、开始按钮，零 JS 报错。

## 四、从零重建步骤

前置环境：Node 22、Python 3.12、JDK 17、Android SDK（platform-tools、platforms;android-34、build-tools;34.0.0）。

```powershell
# 1) 取数据（下载官方 v1.5.0 WithAudio 发布包，提取 db + 音频）
curl.exe -L -o build-input\v1.5.0-WithAudio.zip `
  "https://github.com/o-Sakurajimamai-o/cet-practice/releases/download/v1.5.0/CET-Practice-v1.5.0-Windows-x64-WithAudio.zip"
python scripts\export_static.py            # 生成 frontend/public/data/（约 47MB）
python scripts\build_audio.py              # 生成 frontend/public/audio/（76 个 m4a）
node scripts\gen-meta.cjs                  # 生成 meta.json（聚合索引）

# 2) 构建前端（含离线层）
cd frontend
npm.cmd ci
npm.cmd run build                          # 产出 dist/（约 387MB）

# 3) 打安卓包
npx.cmd cap sync android
cd android
$env:JAVA_HOME="C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot"
.\gradlew.bat assembleRelease               # 产出 app\build\outputs\apk\release\app-release.apk
```

> 注：本机 `npm` 必须用 `npm.cmd`（PowerShell 禁用了 npm.ps1）；`android/local.properties` 需写明 `sdk.dir`。

## 五、换皮（改名 / 图标 / 包名 / 版本）

- **显示名**：`capacitor.config.ts` 的 `appName` + `android/app/src/main/res/values/strings.xml` 的 `app_name` / `title_activity_main`。
- **图标**：替换 `android/app/src/main/res/mipmap-*/ic_launcher*.png`（含 `mipmap-anydpi-v26` 自适应图标，或干脆删掉自适应 xml 只留 png）。
- **包名**：改 `android/app/build.gradle` 的 `applicationId` 与 `namespace`，并同步 `android/app/src/main/java/**/MainActivity.java` 的 `package` 与目录。**改包名后需重新 `cap sync`**。
- **版本号**：`build.gradle` 的 `versionCode`（每发一版 +1）/ `versionName`。
- **启动页/主题色**：`res/values/styles.xml` 与 `res/drawable*/splash*`。

## 六、体积（已优化）

- 已把听力音频压到 **16kbps 单声道**：音频 334MB → 254MB，APK 356MB → **276MB**。
- 想更小：`python scripts/build_audio.py 8k` 再 `npm run build` + `assembleRelease`，音频约 127MB、APK 约 150MB（音质更闷）。
- 想更极致：出「**无听力版**」（删 `frontend/public/audio`）APK 仅 ~25–30MB，可做第二个低价 SKU。
- 题库 JSON 已剥离 `document_json`（考研原文，前端不读），115MB → 47MB。

## 七、闲鱼售卖加固建议

1. **激活码 / 试用**：最简单是首次启动弹输入框，本地校验一个码（内置一批码做白名单），或用一个轻量联网校验。防一码多卖可加「一码一机」绑定（首次激活写机器 ID）。
2. **避免版权风险**：不要在图标/标题/详情页使用「官方」「四六级真题宝典」等易被投诉字样；题源本就整理自公开笔记，详情页写「历年真题练习·个人学习用」更稳。
3. **交付形态**：闲鱼卖的是 APK 文件 + 安装说明（允许「未知来源」安装）。iOS 用户装不了安卓 APK，详情页注明「仅安卓」。
4. **售后**：本机数据，卸载即清空；建议随包附「备份/导入」入口（App 内已有备份页，可导出 JSON）。
5. **更新**：每次改完 `versionCode+1` 重新 `assembleRelease`，用**同一个 keystore**签名，老用户可覆盖安装不丢数据。

## 八、已知限制

- 仅安卓；iOS 需另走 App Store 或 TestFlight（本方案不覆盖）。
- 音频为 24k AAC 单声道（体积取舍），非原始无损。
- 考研原文（`document_json`）已剥离以瘦身，App 内不展示该字段，不影响做题。

---
构建产物与脚本都在 `C:\Users\Administrator\Desktop\cet-practice\`；APK 在桌面根目录。
