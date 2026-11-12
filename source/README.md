# 三款英语真题 App 源码（CET4 / CET6 / 考研）

同一套代码，按考试子集化数据 + 锁定单一考试 + 品牌替换，构建出三个独立 APK。

## 目录
- `frontend/` React18 + TypeScript + Vite5 前端；`frontend/src/localBackend.ts` 为纯前端离线数据层（IndexedDB，替代原 Python 后端）。
- `frontend/android/` Capacitor 6 安卓工程（Java/资源/清单；不含构建产物与签名）。
- `backend/` 原 FastAPI 后端源码（保留作数据导出参考，App 内已不走它）。
- `scripts/` 数据导出、音频转码、图标生成、变体打包等脚本。

## 三款差异（scripts/build_variants.py 的 CONFIGS）
| 变体 | 应用名 | 图标字 | 包名 | 主色 | 标语 |
|---|---|---|---|---|---|
| cet4 | 四级研学社 | 四 | com.zhenti.cet4 | #2563EB | 四级真题，一套一套吃透。 |
| cet6 | 六级研学社 | 六 | com.zhenti.cet6 | #7C3AED | 六级真题，步步为营。 |
| kaoyan | 考研研学社 | 研 | com.zhenti.kaoyan | #059669 | 考研英语，稳扎稳打。 |

versionCode 2 / versionName 2.0.0；minSdk 22 / targetSdk 34。

## 环境准备
- Node.js 22（Windows 用 `npm.cmd`）、JDK 17、Android SDK(platform 34 / build-tools 34.0.0)、Python 3.12

## 数据准备（一次性）
仓库不含题库数据库与听力音频（体积过大）：
1. 上游 release `CET-Practice-v1.5.0-Windows-x64-WithAudio.zip` 解出 `seed/cet6.db` 与 `resources/` 到 `build-input/`
2. `python scripts/export_static.py` → `frontend/public/data/`
3. `node scripts/gen-meta.cjs` → `meta.json`
4. `python scripts/build_audio.py` → `frontend/public/audio/`

## 一键打三包
`python scripts/build_variants.py`（子集化→图标→前端构建→cap sync→改包名/版本/名→assembleRelease）

## 未包含（需自备）
- `release.keystore` 签名密钥、`license_private.pem` 授权私钥（机密，未上传）
- `build-input/`、`node_modules/`、`dist/`、存量音频/题库（可重新生成）

## 来源与许可
基于开源工程 o-Sakurajimamai-o/cet-practice 二次改造；见 `LICENSE-NOTICE.md`、`THIRD_PARTY_NOTICES.md`。
