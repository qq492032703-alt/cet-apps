// 临时自测：用 esbuild 打包 localBackend.ts + fake-indexeddb，在 node 中真实跑 handleApi 全链路。
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

// 1) 打包
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/localBackend.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'node20',
  outfile: path.join(OUT, 'localBackend.mjs'),
  define: { 'import.meta.env': '{"BASE_URL":"/"}' },
  logLevel: 'silent',
})

// 2) fake IndexedDB
await import('fake-indexeddb/auto')

// 3) fetch shim 读 public 目录
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

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}
import assert from 'node:assert'

const { handleApi } = await import('./.selftest/localBackend.mjs')
const call = (p, init) => handleApi(p, init)
const J = (o) => JSON.stringify(o)

try {
  // ---- A. 静态索引 / 分片命中 ----
  console.log('\n[A] 静态数据与分片命中')
  const rawIndex = JSON.parse(await fsp.readFile(path.join(PUB, 'data/index.json'), 'utf8'))
  ok('index.json 可解析, papers=168', Array.isArray(rawIndex.papers) && rawIndex.papers.length === 168, `got ${rawIndex.papers.length}`)
  let missing = []
  for (const p of rawIndex.papers) {
    const file = path.join(PUB, 'data/paper', encodeURIComponent(p.paper_key) + '.json')
    if (!fs.existsSync(file)) missing.push(p.paper_key)
  }
  ok('所有 168 paper 分片按 encodeURIComponent(paper_key) 命中', missing.length === 0, `missing=${J(missing.slice(0, 5))}`)
  const meta = JSON.parse(await fsp.readFile(path.join(PUB, 'data/meta.json'), 'utf8'))
  ok('meta.papers 覆盖全部 168 卷', Object.keys(meta.papers).length === 168, `got ${Object.keys(meta.papers).length}`)

  // ---- B. listPapers ----
  console.log('\n[B] GET /api/papers')
  const lp = await call('/api/papers?exam=cet6')
  ok('cet6 列表非空且 section_cn=听力', lp.papers.length > 0 && lp.section_cn.listening === '听力', `n=${lp.papers.length}`)
  const first = lp.papers[0]
  ok('行含 question_counts/objective_total/status/has_audio', 'question_counts' in first && 'objective_total' in first && 'status' in first && 'has_audio' in first)
  const lpKy = await call('/api/papers?exam=kaoyan')
  ok('考研行含 track/display_title/coverage_note', lpKy.papers.every(p => p.track && p.display_title) && lpKy.papers.length > 0)
  ok('考研 section_cn 为完形填空', lpKy.section_cn.cloze === '完形填空')

  // ---- C. CET paperDetail ----
  console.log('\n[C] CET paperDetail + 会话全生命周期')
  const pd = await call('/api/papers/2023-06-1')
  ok('paperDetail.paper_key', pd.paper.paper_key === '2023-06-1')
  ok('questions 无 answer 泄漏', pd.questions.length > 0 && !('answer' in pd.questions[0]), `q0keys=${Object.keys(pd.questions[0] || {}).slice(0,5)}`)
  ok('questions 已排序(听力在前)', pd.questions[0].section === 'listening')
  ok('sections 含 7 段', Object.keys(pd.sections).length >= 5, `secs=${Object.keys(pd.sections).join(',')}`)

  const cs = await call('/api/sessions?paper_key=2023-06-1&restart=true', { method: 'POST' })
  ok('createSession 返回 session_id', typeof cs.session_id === 'number', J(cs))
  const sid = cs.session_id
  const gs = await call(`/api/sessions/${sid}`)
  ok('getSession.questions 数量>0', gs.questions.length > 0)
  ok('getSession.session.paper_key', gs.session.paper_key === '2023-06-1')
  ok('getSession.sections_by_paper 有该卷', !!gs.sections_by_paper['2023-06-1'])
  ok('getSession.audio_edition=WithAudio', gs.audio_edition === 'WithAudio')

  // 取 5 道听力题真实答案
  const listenUids = gs.questions.filter(q => q.section === 'listening').slice(0, 5).map(q => q.uid)
  const answers = {}
  let correctCount = 0, wrongCount = 0, unansweredCount = 0
  const details = []
  for (let i = 0; i < listenUids.length; i++) {
    const d = await call(`/api/questions/${encodeURIComponent(listenUids[i])}`)
    details.push(d)
    if (i < 3 && d.answer) { answers[listenUids[i]] = d.answer; correctCount++ }
    else if (i === 3 && d.answer) {
      const other = d.answer === 'A' ? 'B' : 'A'
      answers[listenUids[i]] = other; wrongCount++
    } else { unansweredCount++ }
  }
  ok('questionDetail 带 answer（含答案）', details.every(d => 'answer' in d))

  const sv = await call(`/api/sessions/${sid}`, { method: 'PUT', body: J({ answers, current_uid: listenUids[0], elapsed_sec: 12, audio_pos: 3, client_id: 'c1', client_revision: 1, base_revision: 0 }) })
  ok('saveState 首次 state_revision=1', sv.ok && sv.state_revision === 1 && sv.ignored !== true, J(sv))
  const sv2 = await call(`/api/sessions/${sid}`, { method: 'PUT', body: J({ answers, elapsed_sec: 13, client_id: 'c1', client_revision: 1, base_revision: 1 }) })
  ok('saveState 同 client 旧 revision 被忽略', sv2.ignored === true, J(sv2))
  // 409：不同 client 且 base 过期
  let got409 = false
  try { await call(`/api/sessions/${sid}`, { method: 'PUT', body: J({ answers, client_id: 'c2', client_revision: 1, base_revision: 0 }) }) }
  catch (e) { got409 = e.status === 409 }
  ok('saveState 版本冲突抛 409', got409)

  const sub = await call(`/api/sessions/${sid}/submit`, { method: 'POST' })
  ok('submit.ok + result', sub.ok && sub.result, J({ ok: sub.ok, r: sub.result && { c: sub.result.correct, w: sub.result.wrong } }))
  ok('判分 correct=3', sub.result.correct === 3, `correct=${sub.result.correct}`)
  ok('判分 wrong=1', sub.result.wrong === 1, `wrong=${sub.result.wrong}`)
  ok('accuracy=0.75', sub.result.accuracy === 0.75, `acc=${sub.result.accuracy}`)
  ok('per_section 用中文键', Object.keys(sub.result.per_section).includes('听力'))
  ok('result.note 存在', typeof sub.result.note === 'string' && sub.result.note.length > 0)
  const res2 = await call(`/api/sessions/${sid}/result`)
  ok('GET result 返回同结构', res2.correct === 3)

  // ---- D. 复习 / 报告 / 历史 ----
  console.log('\n[D] review / report / history / favorites / notes / fix')
  const wr = await call('/api/review/wrong')
  ok('wrong 含刚错的题', wr.wrong.some(w => answers[w.uid] && w.uid === listenUids[3]), `n=${wr.wrong.length}`)
  const hist = await call('/api/history?limit=1000')
  ok('history 含本次提交', hist.history.some(h => h.id === sid && h.paper_key === '2023-06-1'))
  const repC = await call('/api/report?exam=cet6')
  ok('CET report.summary.objective 有字段', repC.summary && repC.summary.objective && typeof repC.summary.objective.questions === 'number')
  ok('CET report.papers 数组', Array.isArray(repC.papers) && repC.papers.length > 0)
  const favUid = gs.questions[0].uid
  await call(`/api/favorites/${encodeURIComponent(favUid)}`, { method: 'POST' })
  const fl = await call('/api/review/favorites')
  ok('favorites 收藏生效', fl.favorites.some(f => f.uid === favUid))
  await call(`/api/notes/${encodeURIComponent(favUid)}`, { method: 'PUT', body: J({ text: '我的笔记' }) })
  const qd2 = await call(`/api/questions/${encodeURIComponent(favUid)}`)
  ok('notes 读取生效', qd2.note === '我的笔记' && qd2.favorite === true)

  // ---- E. 考研 ----
  console.log('\n[E] 考研链路与材料规整')
  const pdK = await call('/api/papers/2024-kaoyan-1')
  ok('考研 paper 有 track/display_title', !!pdK.paper.track && !!pdK.paper.display_title, J(pdK.paper.display_title))
  ok('考研 questions 有 variant', pdK.questions.some(q => q.variant), `sample=${pdK.questions[0] && pdK.questions[0].variant}`)
  ok('考研 sections 含 reading1 或 cloze', Object.keys(pdK.sections).includes('reading1') || Object.keys(pdK.sections).includes('cloze'), Object.keys(pdK.sections).join(','))
  const clozeMat = pdK.sections.cloze && Object.values(pdK.sections.cloze)[0]
  ok('cloze 材料 content.paragraphs 数组', clozeMat && Array.isArray(clozeMat.content.paragraphs), J(clozeMat && clozeMat.content && clozeMat.content.variant))
  const matchMat = pdK.sections.matching && Object.values(pdK.sections.matching)[0]
  ok('matching 材料有 variant', matchMat && !!matchMat.content.variant, J(matchMat && matchMat.content && matchMat.content.variant))

  const csK = await call('/api/sessions?paper_key=2024-kaoyan-1&restart=true', { method: 'POST' })
  const sidK = csK.session_id
  const gsK = await call(`/api/sessions/${sidK}`)
  ok('考研 getSession questions 有 variant', gsK.questions.some(q => q.variant))
  // 答几道 cloze（qtype blank）
  const clozeUids = gsK.questions.filter(q => q.section === 'cloze').slice(0, 4).map(q => q.uid)
  const ansK = {}
  for (const uid of clozeUids) {
    const d = await call(`/api/questions/${encodeURIComponent(uid)}`)
    if (d.answer) ansK[uid] = d.answer
  }
  await call(`/api/sessions/${sidK}`, { method: 'PUT', body: J({ answers: ansK, client_id: 'k1', client_revision: 1, base_revision: 0 }) })
  const subK = await call(`/api/sessions/${sidK}/submit`, { method: 'POST' })
  ok('考研 submit 有 score(2024>=2005 full)', subK.result && subK.result.score && typeof subK.result.score.earned === 'number', J(subK.result && subK.result.score))
  ok('考研 result.note 已中性化', typeof subK.result.note === 'string' && subK.result.note.length > 0 && !subK.result.note.includes('懒笔记'))
  const repK = await call('/api/report?exam=kaoyan')
  ok('考研 report 有 answer_checks 聚合', repK.answer_checks && typeof repK.answer_checks === 'object')
  ok('考研 report.papers 带 display_title', repK.papers.length > 0 && !!repK.papers[0].display_title)

  // 考研单题 materials（matching）
  const uK = gsK.questions.find(q => q.section === 'matching')
  if (uK) {
    const qdK = await call(`/api/questions/${encodeURIComponent(uK.uid)}?session=${sidK}`)
    ok('考研 questionDetail 返回 materials 数组', Array.isArray(qdK.materials), `n=${qdK.materials && qdK.materials.length}`)
  }

  // ---- F. 标记 ----
  console.log('\n[F] marks')
  const mark = { id: crypto.randomUUID(), paper_key: '2023-06-1', section: 'reading1', passage_index: 0, start_offset: 0, end_offset: 3, text: 'abc', created_at: new Date().toISOString() }
  const added = await call('/api/marks', { method: 'POST', body: J(mark) })
  ok('addMark 返回行', added.id === mark.id)
  const allM = await call('/api/marks/all?exam=cet6')
  ok('allMarks 含新增且带 section_cn', allM.marks.some(m => m.id === mark.id && m.section_cn === '仔细阅读一'), `n=${allM.marks.length}`)
  const bySec = await call('/api/marks?paper_key=2023-06-1&section=reading1')
  ok('getMarks 按 section 命中', bySec.marks.some(m => m.id === mark.id))
  await call(`/api/marks/${mark.id}`, { method: 'DELETE' })
  const afterDel = await call('/api/marks?paper_key=2023-06-1&section=reading1')
  ok('deleteMark 生效', !afterDel.marks.some(m => m.id === mark.id))

  // ---- G. 备份 ----
  console.log('\n[G] backup export/import')
  const exp = await call('/api/backup/export')
  ok('export format/version', exp.format === 'cet6-backup' && exp.version === 1)
  ok('export 含 sessions 且有 paper_key', Array.isArray(exp.sessions) && exp.sessions.length > 0 && 'paper_key' in exp.sessions[0])
  ok('export 含 wrong_book/notes/favorites', Array.isArray(exp.wrong_book) && Array.isArray(exp.notes) && Array.isArray(exp.favorites))
  const imp = await call('/api/backup/import?merge=true', { method: 'POST', body: J({ data: exp }) })
  ok('import merge 返回 imported 计数', imp.ok && imp.imported && typeof imp.imported.sessions === 'number', J(imp.imported))

  // ---- H. health ----
  console.log('\n[H] health')
  const h = await call('/api/health')
  ok('health ok+version', h.ok === true && h.version === '1.5.0' && h.audio_edition === 'WithAudio')

} catch (e) {
  fail++
  console.log('\n[FATAL] ' + (e && e.stack ? e.stack : e))
}

console.log(`\n==== 结果: PASS=${pass} FAIL=${fail} ====`)
process.exit(fail ? 1 : 0)
