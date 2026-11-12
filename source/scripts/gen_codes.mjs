/**
 * 批量生成激活码 → scripts/codes.txt（用于"预生成卡密 + 自动发货"模式）
 *
 * 用法：
 *   node scripts/gen_codes.mjs <数量> <到期日> <绑定:ANY|DEVICE>
 * 例：
 *   node scripts/gen_codes.mjs 1000 2027-12-31 ANY
 *
 * 注意：私钥只在本地，绝不进 APK。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PRIV = crypto.createPrivateKey(fs.readFileSync(path.join(DIR, 'license_private.pem')))
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function issue(payload) {
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = crypto.sign(null, Buffer.from(body), PRIV)
  return body + '.' + b64url(sig)
}

const N = Number(process.argv[2] || 10)
const EXP = process.argv[3] || '2027-12-31'
const BIND = process.argv[4] || 'ANY'

const out = []
for (let i = 0; i < N; i++) out.push(issue({ exp: EXP, bind: BIND, v: 1, seq: i + 1 }))
const file = path.join(DIR, 'codes.txt')
fs.writeFileSync(file, out.join('\n') + '\n', 'utf8')
console.log(`已生成 ${N} 个码 → ${file}  (exp=${EXP}, bind=${BIND})`)
console.log('前 3 个：'); out.slice(0, 3).forEach((c) => console.log('  ' + c))
