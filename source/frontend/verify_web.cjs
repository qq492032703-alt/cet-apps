const puppeteer = require('puppeteer-core')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const URL = process.argv[2] || 'http://127.0.0.1:8102/'
;(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
  const p = await b.newPage()
  await p.setViewport({ width: 430, height: 900 })
  const errs = []
  p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()) })
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message))
  p.on('requestfailed', r => errs.push('REQFAIL: ' + r.url() + ' ' + (r.failure() && r.failure().errorText)))
  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  let matched = false
  try {
    await p.waitForFunction(() => {
      const t = document.body.innerText || ''
      return t.includes('开始') || t.includes('继续') || t.includes('已完成') || t.includes('套') && document.querySelectorAll('button').length > 6
    }, { timeout: 40000 })
    matched = true
  } catch (e) { /* keep going, dump what we have */ }
  const txt = await p.evaluate(() => (document.body.innerText || '').slice(0, 1200))
  const btns = await p.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(Boolean).slice(0, 30))
  await p.screenshot({ path: 'C:\\Users\\Administrator\\Desktop\\cet-practice\\home_real.png' })
  console.log('MATCHED>>>', matched)
  console.log('BTNS>>>', JSON.stringify(btns))
  console.log('TEXT>>>', txt.replace(/\n+/g, ' | '))
  console.log('ERRS>>>', errs.slice(0, 25).join('\n'))
  await b.close()
})().catch(e => { console.error('FATAL', e); process.exit(1) })
