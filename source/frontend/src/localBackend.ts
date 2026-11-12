/**
 * 纯前端离线数据层：用 IndexedDB(dexie) + 静态 JSON 完全替代 FastAPI 后端。
 *
 * 唯一入口 `handleApi<T>(path, init)`：按 (method, pathname+query) 路由到与后端
 * (backend/app/main.py + kaoyan.py) 完全一致的本地实现，返回同构 JSON。
 * 题库只读（/data/*.json），用户数据写 IndexedDB。
 */
import Dexie, { type Table } from 'dexie'
import {
  examOf, trackOf, paperTitle, sectionLabel, sectionOrder,
  CET_SECTION_CN, CET_SECTION_ORDER, KAOYAN_SECTION_CN, KAOYAN_SECTION_ORDER, PARTB_VARIANT_CN,
  type Exam, type Track,
} from './exam'
import { ApiError } from './api'

// ---------------------------------------------------------------- 常量（对齐 main.py / kaoyan.py）
const BASE = (import.meta.env?.BASE_URL || '/')
const AUDIO_EDITION: string = 'WithAudio'
const OBJECTIVE_SECTIONS = new Set(['listening', 'cloze', 'matching', 'reading1', 'reading2'])
const HALF_POINTS: Record<string, number> = { cloze: 1, reading1: 4, matching: 4 }
const SCORE_RULE = '完形每题 0.5 分，阅读理解 Part A 与新题型每题 2 分；不含翻译和写作（40 分）'
const SCORE_FROM_YEAR = 2005
const ANSWER_SOURCE_OBJ = '整卷参考答案速查（仅供参考参考答案）'
const ANSWER_SOURCE_REF = '分题型参考解析（参考译文、范文，仅供参考）'
const RESULT_NOTE_KY = '正确率为客观题正确数 ÷ 已作答且有参考答案的题数；参考答案已整理，仅供参考。'
const RESULT_NOTE_CET = '正确率为客观题正确数/已作答且有标准答案的题数，非四六级考试成绩。'
const PRIMARY_NAME = '整卷参考答案速查'
const LEGACY_TRANSLATION_SOURCE = '参考段落译文'
const CHECK_LABEL: Record<string, string> = {
  external_agree: '核对资料一致', disputed_resolved: '有分歧·已复核', disputed_unresolved: '有分歧·待裁定',
  source_only: '待核对答案', manual: '已人工校正',
}
const CHECK_SUMMARY: Record<string, string> = {
  external_agree: '参考答案与 {n} 份可定位的核对资料一致（仅供参考）',
  disputed_resolved: '核对资料存在分歧，复核后保留参考答案（文本推理，仅供参考）',
  disputed_unresolved: '核对资料存在分歧，尚未裁定，暂按参考答案判分',
  source_only: '参考答案已提供，尚未找到可定位的核对资料核对',
  manual: '本题答案已由你人工校正',
}
const CHECK_ORDER = ['external_agree', 'disputed_resolved', 'disputed_unresolved', 'source_only', 'manual']

const CET_RANK: Record<string, number> = Object.fromEntries(CET_SECTION_ORDER.map((s, i) => [s, i]))
const KY_RANK: Record<string, number> = Object.fromEntries(KAOYAN_SECTION_ORDER.map((s, i) => [s, i]))

// ---------------------------------------------------------------- 正则（对齐 kaoyan.py）
const RE_KEY = /^(\d{4})-kaoyan-(1|2|historical)(?::|$)/
const RE_BLANK = /__\((\d+)\)__/g
const RE_DIRECTIONS = /^\s*(?:\d{1,2}\s*[.．]\s*)?Directions?\s*[:：]/i
const RE_QUESTION_NO = /^\s*\d{1,2}\s*[.．]\s*/
const RE_SENTENCE_END = /(?:(?<!\b[A-Z])(?<!\b(?:Mr|Ms|Dr))(?<!\bMrs)\.|[!?])["”’)]*(?=\s)/g
const RE_CHART = /\b(?:charts?|graphs?|tables?|diagrams?)\b/i
const RE_PICTURE = /\b(?:pictures?|drawings?|cartoons?|photos?|photographs?)\b/i

// ---------------------------------------------------------------- 通用工具
const clone = (x: any) => (x == null ? x : JSON.parse(JSON.stringify(x)))
const pad2 = (n: number) => String(n).padStart(2, '0')
function nowLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
function nowIsoSec(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
function nowMicro(): string {
  const d = new Date()
  return `${nowIsoSec()}.${String(d.getMilliseconds()).padStart(3, '0')}000`
}
const uuid = () => (crypto as any).randomUUID()

function fail(status: number, message: string): never {
  throw new ApiError(message, status)
}

// ---------------------------------------------------------------- Dexie
class LocalDB extends Dexie {
  sessions!: Table<any, number>
  wrong_book!: Table<any, string>
  favorites!: Table<any, string>
  notes!: Table<any, string>
  manual_fixes!: Table<any, any>
  text_marks!: Table<any, string>
  constructor() {
    super('cet-offline')
    this.version(1).stores({
      sessions: '++id, session_key, paper_id, mode, submitted_at',
      wrong_book: 'uid, resolved, last_wrong_at',
      favorites: 'uid, created_at',
      notes: 'uid, updated_at',
      manual_fixes: '[uid+field], uid',
      text_marks: 'id, paper_key, section, created_at',
    })
  }
}
const db = new LocalDB()

// ---------------------------------------------------------------- 只读题库加载与缓存
let indexCache: any = null
let metaCache: any = null
const paperCache = new Map<string, PaperView>()

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url)
  if (!r.ok) fail(r.status || 500, `静态资源加载失败：${url}`)
  return r.json()
}

async function loadIndex(): Promise<any> {
  if (!indexCache) indexCache = await fetchJson(`${BASE}data/index.json`)
  return indexCache
}
async function loadMeta(): Promise<any> {
  if (!metaCache) metaCache = await fetchJson(`${BASE}data/meta.json`)
  return metaCache
}

const paperByKey = new Map<string, any>()
const paperById = new Map<number, any>()
async function ensurePapers() {
  if (paperByKey.size) return
  const idx = await loadIndex()
  for (const p of idx.papers || []) { paperByKey.set(p.paper_key, p); paperById.set(p.id, p) }
}

// manual_fixes 覆盖（answer/stem），内存缓存；fix/import 后刷新
const fixes = new Map<string, { answer?: any; stem?: any }>()
let fixesReady = false
async function ensureFixes() {
  if (fixesReady) return
  fixes.clear()
  const rows = await db.manual_fixes.toArray()
  for (const r of rows) {
    const cur = fixes.get(r.uid) || {}
    let v: any = r.value
    if (typeof v === 'string') { try { v = JSON.parse(v) } catch { /* keep raw */ } }
    cur[r.field as 'answer' | 'stem'] = v
    fixes.set(r.uid, cur)
  }
  fixesReady = true
}

// ---------------------------------------------------------------- PaperView
interface PaperView {
  key: string
  row: any
  exam: Exam
  questions: any[] // 已应用 manual fix 的原始题行
  byUid: Map<string, any>
  materials: any[] // {section, group_key, directions, content, translation, analysis_text, status, manual_locked, source_file}
  layout: any
  sourceUrl: string | null
}

function normMaterial(m: any) {
  const content = typeof m.content_json === 'string' ? safeJson(m.content_json, {}) : (m.content_json || {})
  const translation = typeof m.translation_json === 'string' ? safeJson(m.translation_json, {}) : (m.translation_json || {})
  return {
    section: m.section, group_key: m.group_key || '', directions: m.directions || '',
    content, translation, analysis_text: m.analysis_text ?? null,
    status: m.status || 'ok', manual_locked: !!m.manual_locked, source_file: m.source_file ?? null,
  }
}
function safeJson(s: any, d: any) { try { return JSON.parse(s) } catch { return d } }

async function getView(key: string): Promise<PaperView> {
  const cached = paperCache.get(key)
  if (cached) return cached
  await ensurePapers()
  const row = paperByKey.get(key)
  if (!row) fail(404, '试卷不存在')
  const frag = await fetchJson(`${BASE}data/paper/${encodeURIComponent(key)}.json`)
  const exam: Exam = (row.exam_type as Exam) || examOf(row)
  const materials = (frag.section_materials || []).map(normMaterial)
  const questions = (frag.questions || []).map((q: any) => {
    const item: any = { ...q }
    item.options = typeof q.options_json === 'string' ? safeJson(q.options_json, []) : (q.options_json || q.options || [])
    let flags = q.flags_json
    if (typeof flags === 'string') flags = safeJson(flags, [])
    item.flags = Array.isArray(flags) ? flags : []
    item.analysis = typeof q.analysis_json === 'string' ? safeJson(q.analysis_json, {}) : (q.analysis_json || {})
    item.paper_key = key
    return applyFix(item)
  })
  const byUid = new Map<string, any>()
  for (const q of questions) byUid.set(q.uid, q)
  let layout: any = null
  if (exam === 'kaoyan') layout = paperLayout(materials, questions)
  const canonical = frag.kaoyan_canonical || {}
  const sourceUrl: string | null = canonical.source_url || null
  const view: PaperView = { key, row, exam, questions, byUid, materials, layout, sourceUrl }
  paperCache.set(key, view)
  return view
}

function applyFix(q: any): any {
  const fx = fixes.get(q.uid)
  if (!fx) return q
  const copy = { ...q }
  if ('answer' in fx) copy.answer = fx.answer
  if ('stem' in fx) copy.stem = fx.stem
  copy.manual_locked = true
  return copy
}

function invalidateViews() { paperCache.clear() }

// ---------------------------------------------------------------- kaoyan.py 移植
function texts(items: any): string[] {
  return (items || []).filter((i: any) => i && typeof i === 'object').map((i: any) => String(i.text || ''))
}
function partbVariant(directions: string | null | undefined, content: any, optionKeys: Set<string>): string {
  if (content.given_chain || content.chain_structure) return 'ordering'
  if (optionKeys.size === 2 && optionKeys.has('T') && optionKeys.has('F')) return 'tf'
  if (texts(content.paragraphs).some(t => { RE_BLANK.lastIndex = 0; return RE_BLANK.test(t) })) {
    if (/heading/i.test(directions || '')) return 'heading'
    if (/opinion|comment|statement|summar/i.test(directions || '')) return 'opinion'
    return 'gap'
  }
  return 'match'
}
function translationParagraphs(content: any): string[] {
  let paragraphs = texts(content.source_paragraphs)
  if (!paragraphs.length && content.prompt) paragraphs = String(content.prompt).split('\n\n')
  return paragraphs.filter(t => t.trim() && !RE_DIRECTIONS.test(t))
}
function passage(content: any): string[] {
  const p = content.passage
  return p ? String(p).split('\n\n') : texts(content.source_paragraphs)
}
function cleanOptions(options: any): any[] {
  return (options || []).filter((o: any) => o && typeof o === 'object').map((o: any) => ({ key: o.key, text: o.text ?? '' }))
}
function paperLayout(materials: any[], questions: any[]): any {
  const mats: Record<string, any> = {}
  for (const m of materials) mats[m.section] = m
  const layout: any = { matching: null, translation: null, sentences: [], cloze: [], options: [] }
  if (mats.cloze) layout.cloze = passage(mats.cloze.content)
  const matching = questions.filter(q => q.section === 'matching')
  if (matching.length || mats.matching) {
    const row = mats.matching
    const options = matching.map(q => (Array.isArray(q.options) ? q.options : []))
    const keys = new Set<string>()
    for (const opts of options) for (const o of opts) if (o && typeof o === 'object' && typeof o.key === 'string') keys.add(o.key)
    layout.matching = partbVariant(row ? row.directions : '', row ? row.content : {}, keys)
    layout.options = options.length ? cleanOptions(options[0]) : []
  }
  const translation = questions.filter(q => q.section === 'translation').sort((a, b) => (a.q_no || 0) - (b.q_no || 0))
  if (translation.length) {
    const paragraphs = mats.translation ? translationParagraphs(mats.translation.content) : []
    const sentence = translation.some(q => paragraphs.some(text => text.includes(`(${q.q_no})`)))
    layout.translation = sentence ? 'translation_sentence' : 'translation_passage'
    if (sentence) layout.sentences = translation.map(q => [q.q_no, q.stem || '', q.answer])
  }
  return layout
}
function questionVariant(section: string, layout: any, answer?: any): string | null {
  layout = layout || {}
  if (section === 'cloze') return 'cloze'
  if (section === 'reading1') return 'reading'
  if (section === 'matching') return layout.matching || 'match'
  if (section === 'translation') return layout.translation || (answer ? 'translation_sentence' : 'translation_passage')
  if (section === 'writing') return 'writing'
  return null
}
function kaoyanOrder(questions: any[], scope: string[]): any[] {
  const first: Record<string, number> = {}
  for (const uid of scope) { const k = uid.split(':').slice(0, -2).join(':'); if (!(k in first)) first[k] = Object.keys(first).length }
  return [...questions].sort((a, b) => {
    const ra = KY_RANK[a.section] ?? 99, rb = KY_RANK[b.section] ?? 99
    if (ra !== rb) return ra - rb
    const fa = first[a.paper_key] ?? 999, fb = first[b.paper_key] ?? 999
    if (fa !== fb) return fa - fb
    return (a.q_no || 0) - (b.q_no || 0)
  })
}
function answerSourceK(section: string): string {
  return ['cloze', 'reading1', 'matching'].includes(section) ? ANSWER_SOURCE_OBJ : ANSWER_SOURCE_REF
}
function answerWordK(section: string, options: any[], answer: any): string {
  if (section !== 'cloze' || !answer) return ''
  const hit = (options || []).find(o => o && o.key === answer)
  return hit ? (hit.text ?? '') : ''
}
function answerCheckBlock(answer: any, manualLocked: boolean, check: any, primaryUrl: string | null): any {
  let result: any
  if (!check) {
    result = {
      status: 'source_only', label: CHECK_LABEL.source_only, summary: CHECK_SUMMARY.source_only,
      basis: null, primary: { name: PRIMARY_NAME, url: primaryUrl }, external: [], ruling: null, stale: false,
    }
  } else {
    const detail = check.detail || {}
    const external = Array.isArray(detail.external) ? detail.external : []
    const status = check.status
    let summary = check.summary
    if (!summary) {
      const agree = external.filter((i: any) => i && i.verdict === 'agree').length || external.length
      summary = (CHECK_SUMMARY[status] || '').replace('{n}', String(agree))
    }
    result = {
      status, label: CHECK_LABEL[status] || status, summary,
      basis: check.basis,
      primary: detail.primary && typeof detail.primary === 'object' ? detail.primary : { name: PRIMARY_NAME, url: primaryUrl },
      external, ruling: detail.ruling && typeof detail.ruling === 'object' ? detail.ruling : null,
      stale: check.answer !== answer,
    }
  }
  if (manualLocked) { result.status = 'manual'; result.label = CHECK_LABEL.manual; result.summary = CHECK_SUMMARY.manual }
  return result
}
function checkCounts(statuses: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const s of statuses) counts[s] = (counts[s] || 0) + 1
  return Object.fromEntries(Object.keys(counts).sort((a, b) => {
    const ia = CHECK_ORDER.indexOf(a), ib = CHECK_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  }).map(k => [k, counts[k]]))
}
function points(halves: number): number { return halves % 2 === 0 ? halves / 2 : halves / 2 }
function scoreK(items: [string, string][]): any {
  const earned: Record<string, number> = {}, total: Record<string, number> = {}
  for (const [section, verdict] of items) {
    if (section in HALF_POINTS) {
      total[section] = (total[section] || 0) + HALF_POINTS[section]
      earned[section] = (earned[section] || 0) + (verdict === 'correct' ? HALF_POINTS[section] : 0)
    }
  }
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
  const by_section: Record<string, any> = {}
  for (const s of KAOYAN_SECTION_ORDER) if (s in total) by_section[KAOYAN_SECTION_CN[s]] = { earned: points(earned[s]), total: points(total[s]) }
  return { earned: points(sum(earned)), total: points(sum(total)), by_section, rule: SCORE_RULE }
}
function clip(text: string, limit = 120, anchor?: number | null): string {
  if (text.length <= limit) return text
  if (anchor == null || anchor + 4 < limit) return text.slice(0, limit - 1) + '…'
  const end = Math.min(text.length, anchor + 4 + Math.floor((limit - 6) / 2))
  if (end === text.length) return '…' + text.slice(end - (limit - 1))
  return '…' + text.slice(end - (limit - 2), end) + '…'
}
function sentenceAt(text: string, start: number, end: number): string {
  let left = 0, right = text.length
  RE_SENTENCE_END.lastIndex = 0
  for (let m: RegExpExecArray | null; (m = RE_SENTENCE_END.exec(text));) {
    if (m.index + m[0].length <= start) left = m.index + m[0].length
    else if (m.index >= end) { right = m.index + m[0].length; break }
  }
  return text.slice(left, right).trim()
}
function writingPrompt(text: string | null | undefined): string {
  return String(text || '').replace(RE_QUESTION_NO, '').split(/\r?\n/).map(l => l.split(/\s+/).filter(Boolean).join(' ')).join('\n').trim()
}
function previewK(section: string, qNo: number, stem: string | null | undefined, layout: any): string {
  layout = layout || {}
  const st = (stem || '').split(/\s+/).filter(Boolean).join(' ')
  if (section === 'cloze') {
    const marker = `__(${qNo})__`
    for (const text of layout.cloze || []) {
      const pos = text.indexOf(marker)
      if (pos >= 0) {
        let s = sentenceAt(text, pos, pos + marker.length).split(/\s+/).filter(Boolean).join(' ')
        s = s.replace(new RegExp(RE_BLANK.source, 'g'), (mm: string, n: string) => (mm === marker ? '____' : `(${n})`))
        return clip(s, 120, s.indexOf('____'))
      }
    }
  }
  if (section === 'matching' && !st) {
    const v = layout.matching
    return `${PARTB_VARIANT_CN[v] || KAOYAN_SECTION_CN.matching}第 ${qNo} ${v === 'ordering' ? '题' : '空'}`
  }
  if (section === 'translation' && layout.translation === 'translation_passage') return '英译汉（整篇）'
  if (section === 'writing') {
    const p = writingPrompt(stem).split(/\s+/).filter(Boolean).join(' ')
    return p.length <= 100 ? p : p.slice(0, 100) + '…'
  }
  return clip(st)
}
function u16(text: string, index: number): number {
  let extra = 0
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) > 0xffff) extra++
  return index + extra
}
function underlines(paragraphs: string[], sentences: any[]): [any[], number[]] {
  const found: any[] = [], missing: number[] = []
  for (const entry of sentences) {
    const qNo = entry[0], stem = entry[1]
    const target = String(stem || '').trim(), marker = `(${qNo})`
    let hit: any = null
    for (let i = 0; i < paragraphs.length; i++) {
      const text = paragraphs[i]
      let pos = target ? text.indexOf(marker) : -1
      while (pos >= 0 && hit === null) {
        let start = pos + marker.length
        while (start < text.length && /\s/.test(text[start])) start++
        if (text.startsWith(target, start)) {
          hit = { q_no: qNo, paragraph: i, marker_start: u16(text, pos), marker_end: u16(text, pos + marker.length), start: u16(text, start), end: u16(text, start + target.length) }
        }
        pos = text.indexOf(marker, pos + 1)
      }
      if (hit) break
    }
    if (hit) found.push(hit); else missing.push(qNo)
  }
  return [found, missing]
}
function splitReference(text: string | null | undefined): [string[], string | null] {
  const raw = text || ''
  const cut = raw.indexOf('【')
  const body = cut >= 0 ? raw.slice(0, cut) : raw
  const notes = cut >= 0 ? (raw.slice(cut).trim() || null) : null
  const paras: string[][] = []
  let loose: string[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line || line === '参考译文' || line.includes('复盘资产')) continue
    if (/^P\d+$/.test(line)) paras.push([])
    else if (paras.length) paras[paras.length - 1].push(line)
    else loose.push(line)
  }
  if (!paras.length && loose.length) paras.push(loose)
  return [paras.filter(p => p.length).map(p => p.join('\n')), notes]
}
function imagesOf(content: any, prompt: string): any[] {
  const alt = RE_CHART.test(prompt) && !RE_PICTURE.test(prompt) ? '作文图表' : '作文图画'
  const srcs: string[] = []
  for (const image of content.source_images || []) {
    const dl = image && typeof image === 'object' ? image.download : null
    if (dl && typeof dl === 'object' && dl.status === 200 && dl.file) {
      const name = String(dl.file).replace(/\\/g, '/').split('/').pop()
      srcs.push('/kaoyan-assets/' + name)
    }
  }
  const legacy = content.source_image
  if (typeof legacy === 'string' && legacy.startsWith('/') && !legacy.startsWith('//')) srcs.push(legacy)
  return srcs.map(src => ({ src, alt }))
}
function chainOf(content: any): any[] {
  const slots: any[] = []
  for (const slot of content.given_chain || []) {
    if (slot && typeof slot === 'object' && slot.given) slots.push({ given: String(slot.given) })
    else if (slot && typeof slot === 'object' && slot.question != null) slots.push({ q_no: Number(slot.question) })
  }
  if (!slots.length) {
    for (const slot of content.chain_structure || []) {
      if (typeof slot === 'number' || /^\d+$/.test(String(slot))) slots.push({ q_no: Number(slot) })
      else slots.push({ given: String(slot) })
    }
  }
  return slots
}
function paragraphTranslation(section: string, raw: any, count: number, includeRefs: boolean): any {
  if (!includeRefs || !['cloze', 'reading1', 'matching'].includes(section) || !count) return {}
  const data = raw && typeof raw === 'object' ? raw : {}
  let paragraphs = Array.isArray(data.paragraphs) ? data.paragraphs : data.source_paragraph_translations
  if (!Array.isArray(paragraphs) || paragraphs.length !== count || !paragraphs.every((p: any) => typeof p === 'string')) return {}
  return { paragraphs, source: data.source || LEGACY_TRANSLATION_SOURCE }
}
function materialOf(section: string, row: any, sectionDirections: string, groupCount: number, layout: any, includeRefs: boolean): any {
  const content = row.content || {}
  const group = row.group_key || 'main'
  let status = row.status
  let aligned = 0
  let body: any
  if (section === 'cloze') {
    body = { variant: 'cloze', paragraphs: passage(content) }
    aligned = body.paragraphs.length
  } else if (section === 'reading1') {
    const number = group.split('_').pop()
    body = { variant: 'reading', title: content.title || `Text ${number}`, paragraphs: passage(content) }
    aligned = body.paragraphs.length
  } else if (section === 'matching') {
    const variant = layout.matching || partbVariant(row.directions, content, new Set())
    const paragraphs = (content.paragraphs || []).filter((p: any) => p && typeof p === 'object')
    if (variant === 'ordering') {
      const chain = chainOf(content)
      body = {
        variant, paragraphs: [],
        labeled_paragraphs: paragraphs.map((p: any) => ({ label: String(p.label || ''), text: String(p.text || '') })),
        chain, given: chain.filter(s => 'given' in s).map(s => s.given).sort(), options: [],
      }
    } else {
      const shared = cleanOptions(content.shared_options)
      const options = shared.length ? shared : (layout.options || [])
      body = { variant, paragraphs: texts(paragraphs), options: variant === 'tf' ? [] : options }
    }
    aligned = paragraphs.length
  } else if (section === 'translation') {
    const paragraphs = translationParagraphs(content)
    const variant = layout.translation || 'translation_passage'
    body = { variant, paragraphs }
    if (variant === 'translation_sentence') {
      const [found, missing] = underlines(paragraphs, layout.sentences || [])
      body.underlines = found
      if (missing.length) status = 'needs_review'
      if (includeRefs) body.reference_sentences = (layout.sentences || []).filter((e: any) => e[2]).map((e: any) => ({ q_no: e[0], text: e[2] }))
    } else if (includeRefs) {
      const [refP, notes] = splitReference(content.reference_translation)
      body.reference_paragraphs = refP
      body.reference_notes = notes
    }
  } else if (section === 'writing') {
    const prompt = writingPrompt(row.directions || content.prompt)
    const title = group === 'part_b' ? '大作文 · Part B' : (group === 'part_a' && groupCount > 1 ? '小作文 · Part A' : '作文')
    body = { variant: 'writing', title, prompt, images: imagesOf(content, prompt) }
    if (includeRefs) {
      body.model_essay = content.model_essay || null
      body.model_essay_cn = String(content.model_essay_cn || '').replace(/^\s*【参考译文】\s*/, '') || null
    }
  } else {
    body = { variant: null, paragraphs: [] }
  }
  return {
    group_key: group, directions: row.directions || '', section_directions: sectionDirections,
    status, content: body,
    translation: paragraphTranslation(section, row.translation, aligned, includeRefs),
    analysis_text: null,
  }
}
function materialsK(rows: any[], layout: any, includeRefs = false): Record<string, Record<string, any>> {
  const grouped: Record<string, any[]> = {}
  for (const row of rows) (grouped[row.section] = grouped[row.section] || []).push(row)
  const out: Record<string, Record<string, any>> = {}
  for (const section of Object.keys(grouped)) {
    const groupRows = grouped[section]
    const directions = (groupRows.find(r => (r.directions || '').trim()) || {}).directions || ''
    out[section] = {}
    for (const r of groupRows) out[section][r.group_key || 'main'] = materialOf(section, r, directions, groupRows.length, layout || {}, includeRefs)
  }
  return out
}
const GROUP_REFERENCES = ['model_essay', 'model_essay_cn', 'reference_paragraphs', 'reference_notes', 'reference_sentences']
function ownReferences(sectionMaterials: Record<string, any>, question: any): Record<string, any> {
  const group = question.group_key || 'main'
  const out: Record<string, any> = {}
  for (const key of Object.keys(sectionMaterials)) {
    const material = sectionMaterials[key]
    const content = { ...material.content }
    if (key !== group) for (const f of GROUP_REFERENCES) delete content[f]
    else if (content.reference_sentences) content.reference_sentences = content.reference_sentences.filter((s: any) => s.q_no === question.q_no)
    out[key] = { ...material, content, translation: {} }
  }
  return out
}

// ---------------------------------------------------------------- 试卷辅助
function audioAvailable(row: any): boolean { return AUDIO_EDITION !== 'NoAudio' && !!row.audio_path }
function audioUrl(audioPath: string | null | undefined): string | null {
  if (!audioPath) return null
  return `${BASE}${String(audioPath).replace(/^\//, '')}`
}
function coverageNote(year: number | null | undefined): string | null {
  if (year && year >= 1998 && year <= 2001) return '原卷未收录的语法与词汇部分；题号经重新编排，与原卷不同。'
  if (year && year >= 2002 && year <= 2004) return '原卷未收录的听力部分；题号经重新编排，与原卷不同。'
  return null
}
function kaoyanPaper(row: any): any {
  return { ...row, track: trackOf(row), display_title: paperTitle(row), coverage_note: coverageNote(row.year) }
}
function paperBrief(row: any): any {
  const brief = { paper_key: row.paper_key, exam_type: row.exam_type, year: row.year, month: row.month, set_no: row.set_no }
  return row.exam_type === 'kaoyan' ? { ...brief, track: trackOf(row), display_title: paperTitle(row) } : brief
}
function questionPublic(view: PaperView, q: any, withAnswer: boolean): any {
  const exam = view.exam
  const base: any = {
    uid: q.uid, paper_key: q.paper_key, exam_type: exam, section: q.section,
    section_cn: CET_SECTION_CN[q.section] || q.section,
    q_no: q.q_no, q_index: q.q_index, qtype: q.qtype, group_key: q.group_key, stem: q.stem,
    options: q.options, status: q.status, flags: Array.isArray(q.flags) ? q.flags : [],
    source_file: q.source_file ?? null, source_page: q.source_page ?? null,
    has_answer: q.answer !== null && q.answer !== undefined, has_analysis: !!q.analysis_text,
  }
  if (exam === 'kaoyan') {
    const variant = questionVariant(q.section, view.layout, q.answer)
    base.section_cn = sectionLabel(q.section, 'kaoyan', variant)
    base.variant = variant
    base.options = cleanOptions(q.options)
    base.source_file = null
    base.source_url = q.source_file ?? null
    if (withAnswer) {
      base.answer = q.answer
      base.answer_source = answerSourceK(q.section)
      base.analysis_text = q.analysis_text
      base.answer_word = answerWordK(q.section, base.options, q.answer)
      if (['cloze', 'reading1', 'matching'].includes(q.section)) {
        const url = view.sourceUrl || (typeof q.answer_source === 'string' && q.answer_source.startsWith('http') ? q.answer_source : null)
        base.answer_check = answerCheckBlock(q.answer, !!q.manual_locked, null, url)
      }
    }
    return base
  }
  if (withAnswer) {
    base.answer = q.answer
    base.answer_source = q.answer_source
    base.analysis_text = q.analysis_text
    const ajson = q.analysis || {}
    base.answer_word = ajson.answer_word ?? ''
    if (q.qtype === 'blank' && q.manual_locked) {
      const hit = (base.options || []).find((o: any) => o && o.key === q.answer)
      base.answer_word = hit ? (hit.text ?? '') : ''
    }
  }
  return base
}

function cetSections(materials: any[]): Record<string, Record<string, any>> {
  const out: Record<string, Record<string, any>> = {}
  for (const r of materials) {
    ;(out[r.section] = out[r.section] || {})[r.group_key || 'main'] = {
      directions: r.directions, content: r.content, translation: r.translation,
      analysis_text: r.analysis_text, status: r.status,
    }
  }
  return out
}
function cetSectionsNoSource(materials: any[]): Record<string, Record<string, any>> {
  return cetSections(materials)
}

// ---------------------------------------------------------------- 会话辅助
function uidPaperKey(uid: string): string { return uid.split(':').slice(0, -2).join(':') }
function uidSection(uid: string): string { const p = uid.split(':'); return p[p.length - 2] || '' }

async function scopeUids(sess: any): Promise<string[]> {
  let scope: any
  try { scope = JSON.parse(sess.scope_json || '[]') } catch { fail(400, '练习范围数据损坏，无法恢复该会话') }
  if (!Array.isArray(scope) || scope.some((u: any) => typeof u !== 'string')) fail(400, '练习范围数据损坏，无法恢复该会话')
  if (scope.length) return [...new Set(scope)]
  const row = paperById.get(sess.paper_id)
  if (!row) return []
  const view = await getView(row.paper_key)
  const arr = [...view.questions]
  if (view.exam === 'kaoyan') arr.sort((a, b) => (a.q_no || 0) - (b.q_no || 0))
  else arr.sort((a, b) => ((CET_RANK[a.section] ?? 99) - (CET_RANK[b.section] ?? 99)) || ((a.q_index || 0) - (b.q_index || 0)))
  return arr.map(q => q.uid)
}

function choiceKeys(view: PaperView, q: any): Set<string> {
  const keys = new Set<string>()
  for (const o of q.options || []) if (o && typeof o.key === 'string') keys.add(o.key)
  if (q.qtype === 'match') {
    const m = view.materials.find(x => x.section === q.section && (x.group_key || '') === (q.group_key || ''))
    if (m) for (const p of m.content.paragraphs || []) if (p && typeof p.label === 'string') keys.add(p.label)
  }
  if (!keys.size) for (const ch of (q.qtype === 'mcq' ? 'ABCD' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')) keys.add(ch)
  return keys
}
function normalizeAnswer(view: PaperView, q: any, value: any): any {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') fail(400, '作答必须是选项字母或草稿文本')
  if (!OBJECTIVE_SECTIONS.has(q.section)) return value
  const v = value.trim().toUpperCase()
  if (!v) return null
  if (!choiceKeys(view, q).has(v)) fail(400, `${q.uid} 的选项无效`)
  return v
}
function normalizeFixValue(view: PaperView, q: any, field: string, value: any): any {
  if (field === 'answer') {
    if (!['cloze', 'matching', 'reading1', 'listening', 'reading2'].includes(q.section)) fail(400, '仅支持校正客观题的选项答案')
    return normalizeAnswer(view, q, value)
  }
  if (field === 'stem') {
    if (value !== null && (typeof value !== 'string' || value.length > 8000)) fail(400, '题干必须为不超过 8000 字符的文本或空值')
    return value
  }
  fail(400, '不支持的校正字段')
}

async function sessionOr404(sid: number): Promise<any> {
  const row = await db.sessions.get(sid)
  if (!row) fail(404, '会话不存在')
  return row
}
async function paperRowByKey(key: string): Promise<any> {
  await ensurePapers()
  const row = paperByKey.get(key)
  if (!row) fail(404, '试卷不存在')
  return row
}

// ---------------------------------------------------------------- 各接口实现
async function listPapers(q: URLSearchParams): Promise<any> {
  await ensurePapers(); const meta = await loadMeta()
  const exam = q.get('exam'); const year = q.get('year'); const month = q.get('month'); const section = q.get('section')
  let papers = [...paperByKey.values()]
  if (exam) papers = papers.filter(p => p.exam_type === exam)
  if (year) papers = papers.filter(p => String(p.year) === String(year))
  if (month) papers = papers.filter(p => String(p.month) === String(month))
  papers.sort((a, b) => (b.year - a.year) || (b.month - a.month) || (a.set_no - b.set_no))
  const allSessions = await db.sessions.toArray()
  const byPaper = new Map<number, any[]>()
  for (const s of allSessions) { if (s.mode !== 'full') continue; (byPaper.get(s.paper_id) || byPaper.set(s.paper_id, []).get(s.paper_id)!).push(s) }
  for (const arr of byPaper.values()) arr.sort((a, b) => b.id - a.id)
  const out: any[] = []
  for (const p of papers) {
    const rec = meta.papers[p.paper_key] || {}
    const qc = clone(rec.qcounts || {})
    let objN = 0, objKeyed = 0
    for (const sec of Object.keys(qc)) if (OBJECTIVE_SECTIONS.has(sec)) { objN += qc[sec].n || 0; objKeyed += qc[sec].answers || 0 }
    const row: any = { ...p }
    row.question_counts = qc
    row.objective_total = objN
    row.objective_keyed = objKeyed
    row.has_audio = audioAvailable(p)
    row.audio_edition = AUDIO_EDITION
    row.shared_sources = p.shared_sources_json ? (typeof p.shared_sources_json === 'string' ? safeJson(p.shared_sources_json, {}) : p.shared_sources_json) : {}
    const sList = byPaper.get(p.id) || []
    const latest = sList[0] || null
    let active: number | null = null, answered = 0, hasWork = false, activeUpdated: string | null = null
    if (latest && !latest.submitted_at) {
      active = latest.id
      activeUpdated = latest.updated_at || latest.started_at
      try {
        const answers = JSON.parse(latest.answers_json || '{}')
        const view = await getView(p.paper_key)
        const scope: Record<string, string> = {}
        for (const q of view.questions) scope[q.uid] = q.qtype
        const filled = Object.keys(answers).filter(uid => uid in scope && typeof answers[uid] === 'string' && answers[uid].trim())
        hasWork = filled.length > 0
        answered = filled.filter(uid => ['mcq', 'blank', 'match'].includes(scope[uid])).length
      } catch { /* ignore */ }
    }
    const lastSub = sList.find(s => s.submitted_at) || null
    row.active_session_id = active
    row.active_updated_at = activeUpdated
    row.active_answered = answered
    row.last_submitted_at = lastSub ? lastSub.submitted_at : null
    row.last_submitted_session_id = lastSub ? lastSub.id : null
    row.status = active ? (hasWork ? 'in_progress' : 'not_started') : (lastSub ? 'done' : 'not_started')
    row._filtered_out = !!(section && !(section in qc))
    if (p.exam_type === 'kaoyan') {
      row.track = trackOf(p)
      row.display_title = paperTitle(p)
      row.coverage_note = coverageNote(p.year)
      row.answer_check_counts = adjustCheckCounts(rec.answer_check_counts || {}, p.paper_key)
    }
    out.push(row)
  }
  // 与后端一致：section 过滤只置 _filtered_out 标记，不删除行（前端据此提示）
  return { papers: out, section_cn: exam === 'kaoyan' ? KAOYAN_SECTION_CN : CET_SECTION_CN }
}

function adjustCheckCounts(base: Record<string, number>, paperKey: string): Record<string, number> {
  const counts: Record<string, number> = { ...base }
  // 人工校正（manual_fixes）把对应 objective 题从 source_only 移到 manual
  let manualAdd = 0
  for (const uid of fixes.keys()) {
    if (uidPaperKey(uid) !== paperKey) continue
    const sec = uidSection(uid)
    if (['cloze', 'reading1', 'matching'].includes(sec)) manualAdd++
  }
  if (manualAdd > 0) {
    counts.manual = (counts.manual || 0) + manualAdd
    counts.source_only = Math.max(0, (counts.source_only || 0) - manualAdd)
    if (!counts.source_only) delete counts.source_only
  }
  return checkCounts(Object.entries(counts).flatMap(([k, v]) => Array(v).fill(k)))
}

async function paperDetail(key: string): Promise<any> {
  const view = await getView(key)
  const row = view.row
  if (view.exam === 'kaoyan') {
    const questions = [...view.questions].sort((a, b) => (a.q_no || 0) - (b.q_no || 0)).map(q => questionPublic(view, q, false))
    return {
      paper: kaoyanPaper(row), sections: materialsK(view.materials, view.layout, false),
      questions, raw_pdfs: [], audio_url: null,
    }
  }
  // CET paper detail 的 section 带 source_file
  const sectionsFull: any = {}
  for (const r of view.materials) {
    (sectionsFull[r.section] = sectionsFull[r.section] || {})[r.group_key || 'main'] = {
      directions: r.directions, content: r.content, translation: r.translation,
      analysis_text: r.analysis_text, status: r.status, source_file: r.source_file,
    }
  }
  const questions = [...view.questions]
    .sort((a, b) => ((CET_RANK[a.section] ?? 99) - (CET_RANK[b.section] ?? 99)) || ((a.q_index || 0) - (b.q_index || 0)))
    .map(q => questionPublic(view, q, false))
  return { paper: row, sections: sectionsFull, questions, raw_pdfs: [], audio_url: audioAvailable(row) ? audioUrl(row.audio_path) : null }
}

async function createSession(q: URLSearchParams): Promise<any> {
  const paperKey = q.get('paper_key') || ''
  const mode = q.get('mode') || 'full'
  const restart = q.get('restart') === 'true'
  const row = await paperRowByKey(paperKey)
  if (mode === 'full' && !restart) {
    const arr = (await db.sessions.where('paper_id').equals(row.id).toArray()).filter(s => s.mode === 'full').sort((a, b) => b.id - a.id)
    if (arr.length) { const s = arr[0]; return { session_id: s.id, resumed: !s.submitted_at, reviewing: !!s.submitted_at } }
  }
  const id = await db.sessions.add(newSession(row.id, mode, '[]'))
  return { session_id: id, resumed: false }
}
function newSession(paperId: number, mode: string, scopeJson: string): any {
  return {
    paper_id: paperId, mode, started_at: nowLocal(), updated_at: null, submitted_at: null,
    answers_json: '{}', current_uid: null, elapsed_sec: 0, audio_pos: 0, revealed_uids: '[]',
    result_json: null, scope_json: scopeJson, state_revision: 0, state_client_id: null,
    state_client_revision: 0, audio_paper_key: null, session_key: uuid(),
  }
}

async function createRedo(init: RequestInit): Promise<any> {
  const body = parseBody(init)
  const uidsIn: string[] = Array.isArray(body.uids) ? body.uids : []
  if (!uidsIn.length) fail(400, 'uids 为空')
  const uids = [...new Set(uidsIn)]
  const found: { uid: string; paper_key: string; exam: Exam }[] = []
  for (const uid of uids) {
    const key = uidPaperKey(uid)
    const r = paperByKey.get(key)
    if (!r) fail(404, '部分题目不存在，请刷新题目列表')
    const view = await getView(key)
    if (!view.byUid.has(uid)) fail(404, '部分题目不存在，请刷新题目列表')
    found.push({ uid, paper_key: key, exam: view.exam })
  }
  if (new Set(found.map(f => f.exam)).size > 1) fail(400, '不能把不同考试的题目放在同一次重做中，请分别重做')
  const pid = paperByKey.get(found[0].paper_key)!.id
  const mode = body.mode === 'wrong_redo' ? 'wrong_redo' : 'redo'
  const id = await db.sessions.add(newSession(pid, mode, JSON.stringify(uids)))
  return { session_id: id }
}

async function restartSession(sid: number): Promise<any> {
  const prev = await sessionOr404(sid)
  const id = await db.sessions.add(newSession(prev.paper_id, prev.mode, prev.scope_json || '[]'))
  return { session_id: id, resumed: false }
}

async function getSession(sid: number): Promise<any> {
  const sess = await sessionOr404(sid)
  const uids = await scopeUids(sess)
  const submitted = !!sess.submitted_at
  const paperKeys = new Set<string>()
  const mainRow = paperById.get(sess.paper_id)
  if (mainRow) paperKeys.add(mainRow.paper_key)
  for (const uid of uids) paperKeys.add(uidPaperKey(uid))
  const views = new Map<string, PaperView>()
  for (const key of paperKeys) { if (paperByKey.has(key) || (await ensurePapers(), paperByKey.has(key))) views.set(key, await getView(key)) }
  const keyList = [...paperKeys].sort()
  const examOfKey = (k: string) => views.get(k)?.exam || examOf(k)
  const qs: any[] = []
  for (const uid of uids) {
    const view = views.get(uidPaperKey(uid))
    const q = view?.byUid.get(uid)
    if (view && q) qs.push(questionPublic(view, q, submitted))
  }
  if (mainRow && examOfKey(mainRow.paper_key) === 'kaoyan') {
    const ordered = kaoyanOrder(qs.map(q => ({ ...q })), uids)
    qs.length = 0; qs.push(...ordered)
  } else {
    qs.sort((a, b) => ((CET_RANK[a.section] ?? 99) - (CET_RANK[b.section] ?? 99)) || ((a.q_index || 0) - (b.q_index || 0)))
  }
  const sections_by_paper: Record<string, any> = {}
  for (const key of keyList) {
    const view = views.get(key)
    if (!view) continue
    if (view.exam === 'kaoyan') sections_by_paper[key] = materialsK(view.materials, view.layout, submitted)
    else sections_by_paper[key] = cetSectionsNoSource(view.materials)
  }
  const paperRows: Record<string, any> = {}
  for (const key of keyList) { const v = views.get(key); if (v) paperRows[key] = v.row }
  const result: any = {
    session: {
      id: sess.id, paper_id: sess.paper_id, mode: sess.mode, paper_key: mainRow ? mainRow.paper_key : '',
      started_at: sess.started_at, submitted_at: sess.submitted_at,
      answers: JSON.parse(sess.answers_json || '{}'), current_uid: sess.current_uid,
      elapsed_sec: sess.elapsed_sec, audio_pos: sess.audio_pos,
      audio_paper_key: sess.audio_paper_key || (mainRow ? mainRow.paper_key : null),
      state_revision: sess.state_revision, revealed: JSON.parse(sess.revealed_uids || '[]'),
      scope: uids, result: sess.result_json ? JSON.parse(sess.result_json) : null,
    },
    paper: mainRow ? (examOfKey(mainRow.paper_key) === 'kaoyan' ? kaoyanPaper(mainRow) : mainRow) : null,
    questions: qs, sections: sections_by_paper[mainRow ? mainRow.paper_key : ''] || {},
    sections_by_paper,
    audio_by_paper: Object.fromEntries(keyList.map(k => [k, views.get(k) && audioAvailable(views.get(k)!.row) ? audioUrl(views.get(k)!.row.audio_path) : null])),
    audio_url: mainRow && audioAvailable(mainRow) ? audioUrl(mainRow.audio_path) : null,
    audio_edition: AUDIO_EDITION,
    papers_by_key: Object.fromEntries(keyList.map(k => [k, paperBrief(paperRows[k] || {})])),
    pdfs_by_paper: {},
  }
  const kyPapers = keyList.filter(k => examOfKey(k) === 'kaoyan')
  if (kyPapers.length) result.pdfs_by_paper = Object.fromEntries(kyPapers.map(k => [k, []]))
  return result
}

async function saveState(sid: number, init: RequestInit): Promise<any> {
  const body = parseBody(init)
  const sess = await sessionOr404(sid)
  if (sess.submitted_at) fail(400, '已交卷，不能再修改作答')
  const hasField = (k: string) => Object.prototype.hasOwnProperty.call(body, k)
  const clientId = hasField('client_id') ? body.client_id : null
  const clientRev = hasField('client_revision') ? body.client_revision : null
  const baseRev = hasField('base_revision') ? body.base_revision : null
  const versioned = clientId != null || clientRev != null || baseRev != null
  if (versioned) {
    if (clientId == null || clientRev == null || baseRev == null) fail(400, '保存版本字段不完整')
    if (clientId === sess.state_client_id) {
      if (clientRev <= sess.state_client_revision) return { ok: true, ignored: true, state_revision: sess.state_revision }
    } else if (baseRev !== sess.state_revision) {
      fail(409, '另一页面已修改此练习，请保留当前作答并刷新核对')
    }
  }
  const scope = await scopeUids(sess)
  const views = new Map<string, PaperView>()
  const qmap = new Map<string, { view: PaperView; q: any }>()
  for (const uid of scope) {
    if (!views.has(uidPaperKey(uid))) views.set(uidPaperKey(uid), await getView(uidPaperKey(uid)))
    const view = views.get(uidPaperKey(uid))!
    const q = view.byUid.get(uid)
    if (q) qmap.set(uid, { view, q })
  }
  const answers: Record<string, any> = JSON.parse(sess.answers_json || '{}')
  if (Array.isArray(body.answers) || (body.answers && typeof body.answers === 'object')) {
    for (const uid of Object.keys(body.answers || {})) if (!qmap.has(uid)) fail(400, '作答包含本次练习范围以外的题目')
    for (const uid of Object.keys(body.answers || {})) {
      const { view, q } = qmap.get(uid)!
      const v = normalizeAnswer(view, q, body.answers[uid])
      if (v === null || v === '') delete answers[uid]; else answers[uid] = v
    }
  }
  let cur = sess.current_uid
  if (hasField('current_uid')) cur = body.current_uid
  if (cur !== null && cur !== undefined && !qmap.has(cur)) fail(400, '当前题目不在本次练习范围内')
  const elapsed = body.elapsed_sec == null ? sess.elapsed_sec : body.elapsed_sec
  const audio = body.audio_pos == null ? sess.audio_pos : body.audio_pos
  const audioKey = body.audio_paper_key != null ? body.audio_paper_key : sess.audio_paper_key
  if (audioKey != null) {
    const rangeKeys = new Set([...qmap.values()].map(x => x.q.paper_key))
    if (!rangeKeys.has(audioKey)) fail(400, '音频所属试卷不在本次练习范围内')
  }
  const revision = sess.state_revision + 1
  await db.sessions.update(sid, {
    answers_json: JSON.stringify(answers), current_uid: cur ?? null, elapsed_sec: elapsed, audio_pos: audio,
    audio_paper_key: audioKey ?? null, state_revision: revision, state_client_id: clientId ?? null,
    state_client_revision: clientRev || 0, updated_at: nowLocal(),
  })
  return { ok: true, saved: Object.keys(answers).length, state_revision: revision }
}

async function markRevealed(sid: number, init: RequestInit): Promise<any> {
  const body = parseBody(init)
  const sess = await sessionOr404(sid)
  const uids = await scopeUids(sess)
  if (!uids.includes(body.uid)) fail(400, '题目不在本次练习范围内')
  if (sess.submitted_at) return { ok: true }
  const rev = new Set(JSON.parse(sess.revealed_uids || '[]'))
  rev.add(body.uid)
  await db.sessions.update(sid, { revealed_uids: JSON.stringify([...rev].sort()) })
  return { ok: true }
}

async function submitSession(sid: number): Promise<any> {
  const sess = await sessionOr404(sid)
  if (sess.submitted_at) return { ok: true, already: true, result: sess.result_json ? JSON.parse(sess.result_json) : null }
  let uids = await scopeUids(sess)
  const mainRow = paperById.get(sess.paper_id)
  const isKaoyan = mainRow && mainRow.exam_type === 'kaoyan'
  type E = { view: PaperView; q: any }
  const items = new Map<string, E>()
  for (const uid of uids) {
    const view = await getView(uidPaperKey(uid))
    const q = view.byUid.get(uid)
    if (q) items.set(uid, { view, q })
  }
  if (isKaoyan) {
    const ordered = kaoyanOrder([...items.values()].map(e => e.q), uids)
    uids = ordered.map(q => q.uid)
  }
  const answers = JSON.parse(sess.answers_json || '{}')
  const revealed = new Set(JSON.parse(sess.revealed_uids || '[]'))
  const detail: Record<string, any> = {}
  const per_section: Record<string, any> = {}
  const bump = (section: string) => (per_section[section] = per_section[section] || { correct: 0, wrong: 0, unanswered: 0, no_key: 0, revealed: 0 })
  for (const uid of uids) {
    const entry = items.get(uid)
    if (!entry) continue
    const q = entry.q
    const choice = answers[uid]
    const obj = OBJECTIVE_SECTIONS.has(q.section)
    if (!obj) { detail[uid] = { kind: 'subjective', text: typeof choice === 'string' ? choice : '' }; continue }
    if (!q.answer) {
      detail[uid] = { kind: 'objective', verdict: 'no_key', choice: choice || null, revealed: revealed.has(uid) }
      const st = bump(q.section); st.no_key++; st.revealed += revealed.has(uid) ? 1 : 0
      continue
    }
    const verdict = !choice ? 'unanswered' : (choice === q.answer ? 'correct' : 'wrong')
    detail[uid] = { kind: 'objective', verdict, choice: choice || null, answer: q.answer, revealed: revealed.has(uid) }
    const st = bump(q.section); st[verdict]++; if (revealed.has(uid)) st.revealed++
  }
  const vals = Object.values(detail)
  const correct = vals.filter(d => d.kind === 'objective' && d.verdict === 'correct').length
  const wrong = vals.filter(d => d.kind === 'objective' && d.verdict === 'wrong').length
  const unanswered = vals.filter(d => d.kind === 'objective' && d.verdict === 'unanswered').length
  const noKey = vals.filter(d => d.kind === 'objective' && d.verdict === 'no_key').length
  const graded = correct + wrong
  const labels = isKaoyan ? KAOYAN_SECTION_CN : CET_SECTION_CN
  const result: any = {
    submitted_at: nowIsoSec(),
    correct, wrong, unanswered, no_key: noKey,
    accuracy: graded ? Math.round((correct / graded) * 10000) / 10000 : null,
    per_section: Object.fromEntries(Object.entries(per_section).map(([k, v]) => [labels[k] || k, v])),
    detail,
    note: isKaoyan ? RESULT_NOTE_KY : RESULT_NOTE_CET,
  }
  if (isKaoyan && sess.mode === 'full' && (mainRow!.year || 0) >= SCORE_FROM_YEAR) {
    result.score = scoreK(Object.entries(detail).filter(([, d]) => d.kind === 'objective').map(([uid, d]) => [items.get(uid)!.q.section, d.verdict]))
  }
  await db.sessions.update(sid, { submitted_at: nowLocal(), result_json: JSON.stringify(result) })
  for (const [uid, d] of Object.entries(detail)) {
    if (d.kind !== 'objective') continue
    if (d.verdict === 'wrong') {
      const changed = nowMicro()
      const cur = await db.wrong_book.get(uid)
      if (cur) await db.wrong_book.update(uid, { wrong_count: (cur.wrong_count || 1) + 1, resolved: 0, session_id: sid, last_wrong_at: changed, updated_at: changed })
      else await db.wrong_book.put({ uid, session_id: sid, wrong_count: 1, first_wrong_at: changed, last_wrong_at: changed, resolved: 0, updated_at: changed })
    } else if (d.verdict === 'correct' && !d.revealed) {
      const cur = await db.wrong_book.get(uid)
      if (cur) await db.wrong_book.update(uid, { resolved: 1, updated_at: nowMicro() })
    }
  }
  return { ok: true, result }
}

async function history(limit: number): Promise<any> {
  const allSessions = (await db.sessions.toArray()).filter(s => s.submitted_at)
  allSessions.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)) || b.id - a.id)
  const out: any[] = []
  for (const s of allSessions.slice(0, limit)) {
    const row = paperById.get(s.paper_id)
    if (!row) continue
    const res = s.result_json ? JSON.parse(s.result_json) : {}
    const d: any = {
      id: s.id, mode: s.mode, started_at: s.started_at, submitted_at: s.submitted_at,
      paper_key: row.paper_key, year: row.year, month: row.month, set_no: row.set_no,
      correct: res.correct ?? null, wrong: res.wrong ?? null, accuracy: res.accuracy ?? null,
    }
    if (row.exam_type === 'kaoyan') {
      d.exam_type = 'kaoyan'; d.track = trackOf(row); d.display_title = paperTitle(row)
      if (res.score && typeof res.score === 'object') d.score = { earned: res.score.earned ?? null, total: res.score.total ?? null }
    }
    out.push(d)
  }
  return { history: out }
}

async function questionDetail(uid: string, session: number | null): Promise<any> {
  const key = uidPaperKey(uid)
  const view = await getView(key)
  const q = view.byUid.get(uid)
  if (!q) fail(404, '题目不存在')
  const pub = questionPublic(view, q, true)
  if (view.exam === 'kaoyan') {
    let mats = materialsK(view.materials.filter(m => m.section === q.section), view.layout, true)[q.section] || {}
    if (session != null) {
      const s = await db.sessions.get(session)
      if (!s || !s.submitted_at) mats = ownReferences(mats, q)
    }
    pub.materials = Object.values(mats)
  } else {
    pub.materials = view.materials.filter(m => m.section === q.section).map(m => ({
      group_key: m.group_key, directions: m.directions, content: m.content, translation: m.translation, analysis_text: m.analysis_text,
    }))
  }
  const note = await db.notes.get(uid)
  const fav = await db.favorites.get(uid)
  pub.note = note ? note.text : ''
  pub.favorite = !!fav
  return pub
}

async function addFavorite(uid: string): Promise<any> {
  const view = await getView(uidPaperKey(uid))
  if (!view.byUid.has(uid)) fail(404, '题目不存在')
  if (!(await db.favorites.get(uid))) await db.favorites.put({ uid, created_at: nowLocal() })
  return { ok: true }
}
async function delFavorite(uid: string): Promise<any> {
  await db.favorites.delete(uid)
  return { ok: true }
}
async function saveNote(uid: string, init: RequestInit): Promise<any> {
  const body = parseBody(init)
  const view = await getView(uidPaperKey(uid))
  if (!view.byUid.has(uid)) fail(404, '题目不存在')
  const text = String(body.text ?? '')
  if (text.length > 10000) fail(400, '笔记过长')
  await db.notes.put({ uid, text, updated_at: nowMicro() })
  return { ok: true }
}
async function manualFix(uid: string, init: RequestInit): Promise<any> {
  const body = parseBody(init)
  const view = await getView(uidPaperKey(uid))
  const q = view.byUid.get(uid)
  if (!q) fail(404, '题目不存在')
  const value = normalizeFixValue(view, q, body.field, body.value)
  await db.manual_fixes.put({ uid, field: body.field, value: JSON.stringify(value), created_at: nowMicro() })
  // 立即应用覆盖
  const cur = fixes.get(uid) || {}
  cur[body.field as 'answer' | 'stem'] = value
  fixes.set(uid, cur)
  const raw = view.byUid.get(uid)!
  if (body.field in raw) raw[body.field] = value
  raw.manual_locked = true
  return { ok: true }
}

async function reviewWrong(): Promise<any> {
  const rows = await db.wrong_book.toArray()
  rows.sort((a, b) => (a.resolved - b.resolved) || String(b.last_wrong_at || '').localeCompare(String(a.last_wrong_at || '')))
  const out: any[] = []
  for (const r of rows) {
    const view = await getView(uidPaperKey(r.uid))
    const q = view.byUid.get(r.uid)
    if (!q) continue
    const base: any = {
      uid: r.uid, wrong_count: r.wrong_count, last_wrong_at: r.last_wrong_at, resolved: !!r.resolved,
      section: q.section, section_cn: CET_SECTION_CN[q.section] || q.section, q_no: q.q_no,
      stem: (q.stem || '').slice(0, 120), paper_key: q.paper_key, options: q.options,
      has_answer: q.answer !== null && q.answer !== undefined, status: q.status, flags: Array.isArray(q.flags) ? q.flags : [],
    }
    out.push(reviewRow(view, r, q, base))
  }
  return { wrong: out }
}
async function reviewFavorites(): Promise<any> {
  const rows = await db.favorites.toArray()
  rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  const out: any[] = []
  for (const r of rows) {
    const view = await getView(uidPaperKey(r.uid))
    const q = view.byUid.get(r.uid)
    if (!q) continue
    const base: any = {
      uid: r.uid, created_at: r.created_at, section: q.section, section_cn: CET_SECTION_CN[q.section] || q.section,
      q_no: q.q_no, stem: (q.stem || '').slice(0, 120), paper_key: q.paper_key, options: q.options,
    }
    out.push(reviewRow(view, r, q, base))
  }
  return { favorites: out }
}
function reviewRow(view: PaperView, _row: any, q: any, base: any): any {
  if (view.exam !== 'kaoyan') return base
  const variant = questionVariant(q.section, view.layout)
  return {
    ...base,
    section_cn: sectionLabel(q.section, 'kaoyan', variant),
    options: cleanOptions(base.options),
    exam_type: 'kaoyan', year: view.row.year, month: view.row.month, set_no: view.row.set_no,
    track: trackOf(view.row), display_title: paperTitle(view.row),
    group_key: q.group_key, variant, preview: previewK(q.section, q.q_no, q.stem, view.layout),
  }
}

async function reportApi(exam: string | null): Promise<any> {
  const meta = await loadMeta()
  const papers = [...paperByKey.values()].filter(p => (exam ? p.exam_type === exam : true))
  if (exam === 'kaoyan') return kaoyanReport(papers, meta)
  // CET 报告：从 meta 派生（后端读取 data/import-report.json，本仓库缺失；离线从静态派生更可用）
  let questions = 0, objQ = 0, objA = 0, subj = 0, essays = 0, trans = 0
  const rows: any[] = []
  for (const p of papers) {
    const rec = meta.papers[p.paper_key] || {}
    const qc = rec.qcounts || {}
    const sections: any = {}
    for (const sec of Object.keys(qc)) {
      const n = qc[sec].n || 0, a = qc[sec].answers || 0
      questions += n
      if (OBJECTIVE_SECTIONS.has(sec)) { objQ += n; objA += a }
      if (sec === 'writing' || sec === 'translation') subj += n
      sections[sec] = { questions: n, answers: a }
      if (sec === 'writing') sections[sec].essay = !!rec.has_model_essay
      if (sec === 'translation') sections[sec].reference_translation = !!rec.has_reference_translation
    }
    if (rec.has_model_essay) essays++
    if (rec.has_reference_translation) trans++
    rows.push({ paper_key: p.paper_key, sections })
  }
  const summary = {
    papers: papers.length, questions,
    objective: { questions: objQ, with_answers: objA }, subjective: subj,
    writing_with_model_essay: essays, translation_with_reference: trans,
    generated_at: meta.generated_at,
  }
  const issues = (meta.cet_issues || []).filter((it: any) => {
    if (!exam) return true
    const key = it.paper_key || ''
    return examOf(key) === exam
  }).map((it: any) => ({ paper_key: it.paper_key, section: it.section ?? null, uid: it.uid ?? null, level: it.level || 'warn', message: it.message || '' }))
  return { summary, papers: rows, issues }
}

function kaoyanReport(papers: any[], meta: any): any {
  const ky = papers.sort((a, b) => (b.year - a.year) || (a.set_no - b.set_no))
  let questions = 0, objQ = 0, objA = 0, subj = 0, essays = 0, trans = 0
  const statusAll: string[] = []
  const rows: any[] = []
  let latestCreated: string | null = null
  for (const p of ky) {
    const rec = meta.papers[p.paper_key] || {}
    const qc = rec.qcounts || {}
    const sections: any = {}
    for (const sec of KAOYAN_SECTION_ORDER) {
      if (!(sec in qc)) continue
      const n = qc[sec].n || 0, a = qc[sec].answers || 0
      questions += n
      if (OBJECTIVE_SECTIONS.has(sec)) { objQ += n; objA += a }
      if (sec === 'writing' || sec === 'translation') subj += n
      sections[sec] = { questions: n, answers: a }
      if (sec === 'writing') sections[sec].essay = !!rec.has_model_essay
      if (sec === 'translation') sections[sec].reference_translation = !!rec.has_reference_translation
    }
    if (rec.has_model_essay) essays++
    if (rec.has_reference_translation) trans++
    const checkCountsObj = adjustCheckCounts(rec.answer_check_counts || {}, p.paper_key)
    for (const [st, cnt] of Object.entries(checkCountsObj)) for (let i = 0; i < (cnt as number); i++) statusAll.push(st)
    const created = p.created_at || null
    if (created && (!latestCreated || created > latestCreated)) latestCreated = created
    rows.push({
      paper_key: p.paper_key, track: trackOf(p), display_title: paperTitle(p), coverage_note: coverageNote(p.year),
      sections, answer_check_counts: checkCountsObj,
    })
  }
  const summary = {
    papers: ky.length, questions,
    objective: { questions: objQ, with_answers: objA }, subjective: subj,
    writing_with_model_essay: essays, translation_with_reference: trans,
    generated_at: latestCreated ? String(latestCreated).replace(' ', 'T') : null,
  }
  const issues: any[] = []
  for (const p of ky) {
    const note = coverageNote(p.year)
    if (note) issues.push({ paper_key: p.paper_key, section: null, uid: null, level: 'info', message: note })
  }
  return {
    summary,
    answer_checks: checkCounts(statusAll),
    answer_sources: null,
    papers: rows,
    issues,
  }
}

async function getMarks(q: URLSearchParams): Promise<any> {
  const paperKey = q.get('paper_key') || ''
  const section = q.get('section') || ''
  const rows = (await db.text_marks.toArray()).filter(m => m.paper_key === paperKey && m.section === section)
  rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  return { marks: rows }
}
async function allMarks(q: URLSearchParams): Promise<any> {
  const exam = q.get('exam')
  const rows = await db.text_marks.toArray()
  rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  const out: any[] = []
  for (const m of rows) {
    const paper = paperByKey.get(m.paper_key)
    const examType = paper ? paper.exam_type : examOf(m.paper_key)
    if (exam && examType !== exam) continue
    out.push({
      ...m, exam_type: examType,
      year: paper ? paper.year : null, month: paper ? paper.month : null, set_no: paper ? paper.set_no : null,
      paper_missing: !paper, section_cn: examType === 'kaoyan' ? (KAOYAN_SECTION_CN[m.section] || m.section) : (CET_SECTION_CN[m.section] || m.section),
    })
  }
  return { marks: out }
}
function validateMark(row: any): any {
  if (!row || typeof row !== 'object') fail(400, '标记记录无效')
  const id = String(row.id || '')
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) fail(400, '标记记录无效')
  const paperKey = String(row.paper_key || '')
  if (!paperKey || !paperByKey.has(paperKey)) fail(400, '标记记录无效')
  if (typeof row.start_offset !== 'number' || typeof row.end_offset !== 'number') fail(400, '标记记录无效')
  const text = String(row.text || '')
  if (!text || row.end_offset <= row.start_offset) fail(400, '标记记录无效')
  if (row.end_offset - row.start_offset !== text.length) fail(400, '标记记录无效')
  return {
    id, paper_key: paperKey, section: String(row.section || ''), passage_index: Number(row.passage_index) || 0,
    start_offset: row.start_offset, end_offset: row.end_offset, text, created_at: String(row.created_at || ''),
  }
}
async function addMark(init: RequestInit): Promise<any> {
  const body = parseBody(init)
  const row = validateMark(body)
  await db.text_marks.put(row)
  return row
}
async function deleteMark(id: string): Promise<any> {
  await db.text_marks.delete(id)
  return { ok: true }
}

async function backupExport(): Promise<any> {
  const sessions = await db.sessions.toArray()
  const withPaper = sessions.map(s => {
    const row = paperById.get(s.paper_id)
    return { ...s, paper_key: row ? row.paper_key : null }
  })
  return {
    format: 'cet6-backup', version: 1, exported_at: nowIsoSec(),
    sessions: withPaper,
    wrong_book: await db.wrong_book.toArray(),
    favorites: await db.favorites.toArray(),
    notes: await db.notes.toArray(),
    text_marks: await db.text_marks.toArray(),
    manual_fixes: await db.manual_fixes.toArray(),
  }
}

function timeNumber(v: any): number { if (!v) return -Infinity; const t = Date.parse(v); return Number.isFinite(t) ? t : -Infinity }

async function backupImport(init: RequestInit, merge: boolean): Promise<any> {
  const body = parseBody(init)
  const data = body.data || {}
  if (data.format !== 'cet6-backup' || data.version !== 1) fail(400, '文件格式或备份版本不正确')
  const counts = { sessions: 0, wrong_book: 0, favorites: 0, notes: 0, text_marks: 0, manual_fixes: 0 }
  try {
    const inSessions: any[] = Array.isArray(data.sessions) ? data.sessions : []
    const inWrong: any[] = Array.isArray(data.wrong_book) ? data.wrong_book : []
    const inFav: any[] = Array.isArray(data.favorites) ? data.favorites : []
    const inNotes: any[] = Array.isArray(data.notes) ? data.notes : []
    const inMarks: any[] = Array.isArray(data.text_marks) ? data.text_marks : []
    const inFixes: any[] = Array.isArray(data.manual_fixes) ? data.manual_fixes : []
    const existing = merge ? await db.sessions.toArray() : []
    const byKey = new Map<string, number>()
    for (const s of existing) if (s.session_key) byKey.set(s.session_key, s.id)
    let nextId = Math.max(0, ...existing.map(s => s.id), ...inSessions.map(s => Number(s.id) || 0)) + 1
    const idMap = new Map<number, number>()
    const imports: any[] = []
    for (const s of inSessions) {
      if (s.id == null || s.paper_id == null) fail(400, '备份记录无效，已回滚本次导入')
      const paperKey = s.paper_key
      const paper = paperKey ? paperByKey.get(paperKey) : paperById.get(s.paper_id)
      if (!paper) fail(400, '备份所需的试卷尚未导入，未修改任何数据')
      const sk = s.session_key || null
      const dup = sk ? byKey.get(sk) : null
      if (dup != null) { idMap.set(s.id, dup); continue }
      let newId = Number(s.id)
      if (existing.some(e => e.id === newId) || imports.some(i => i.id === newId)) { newId = nextId++ }
      const rec = { ...newSession(paper.id, s.mode || 'full', s.scope_json || '[]'), ...s, id: newId, paper_id: paper.id, session_key: sk || uuid() }
      delete rec.paper_key
      idMap.set(s.id, newId)
      imports.push(rec)
    }
    const scopes = new Map<number, Set<string>>()
    for (const s of existing) scopes.set(s.id, new Set(JSON.parse(s.scope_json || '[]')))
    for (const s of imports) scopes.set(s.id, new Set(JSON.parse(s.scope_json || '[]')))
    const resolvedWrong = inWrong.map(r => { const sid = r.session_id != null ? (idMap.get(r.session_id) ?? r.session_id) : null; return { ...r, session_id: sid } })
    if (!merge) {
      await db.wrong_book.clear(); await db.sessions.clear(); await db.favorites.clear(); await db.notes.clear(); await db.text_marks.clear()
    }
    for (const s of imports) { await db.sessions.put(s); counts.sessions++ }
    for (const row of resolvedWrong) {
      const cur = await db.wrong_book.get(row.uid)
      const incomingTime = row.updated_at || row.last_wrong_at
      if (!cur) { await db.wrong_book.put({ uid: row.uid, session_id: row.session_id ?? null, wrong_count: Number(row.wrong_count) || 1, first_wrong_at: row.first_wrong_at ?? null, last_wrong_at: row.last_wrong_at ?? null, resolved: Number(row.resolved) || 0, updated_at: incomingTime ?? null }); counts.wrong_book++ }
      else {
        const next = { ...cur }
        next.wrong_count = Math.max(cur.wrong_count || 0, Number(row.wrong_count) || 1)
        if (timeNumber(row.last_wrong_at) > timeNumber(cur.last_wrong_at)) { next.last_wrong_at = row.last_wrong_at; next.session_id = row.session_id ?? cur.session_id }
        if (row.first_wrong_at && (!cur.first_wrong_at || timeNumber(row.first_wrong_at) < timeNumber(cur.first_wrong_at))) next.first_wrong_at = row.first_wrong_at
        if (timeNumber(incomingTime) > timeNumber(cur.updated_at || cur.last_wrong_at)) { next.resolved = Number(row.resolved) || 0; next.updated_at = incomingTime }
        if (JSON.stringify(next) !== JSON.stringify(cur)) { await db.wrong_book.put(next); counts.wrong_book++ }
      }
    }
    for (const row of inFav) { if (!(await db.favorites.get(row.uid))) { await db.favorites.put({ uid: row.uid, created_at: row.created_at ?? null }); counts.favorites++ } }
    for (const row of inNotes) {
      const cur = await db.notes.get(row.uid)
      if (cur && timeNumber(row.updated_at) <= timeNumber(cur.updated_at)) continue
      await db.notes.put({ uid: row.uid, text: row.text || '', updated_at: row.updated_at ?? null }); counts.notes++
    }
    for (const m of inMarks) { if (!(await db.text_marks.get(m.id))) { await db.text_marks.put(m); counts.text_marks++ } }
    const retained = new Set<string>()
    for (const f of await db.manual_fixes.toArray()) retained.add(`${f.uid}|${f.field}`)
    for (const fx of inFixes) {
      const cur = await db.manual_fixes.get([fx.uid, fx.field])
      if (cur && timeNumber(fx.created_at) <= timeNumber(cur.created_at)) continue
      let val = fx.value; if (typeof val === 'string') { try { val = JSON.parse(val) } catch { /* raw */ } }
      await db.manual_fixes.put({ uid: fx.uid, field: fx.field, value: JSON.stringify(val), created_at: fx.created_at ?? null })
      retained.delete(`${fx.uid}|${fx.field}`)
      counts.manual_fixes++
    }
    fixesReady = false
    await ensureFixes()
    invalidateViews()
    return { ok: true, imported: counts, retained_manual_fixes: retained.size }
  } catch (e) {
    if (e instanceof ApiError) throw e
    fail(400, '备份记录无效，已回滚本次导入')
  }
}

async function health(): Promise<any> {
  return { ok: true, instance_id: 'source', version: '1.5.0', audio_edition: AUDIO_EDITION }
}

// ---------------------------------------------------------------- 工具：请求体
function parseBody(init?: RequestInit): any {
  const raw = init?.body
  if (raw == null) return {}
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return {} } }
  return {}
}

// ---------------------------------------------------------------- 路由
export async function handleApi<T = any>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || 'GET').toUpperCase()
  const url = new URL(path, 'http://local.invalid')
  const pathname = url.pathname
  const query = url.searchParams
  const dec = (s: string) => decodeURIComponent(s)

  await ensurePapers(); await loadMeta(); await ensureFixes()

  let m: RegExpMatchArray | null
  // 试卷库
  if (method === 'GET' && pathname === '/api/papers') return (await listPapers(query)) as T
  if (method === 'GET' && (m = pathname.match(/^\/api\/papers\/(.+)$/))) return (await paperDetail(dec(m[1]))) as T

  // 会话
  if (method === 'POST' && pathname === '/api/sessions') return (await createSession(query)) as T
  if (method === 'POST' && pathname === '/api/sessions/redo') return (await createRedo(init!)) as T
  if (method === 'POST' && (m = pathname.match(/^\/api\/sessions\/(\d+)\/restart$/))) return (await restartSession(Number(m[1]))) as T
  if (method === 'POST' && (m = pathname.match(/^\/api\/sessions\/(\d+)\/reveal$/))) return (await markRevealed(Number(m[1]), init!)) as T
  if (method === 'POST' && (m = pathname.match(/^\/api\/sessions\/(\d+)\/submit$/))) return (await submitSession(Number(m[1]))) as T
  if (method === 'GET' && (m = pathname.match(/^\/api\/sessions\/(\d+)\/result$/))) {
    const s = await sessionOr404(Number(m[1]))
    if (!s.result_json) fail(400, '尚未交卷')
    return JSON.parse(s.result_json) as T
  }
  if (method === 'GET' && (m = pathname.match(/^\/api\/sessions\/(\d+)$/))) return (await getSession(Number(m[1]))) as T
  if ((method === 'PUT' || method === 'POST') && (m = pathname.match(/^\/api\/sessions\/(\d+)$/))) return (await saveState(Number(m[1]), init!)) as T

  // 历史
  if (method === 'GET' && pathname === '/api/history') {
    const limitRaw = Number(query.get('limit') || 100)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))
    return (await history(limit)) as T
  }

  // 单题
  if (method === 'GET' && (m = pathname.match(/^\/api\/questions\/([^/]+)$/))) {
    const sid = query.get('session')
    return (await questionDetail(dec(m[1]), sid ? Number(sid) : null)) as T
  }
  if (method === 'POST' && (m = pathname.match(/^\/api\/questions\/([^/]+)\/fix$/))) return (await manualFix(dec(m[1]), init!)) as T

  // 收藏 / 笔记
  if (method === 'POST' && (m = pathname.match(/^\/api\/favorites\/([^/]+)$/))) return (await addFavorite(dec(m[1]))) as T
  if (method === 'DELETE' && (m = pathname.match(/^\/api\/favorites\/([^/]+)$/))) return (await delFavorite(dec(m[1]))) as T
  if (method === 'PUT' && (m = pathname.match(/^\/api\/notes\/([^/]+)$/))) return (await saveNote(dec(m[1]), init!)) as T

  // 复习
  if (method === 'GET' && pathname === '/api/review/wrong') return (await reviewWrong()) as T
  if (method === 'GET' && pathname === '/api/review/favorites') return (await reviewFavorites()) as T

  // 报告
  if (method === 'GET' && pathname === '/api/report') return (await reportApi(query.get('exam'))) as T

  // 标记
  if (method === 'GET' && pathname === '/api/marks/all') return (await allMarks(query)) as T
  if (method === 'GET' && pathname === '/api/marks') return (await getMarks(query)) as T
  if (method === 'POST' && pathname === '/api/marks') return (await addMark(init!)) as T
  if (method === 'DELETE' && (m = pathname.match(/^\/api\/marks\/([^/]+)$/))) return (await deleteMark(dec(m[1]))) as T

  // 备份
  if (method === 'GET' && pathname === '/api/backup/export') return (await backupExport()) as T
  if (method === 'POST' && pathname === '/api/backup/import') {
    const merge = query.get('merge') !== 'false'
    return (await backupImport(init!, merge)) as T
  }

  // 媒体 / 健康
  if (method === 'GET' && (m = pathname.match(/^\/api\/audio\/(.+)$/))) {
    const row = paperByKey.get(dec(m[1]))
    if (!row) fail(404, '试卷不存在')
    if (!audioAvailable(row)) fail(404, '该套次无听力音频')
    return { audio_url: audioUrl(row.audio_path) } as T
  }
  if (method === 'GET' && pathname === '/api/pdf') {
    fail(404, '尚未安装这份原 PDF')
  }
  if (method === 'GET' && pathname === '/api/health') return (await health()) as T
  if (method === 'POST' && pathname === '/api/local/shutdown') return { stopping: true } as T

  fail(404, `未实现的接口：${method} ${pathname}`)
}
