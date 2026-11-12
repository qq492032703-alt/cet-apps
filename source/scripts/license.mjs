/**
 * 离线激活码签发/校验工具（无需服务器）。
 *
 * 原理：Ed25519 非对称签名。
 *   - 私钥（license_private.pem）只在你手里，用来「签发」激活码。
 *   - 公钥（license_public.txt）内置进 App，用来「验证」激活码。
 *   - App 只有公钥，无法伪造新码；买家也伪造不了。全程不联网。
 *
 * 用法：
 *   node scripts/license.mjs keygen                        # 首次：生成一对密钥（只做一次，妥善保管私钥）
 *   node scripts/license.mjs issue '{"exp":"2027-12-31","bind":"ANY","v":1}'   # 签发一个码
 *   node scripts/license.mjs verify <码>                   # 本地自检（模拟 App 端验证）
 *
 * 码的格式： base64url(payloadJSON) + "." + base64url(signature)
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const KEY = path.join(DIR, 'license_private.pem')
const PUB = path.join(DIR, 'license_public.txt')

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4), 'base64')

function keygen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const b64 = b64url(publicKey.export({ type: 'spki', format: 'der' }))
  fs.writeFileSync(PUB, b64)
  console.log('生成完毕。私钥: ' + KEY + '（只留在你本地，切勿放进 APK）')
  console.log('PUBLIC_KEY_B64=' + b64 + '  ← 这个公钥嵌入 App')
}

function issue(payload) {
  const priv = crypto.createPrivateKey(fs.readFileSync(KEY))
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = crypto.sign(null, Buffer.from(body), priv)
  return body + '.' + b64url(sig)
}

function verify(code) {
  const [body, sig] = code.split('.')
  const pub = crypto.createPublicKey({ key: unb64url(fs.readFileSync(PUB, 'utf8').trim()), format: 'der', type: 'spki' })
  const ok = crypto.verify(null, Buffer.from(body), pub, unb64url(sig))
  const payload = JSON.parse(unb64url(body).toString())
  return { ok, payload }
}

const [, , cmd, arg] = process.argv
if (cmd === 'keygen') keygen()
else if (cmd === 'issue') { let a = arg; if (!a) { try { a = fs.readFileSync(0, 'utf8') } catch { a = '' } } console.log('LICENSE=' + issue(JSON.parse(a || '{}'))) }
else if (cmd === 'verify') { const r = verify(arg); console.log('VERIFY=' + r.ok, 'payload=' + JSON.stringify(r.payload)) }
else console.log('usage: node scripts/license.mjs keygen | issue <json> | verify <code>')
