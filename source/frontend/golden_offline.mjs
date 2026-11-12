// 离线端对拍快照：用 esbuild 打包 localBackend.ts，在 node 里跑 handleApi，
// 对与 golden_backend.py 完全相同的只读接口生成快照 → scripts/_golden_offline.json
import esbuild from 'esbuild'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = __dirname
const PUB = path.join(ROOT, 'public')
const OUT = path.join(ROOT, '.selftest')
fs.mkdirSync(OUT, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/localBackend.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'node20',
  outfile: path.join(OUT, 'localBackend.mjs'),
  define: { 'import.meta.env': '{"BASE_URL":"/"}' },
  logLevel: 'silent',
})
await import('fake-indexeddb/auto')
globalThis.fetch = async (u) => {
  let p = String(u)
  if (p.startsWith('http')) p = new URL(p).pathname
  p = decodeURIComponent(p).replace(/^\//, '')
  try {
    const buf = await fsp.readFile(path.join(PUB, p), 'utf8')
    return { ok: true, status: 200, json: async () => JSON.parse(buf) }
  } catch {
    return { ok: false, status: 404, json: async () => ({}) }
  }
}

const { handleApi } = await import('./.selftest/localBackend.mjs')

// 读取后端快照里用到的 keys，保证请求集合一致
const be = JSON.parse(await fsp.readFile(path.join(ROOT, '..', 'scripts', '_golden_backend.json'), 'utf8'))
const keys = be.keys

const paths = []
for (const ex of ['cet4', 'cet6', 'kaoyan']) paths.push(`/api/papers?exam=${ex}`)
for (const ex of ['cet4', 'cet6', 'kaoyan']) if (keys[ex]) paths.push(`/api/papers/${keys[ex]}`)
for (const ex of ['cet4', 'cet6', 'kaoyan']) paths.push(`/api/report?exam=${ex}`)
for (const k of ['/api/review/wrong', '/api/review/favorites', '/api/marks/all', '/api/backup/export', '/api/history']) paths.push(k)

const snap = {}
for (const p of paths) {
  try {
    const v = await handleApi(p)
    snap[p] = { status: 200, json: v }
  } catch (e) {
    snap[p] = { status: e?.status || 500, json: { detail: String(e?.message || e) } }
  }
}
const out = path.join(ROOT, '..', 'scripts', '_golden_offline.json')
await fsp.writeFile(out, JSON.stringify({ keys, snap }, null, 0), 'utf8')
console.log('offline snap ok paths=', Object.keys(snap).length)
