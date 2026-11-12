/**
 * Cloudflare Worker —— 离线授权码「签码 / 验码」服务
 *
 * 用 Workers 原生 WebCrypto 的 Ed25519（Secure Curves，标准 {name:'Ed25519'}）。
 * 密钥以 raw 32 字节导入：
 *   - PRIV_SEED_HEX：32 字节私钥种子（wrangler secret 注入，绝不下发）
 *   - PUB_RAW_HEX  ：32 字节公钥（同一份也内置进 App 客户端）
 *
 * 路由：
 *   GET  /health
 *   POST /activate  {order, device}     订单已付款 → 现签绑定该设备的码 → 返回 {ok,license,payload}
 *   POST /verify    {code}              校验一个码（可选；也可纯客户端验）
 *   POST /payhook   {order, token}      支付平台回调：把订单标记为已付款
 *
 * 订单/使用记录存 KV（binding=ORDERS）。部署命令见 wrangler.toml 注释。
 */
const enc = new TextEncoder()
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uDec = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const hexToBytes = (hex) => { const a = new Uint8Array(hex.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a }

async function loadKeys(env) {
  const priv = await crypto.subtle.importKey('raw', hexToBytes(env.PRIV_SEED_HEX), { name: 'Ed25519' }, false, ['sign'])
  const pub = await crypto.subtle.importKey('raw', hexToBytes(env.PUB_RAW_HEX), { name: 'Ed25519' }, true, ['verify'])
  return { priv, pub }
}
async function signPayload(priv, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)))
  const sig = await crypto.subtle.sign('Ed25519', priv, enc.encode(body))
  return body + '.' + b64u(sig)
}
async function verifyCode(pub, code) {
  const [body, sig] = String(code || '').split('.')
  if (!body || !sig) return { ok: false, payload: null }
  const ok = await crypto.subtle.verify('Ed25519', pub, b64uDec(sig), enc.encode(body))
  let payload = null
  if (ok) { try { payload = JSON.parse(new TextDecoder().decode(b64uDec(body))) } catch {} }
  return { ok, payload }
}
function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors } })
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    try {
      const { priv, pub } = await loadKeys(env)

      if (url.pathname === '/health') return json({ ok: true }, cors)

      if (url.pathname === '/verify' && req.method === 'POST') {
        const d = await req.json().catch(() => ({}))
        const r = await verifyCode(pub, d.code)
        if (!r.ok) return json({ ok: false, error: '激活码无效' }, cors, 400)
        if (r.payload?.exp && new Date(r.payload.exp) < new Date()) return json({ ok: false, error: '已过期' }, cors, 400)
        return json({ ok: true, payload: r.payload }, cors)
      }

      if (url.pathname === '/activate' && req.method === 'POST') {
        const d = await req.json().catch(() => ({}))
        const order = String(d.order || '').trim()
        const device = String(d.device || '').trim()
        if (!order) return json({ ok: false, error: '缺少订单号' }, cors, 400)
        if (!(await env.ORDERS.get('order:' + order))) return json({ ok: false, error: '订单无效或未确认付款' }, cors, 403)
        if (await env.ORDERS.get('used:' + order)) return json({ ok: false, error: '该订单已激活过，勿重复领取' }, cors, 409)
        const payload = { exp: d.exp || env.DEFAULT_EXP || '2027-12-31', bind: device || 'ANY', v: 1, order }
        const license = await signPayload(priv, payload)
        await env.ORDERS.put('used:' + order, String(Date.now()))
        return json({ ok: true, license, payload }, cors)
      }

      if (url.pathname === '/payhook' && req.method === 'POST') {
        const d = await req.json().catch(() => ({}))
        if (env.PAYHOOK_TOKEN && d.token !== env.PAYHOOK_TOKEN) return json({ ok: false, error: 'bad token' }, cors, 403)
        if (!d.order) return json({ ok: false, error: '缺 order' }, cors, 400)
        await env.ORDERS.put('order:' + String(d.order), String(Date.now()))
        return json({ ok: true }, cors)
      }

      return new Response('not found', { status: 404, headers: cors })
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, cors, 500)
    }
  },
}
