/** API 访问层：全部后端接口的薄封装。离线版：全部请求调度到本地 IndexedDB 实现。 */
import type { Exam } from './exam'
import { handleApi } from './localBackend'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  // 纯前端离线模式：不再发起任何 HTTP 请求，直接走 localBackend（IndexedDB + 静态 JSON）。
  // 失败时 localBackend 抛 ApiError(msg, status)，语义与原 fetch 分支一致。
  return handleApi<T>(path, init)
}

export const listPapers = (params: URLSearchParams = new URLSearchParams()) =>
  api(`/api/papers?${params}`)
export const paperDetail = (key: string) => api(`/api/papers/${key}`)
export const createSession = (paperKey: string, restart = false) =>
  api(`/api/sessions?paper_key=${encodeURIComponent(paperKey)}&restart=${restart}`, { method: 'POST' })
export const restartSession = (sid: number) =>
  api(`/api/sessions/${sid}/restart`, { method: 'POST' })
export const createRedo = (uids: string[]) =>
  api('/api/sessions/redo', { method: 'POST', body: JSON.stringify({ uids }) })
export const getSession = (sid: number) => api(`/api/sessions/${sid}`)
export const saveState = (sid: number, body: object) =>
  api(`/api/sessions/${sid}`, { method: 'PUT', body: JSON.stringify(body) })
export const markRevealed = (sid: number, uid: string) =>
  api(`/api/sessions/${sid}/reveal`, { method: 'POST', body: JSON.stringify({ uid }) })
export const submitSession = (sid: number) =>
  api(`/api/sessions/${sid}/submit`, { method: 'POST' })
// The practice page passes its session: before submission a kaoyan reveal then returns only that question's references.
export const questionDetail = (uid: string, sid?: number) =>
  api(`/api/questions/${encodeURIComponent(uid)}${sid ? `?session=${sid}` : ''}`)
export const addFavorite = (uid: string) =>
  api(`/api/favorites/${encodeURIComponent(uid)}`, { method: 'POST' })
export const delFavorite = (uid: string) =>
  api(`/api/favorites/${encodeURIComponent(uid)}`, { method: 'DELETE' })
export const saveNote = (uid: string, text: string) =>
  api(`/api/notes/${encodeURIComponent(uid)}`, { method: 'PUT', body: JSON.stringify({ text }) })
export const fixQuestion = (uid: string, field: string, value: any) =>
  api(`/api/questions/${encodeURIComponent(uid)}/fix`, { method: 'POST', body: JSON.stringify({ field, value }) })
export const wrongBook = () => api('/api/review/wrong')
export const favoritesList = () => api('/api/review/favorites')
// One request covers every board; the Review page filters by exam on the client.
export const historyList = () => api('/api/history?limit=1000')
export const reportApi = (exam?: Exam) => api(`/api/report${exam ? `?exam=${encodeURIComponent(exam)}` : ''}`)
export const backupImport = (data: object, merge: boolean) =>
  api(`/api/backup/import?merge=${merge}`, { method: 'POST', body: JSON.stringify({ data }) })
export const allMarks = (exam?: Exam) => api(`/api/marks/all${exam ? `?exam=${encodeURIComponent(exam)}` : ''}`)
export const deleteMark = (id: string) => api(`/api/marks/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** Kaoyan answer-check statuses (CONTRACT §4) as the API counts them, in display order; `manual` = a local correction. */
export const ANSWER_CHECK_ORDER = ['external_agree', 'disputed_resolved', 'disputed_unresolved', 'source_only', 'manual'] as const
export type AnswerCheckStatus = typeof ANSWER_CHECK_ORDER[number]
/** Badge text, identical to the backend `label`. Reference answers are never called 官方 or 标准. */
export const ANSWER_CHECK_LABEL: Record<AnswerCheckStatus, string> = {
  external_agree: '核对资料一致', disputed_resolved: '有分歧·已复核', disputed_unresolved: '有分歧·待裁定', source_only: '待核对答案', manual: '已人工校正',
}
/** Default explanation per status, worded for a count of questions rather than one question. */
export const ANSWER_CHECK_NOTE: Record<AnswerCheckStatus, string> = {
  external_agree: '参考答案与可定位的核对资料一致',
  disputed_resolved: '核对资料存在分歧，复核后保留参考答案（文本推理，仅供参考）',
  disputed_unresolved: '核对资料存在分歧，尚未裁定，暂按参考答案判分',
  source_only: '参考答案已提供，尚未找到可定位的核对资料核对',
  manual: '答案已由你人工校正',
}
/** Counts per status in display order (unknown statuses last), zero counts dropped. */
export function answerCheckEntries(counts: Record<string, number> | null | undefined): [string, number][] {
  const order: readonly string[] = ANSWER_CHECK_ORDER
  const rank = (s: string) => { const i = order.indexOf(s); return i < 0 ? order.length : i }
  return Object.entries(counts || {}).filter(([, n]) => Number(n) > 0).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
}
export const answerCheckLabel = (status: string) => ANSWER_CHECK_LABEL[status as AnswerCheckStatus] || status
