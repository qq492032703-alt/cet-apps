/**
 * 从本地私钥/公钥导出「Cloudflare Worker 可用的原始密钥」。
 *
 * Cloudflare WebCrypto 的 Ed25519（Secure Curves 标准）用 raw 32 字节导入最稳。
 * 本脚本输出：
 *   PRIV_SEED_HEX   ← 存成 Worker secret（wrangler secret put PRIV_SEED_HEX）
 *   PUB_RAW_HEX     ← 存成 Worker secret / 直接写进客户端
 *   PRIVATE_JWK / PUBLIC_JWK  ← 备用（若用 jwk 导入）
 *
 * 用法：node scripts/export_raw_keys.mjs
 * 注意：输出含私钥，只在本机复制，别外发、别提交仓库。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const priv = crypto.createPrivateKey(fs.readFileSync(path.join(DIR, 'license_private.pem')))
const pubB64u = fs.readFileSync(path.join(DIR, 'license_public.txt'), 'utf8').trim()
const pubDer = Buffer.from(pubB64u.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const pub = crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' })

const jwkPriv = priv.export({ format: 'jwk' }) // { crv, d(seed, b64url), x(pub) }
const jwkPub = pub.export({ format: 'jwk' })
const seedHex = Buffer.from(jwkPriv.d, 'base64url').toString('hex')
const pubHex = Buffer.from(jwkPub.x, 'base64url').toString('hex')

console.log('PRIV_SEED_HEX=' + seedHex)
console.log('PUB_RAW_HEX=' + pubHex)
console.log('PRIVATE_JWK=' + JSON.stringify(jwkPriv))
console.log('PUBLIC_JWK=' + JSON.stringify(jwkPub))

// 自检：用导出的 raw 重新构造密钥并签验一次，确保与现有 license 格式互通
const seed = Buffer.from(seedHex, 'hex')
const rawPriv = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: jwkPriv.d, x: jwkPub.x }, format: 'jwk' })
const rawPub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwkPub.x }, format: 'jwk' })
const body = 'selftest.' + Date.now()
const sig = crypto.sign(null, Buffer.from(body), rawPriv)
const okv = crypto.verify(null, Buffer.from(body), rawPub, sig)
console.log('SELFTEST_VERIFY=' + okv + '  (seed ' + seed.length + ' bytes / pub ' + Buffer.from(pubHex, 'hex').length + ' bytes)')
