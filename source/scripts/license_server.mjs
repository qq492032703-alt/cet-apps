/**
 * 自助签发服务（离线授权码的"自动出码"后端）。
 *
 * 买家在 App 激活页填「闲鱼订单号」，App 把 订单号 + 本机设备码 POST 到这里，
 * 服务端校验订单、用私钥签一个绑定该设备的码并返回 —— 买家全程自助，无需人工。
 *
 * 部署：把本文件 + license_private.pem + license_public.txt + orders.txt 放同一目录，
 *       node scripts/license_server.mjs   （或挂阿里云函数/腾讯云SCF 改造成 handler）
 *
 * 订单核验：
 *   - orders.txt：一行一个"已付款"的闲鱼订单号（卖出后追加进去；可由自动发货工具抓单写入）
 *   - 环境变量 ORDERS_OPEN=1 时跳过校验（仅自测用，切勿线上开）
 *   - 已激活的订单记入 orders_used.txt，防一单多码
 *
 * 环境变量：PORT（默认 8787）、DEFAULT_EXP（默认 2027-12-31）、ORDERS_OPEN
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PRIV = crypto.createPrivateKey(fs.readFileSync(path.join(DIR, 'license_private.pem')))
const PUB_TXT = fs.readFileSync(path.join(DIR, 'license_public.txt'), 'utf8').trim()
const ORDERS_FILE = path.join(DIR, 'orders.txt')
const USED_FILE = path.join(DIR, 'orders_used.txt')
const OPEN = process.env.ORDERS_OPEN === '1'
const PORT = Number(process.env.PORT || 8787)
const DEFAULT_EXP = process.env.DEFAULT_EXP || '2027-12-31'

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function issue(payload) {
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = crypto.sign(null, Buffer.from(body), PRIV)
  return body + '.' + b64url(sig)
}
function readSet(f) {
  try { return new Set(fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) } catch { return new Set() }
}
const orderOk = (o) => OPEN || readSet(ORDERS_FILE).has(o)
const orderUsed = (o) => readSet(USED_FILE).has(o)
function markUsed(o) { try { fs.appendFileSync(USED_FILE, o + '\n') } catch {} }
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const url = (req.url || '').split('?')[0]
  if (url === '/health') return json(res, 200, { ok: true, open: OPEN })
  if (url === '/pubkey') { res.writeHead(200); return res.end(PUB_TXT) }

  if (url === '/activate' && req.method === 'POST') {
    let buf = ''
    for await (const c of req) buf += c
    let d = {}
    try { d = JSON.parse(buf || '{}') } catch {}
    const order = String(d.order || '').trim()
    const device = String(d.device || '').trim()
    const exp = String(d.exp || DEFAULT_EXP)
    if (!order) return json(res, 400, { ok: false, error: '缺少订单号' })
    if (!orderOk(order)) return json(res, 403, { ok: false, error: '订单无效或未确认付款' })
    if (orderUsed(order)) return json(res, 409, { ok: false, error: '该订单已激活过，勿重复领取' })
    const payload = { exp, bind: device || 'ANY', v: 1, order }
    const license = issue(payload)
    markUsed(order)
    return json(res, 200, { ok: true, license, payload })
  }

  res.writeHead(404); res.end('not found')
}).listen(PORT, () => {
  console.log(`license server: http://127.0.0.1:${PORT}  (orders.txt 校验=${OPEN ? '关闭(ORDERS_OPEN=1)' : '开启'})`)
})
