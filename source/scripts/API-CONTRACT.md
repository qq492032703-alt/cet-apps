# CET 练习后端 HTTP 接口精确契约（离线化复刻用）

> 目标：用前端 IndexedDB 完全替代 `backend/app`（FastAPI + SQLite）时，逐字段 1:1 复刻后端行为。
> 依据源码：`backend/app/main.py`(1668 行)、`backend/app/db.py`(225 行)、`backend/app/kaoyan.py`(487 行)、`frontend/src/api.ts` 及各页面/组件。所有字段名、类型、默认值、文案均按源码原样抄录。
> 服务仅监听 `127.0.0.1`；路由前缀 `/api`；静态前端由同一服务托管（`app.mount("/", StaticFiles(...))`，不属 `/api`）。

---

## 0. 通用约定（api.ts 层）

`frontend/src/api.ts` 唯一的传输函数：

```ts
export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const r = await fetch(path, { ...init, headers })
  if (!r.ok) {
    let msg = `${r.status}`
    try {
      const detail = (await r.json()).detail
      if (typeof detail === 'string') msg = detail
      else if (Array.isArray(detail)) msg = detail.map(d => [d.loc?.join('.'), d.msg].filter(Boolean).join('：')).join('；') || msg
    } catch { /* 非 JSON 失败仅用状态码 */ }
    throw new ApiError(msg, r.status)
  }
  return r.json()
}
```

- 默认请求头 `Content-Type: application/json`（`sendBeacon` 关闭页面时单独用 `Blob`）。
- 成功响应一律为 JSON，直接 `r.json()`。
- 失败（`!r.ok`）从响应体读 `detail`：
  - `detail` 为 **string** → 错误消息直接用该字符串（`HTTPException(status, "文案")` 走这里）。
  - `detail` 为 **数组** → 是 FastAPI 422 校验错误，`[{loc:[...], msg, type}]`，前端拼成 `"loc.join('.')：msg"` 用 `；` 连接（`RequestValidationError` 自定义 handler，见下）。
- `ApiError(status)` 携带 HTTP 状态码；前端在多处依赖 `status===409` 判定 "另一页面已保存"。
- 全局 422 handler：`{"detail": exc.errors()}`，其中浮点用 `value if math.isfinite(value) else str(value)` 编码（保证 NaN/Inf 输入仍返回 422 而非序列化崩溃）。

错误文案表（`HTTPException`，JSON `{"detail": "<文案>"}`）：

| 场景 | status | detail |
|---|---|---|
| 试卷不存在 | 404 | `试卷不存在` |
| 题目不存在 | 404 | `题目不存在` |
| 会话不存在 | 404 | `会话不存在` |
| 即将交卷后改作答 | 400 | `已交卷，不能再修改作答` |
| 保存版本字段不完整 | 400 | `保存版本字段不完整` |
| 保存版本冲突 | 409 | `另一页面已修改此练习，请保留当前作答并刷新核对` |
| 作答超出练习范围 | 400 | `作答包含本次练习范围以外的题目` |
| 当前题目不在范围 | 400 | `当前题目不在本次练习范围内` |
| 音频试卷不在范围 | 400 | `音频所属试卷不在本次练习范围内` |
| 选项无效 | 400 | `{uid} 的选项无效` |
| 作答类型错 | 400 | `作答必须是选项字母或草稿文本` |
| 仅客观题可改答案 | 400 | `仅支持校正客观题的选项答案` |
| 题干超限 | 400 | `题干必须为不超过 8000 字符的文本或空值` |
| 不支持的校正字段 | 400 | `不支持的校正字段` |
| 重做空 | 400 | `uids 为空` |
| 重做跨考试 | 400 | `不能把不同考试的题目放在同一次重做中，请分别重做` |
| 重做有缺题 | 404 | `部分题目不存在，请刷新题目列表` |
| 练习范围损坏 | 400 | `练习范围数据损坏，无法恢复该会话` |
| 未交卷取结果 | 400 | `尚未交卷` |
| 标记无效 | 400 | `标记记录无效` |
| 尚未生成导入报告 | 404 | `尚未生成导入报告` |
| 非法路径 | 403 | `非法路径` |
| 音频无(NoAudio) | 404 | `当前为无听力音频版，题目、录音原文和解析仍可使用` |
| 无音频 | 404 | `该套次无听力音频` |
| 音频文件缺失 | 404 | `音频文件不存在` |
| 本机关闭未授权 | 403 | `仅允许本机启动器停止此实例` |
| 本机关闭未由启动器 | 503 | `未由便携启动器启动` |
| 备份各校验失败 | 400 | 各带 `，未修改任何数据` 后缀（见 §13） |

`/api/pdf` 未安装时特殊：**不是** JSON，而是 `HTMLResponse(status_code=404)`（见 §12）。

---

## 1. 常量与枚举

```python
SECTION_CN = {"listening":"听力","cloze":"选词填空","matching":"长篇阅读",
              "reading1":"仔细阅读一","reading2":"仔细阅读二","writing":"写作","translation":"翻译"}
SECTION_ORDER = ["listening","cloze","matching","reading1","reading2","writing","translation"]
OBJECTIVE_SECTIONS = {"listening","cloze","matching","reading1","reading2"}
ExamType = Literal["cet4","cet6","kaoyan"]
AUDIO_EDITION = os.environ.get("CET_AUDIO_EDITION", "WithAudio")   # 或 "NoAudio"
```

- 题型 `qtype` 取值：`mcq`（单选）、`blank`（选词/填空）、`match`（匹配/段落匹配）、`essay`（写作）、`translation`（翻译）。
- 题目 `status` 取值：`ok` / `needs_review` / `missing`。
- 会话 `mode` 取值：`full`（整卷）/ `redo`（错题重做）/ `wrong_redo`（错题重做，历史兼容）。
- 试卷 `exam_type` 取值：`cet4` / `cet6` / `kaoyan`。
- 考研卷别 `track` 取值：`one`（英语一）/ `two`（英语二）/ `historical`（统考）。
- `kaoyan.SECTION_CN = {"cloze":"完形填空","reading1":"阅读理解","matching":"新题型","translation":"翻译","writing":"写作"}`
- `kaoyan.SECTION_ORDER = ["cloze","reading1","matching","translation","writing"]`
- `kaoyan.PARTB_VARIANT_CN = {"ordering":"排序","gap":"七选五","heading":"小标题","opinion":"观点概括","match":"信息匹配","tf":"判断正误"}`
- 答案核验状态 `status`：`external_agree` / `disputed_resolved` / `disputed_unresolved` / `source_only` / `manual`。

`_section_cn(section, exam)`：考研走 `kaoyan.section_label`，否则 `SECTION_CN`。

---

## 2. SQLite 全部表结构（14 张表）

> `DB_PATH = os.environ.get("CET6_DB_PATH", <project>/data/cet6.db)`；`connect()` 设 `row_factory=Row`、`PRAGMA foreign_keys=ON`；`SCHEMA` 含 `PRAGMA journal_mode=WAL;`。`init_db()` 用 `executescript(SCHEMA)` 后做列迁移（见 §2.15）。

### 2.1 text_marks（文章标记 / 划线）
```sql
CREATE TABLE IF NOT EXISTS text_marks (
    id TEXT PRIMARY KEY,
    paper_key TEXT NOT NULL,
    section TEXT NOT NULL,
    passage_index INTEGER NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

### 2.2 meta（键值元数据）
```sql
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```
用到 key：`kaoyan_answer_checks`（JSON 字符串，供 `/api/report?exam=kaoyan` 的 `answer_sources`）。

### 2.3 papers（试卷）
```sql
CREATE TABLE IF NOT EXISTS papers (
    id INTEGER PRIMARY KEY,
    paper_key TEXT UNIQUE NOT NULL,      -- 例: 2023-06-1 / 2024-kaoyan-1 / cet4-2023-06-1
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    set_no INTEGER NOT NULL,
    has_listening INTEGER NOT NULL DEFAULT 0,
    has_cloze INTEGER NOT NULL DEFAULT 0,
    has_matching INTEGER NOT NULL DEFAULT 0,
    has_reading1 INTEGER NOT NULL DEFAULT 0,
    has_reading2 INTEGER NOT NULL DEFAULT 0,
    has_writing INTEGER NOT NULL DEFAULT 0,
    has_translation INTEGER NOT NULL DEFAULT 0,
    audio_path TEXT,                     -- 相对题库根目录 ROOT
    import_version TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
-- 迁移列（init_db 追加）：
--   exam_type TEXT NOT NULL DEFAULT 'cet6'
--   shared_sources_json TEXT NOT NULL DEFAULT '{}'
```

### 2.4 materials（原卷/解析 PDF 等文件登记）
```sql
CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY,
    paper_id INTEGER NOT NULL REFERENCES papers(id),
    section TEXT NOT NULL,               -- listening/cloze/matching/reading1/reading2/writing/translation/full
    kind TEXT NOT NULL,                  -- question=真题 / analysis=解析
    file_path TEXT NOT NULL,             -- 相对 ROOT
    pages INTEGER,
    checksum TEXT,
    file_mtime REAL,
    imported_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(paper_id, section, kind, file_path)
);
```

### 2.5 questions（题目）
```sql
CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY,
    uid TEXT UNIQUE NOT NULL,            -- paper_key:section:q_no 稳定 ID
    paper_id INTEGER NOT NULL REFERENCES papers(id),
    paper_key TEXT NOT NULL,
    section TEXT NOT NULL,
    section_order INTEGER NOT NULL DEFAULT 0,
    q_no INTEGER,                        -- 原卷题号；作文/翻译为 1
    q_index INTEGER NOT NULL,            -- 该题型内序号（0 起）
    qtype TEXT NOT NULL,                 -- mcq/blank/match/essay/translation
    group_key TEXT,                      -- 共享材料分组（同 passage/词库/段落组/听力篇目）
    stem TEXT,
    options_json TEXT,                   -- [{key:'A', text:'...'}, ...]
    answer TEXT,                         -- 'A'/'N' 等
    answer_source TEXT,
    analysis_json TEXT,                  -- {定位,信号,解析,翻译, answer_word,...}
    analysis_text TEXT,
    source_file TEXT,
    source_page INTEGER,
    status TEXT NOT NULL DEFAULT 'ok',
    flags_json TEXT,
    import_version TEXT,
    manual_locked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_q_paper ON questions(paper_id);
CREATE INDEX IF NOT EXISTS idx_q_section ON questions(paper_id, section);
```

### 2.6 section_materials（共享材料：passage/词库/段落/transcript/写作 directions 等）
```sql
CREATE TABLE IF NOT EXISTS section_materials (
    id INTEGER PRIMARY KEY,
    paper_id INTEGER NOT NULL REFERENCES papers(id),
    section TEXT NOT NULL,
    group_key TEXT NOT NULL DEFAULT '',
    directions TEXT,
    content_json TEXT,                   -- 结构化共享材料
    translation_json TEXT,
    analysis_text TEXT,
    source_file TEXT,
    source_page INTEGER,
    status TEXT NOT NULL DEFAULT 'ok',
    manual_locked INTEGER NOT NULL DEFAULT 0,
    UNIQUE(paper_id, section, group_key)
);
```

### 2.7 sessions（做题会话）
```sql
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    paper_id INTEGER NOT NULL REFERENCES papers(id),
    mode TEXT NOT NULL DEFAULT 'full',   -- full/redo/wrong_redo
    started_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT,
    submitted_at TEXT,
    answers_json TEXT NOT NULL DEFAULT '{}',   -- uid -> 选项字母 或 作文/翻译草稿文本
    current_uid TEXT,
    elapsed_sec INTEGER NOT NULL DEFAULT 0,
    audio_pos REAL NOT NULL DEFAULT 0,
    revealed_uids TEXT NOT NULL DEFAULT '[]',
    result_json TEXT
);
-- 迁移列：
--   scope_json TEXT NOT NULL DEFAULT '[]'
--   state_revision INTEGER NOT NULL DEFAULT 0
--   state_client_id TEXT
--   state_client_revision INTEGER NOT NULL DEFAULT 0
--   audio_paper_key TEXT
--   session_key TEXT   -- 之后填 uuid，建唯一索引 idx_session_key
```

### 2.8 wrong_book（错题本）
```sql
CREATE TABLE IF NOT EXISTS wrong_book (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL,
    session_id INTEGER,
    wrong_count INTEGER NOT NULL DEFAULT 1,
    first_wrong_at TEXT DEFAULT (datetime('now','localtime')),
    last_wrong_at TEXT DEFAULT (datetime('now','localtime')),
    resolved INTEGER NOT NULL DEFAULT 0,
    UNIQUE(uid)
);
-- 迁移列：updated_at TEXT
```

### 2.9 favorites / 2.10 notes
```sql
CREATE TABLE IF NOT EXISTS favorites (
    uid TEXT NOT NULL PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS notes (
    uid TEXT NOT NULL PRIMARY KEY,
    text TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
);
```

### 2.11 import_issues（导入异常）
```sql
CREATE TABLE IF NOT EXISTS import_issues (
    id INTEGER PRIMARY KEY,
    paper_key TEXT NOT NULL,
    section TEXT,
    uid TEXT,
    level TEXT NOT NULL,                 -- warn/error
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
```

### 2.12 manual_fixes（人工校正台账）
```sql
CREATE TABLE IF NOT EXISTS manual_fixes (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(uid, field)
);
```

### 2.13 answer_checks（答案核验，题库元数据，不进备份；接口只读）
```sql
CREATE TABLE IF NOT EXISTS answer_checks (
    uid TEXT PRIMARY KEY,
    status TEXT NOT NULL,            -- external_agree/disputed_resolved/disputed_unresolved/source_only
    basis TEXT,                      -- text/printed_options/letter
    answer TEXT,                     -- 核对时的答案字母；与当前 answer 不同即过期(stale)
    summary TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    source_version TEXT NOT NULL
);
```

### 2.14 kaoyan_canonical（考研原始存档；`document_json` ≈72MB，接口从不读它）
```sql
CREATE TABLE IF NOT EXISTS kaoyan_canonical (
    paper_id INTEGER PRIMARY KEY REFERENCES papers(id),
    source_slug TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL,
    source_url TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    document_json TEXT NOT NULL
);
```

### 2.15 迁移与旧库差异（init_db）
- 在 `papers / sessions / wrong_book` 上按上表"迁移列"逐列 `ALTER TABLE ... ADD COLUMN`（先 `PRAGMA table_info` 判存在）。
- 迁移中若会话 `session_key` 为空/NULL → 补 `uuid4()`；随后 `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_key ON sessions(session_key)`。
- **旧库可能缺表**：`answer_checks`、`kaoyan_canonical` 是后加的表；读取前一律用 `_has_table(conn, name)` 判定（`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`），缺失时按"无核验记录"降级（status 记为 `source_only`）。

---

## 3. 后端内部纯函数（复刻必读）

### 3.1 题目公共序列化 `_question_public(r, with_answer=False, exam=None, ky=None)`
基础字段（所有题型都返回）：
```json
{
  "uid": str, "paper_key": str, "exam_type": "cet4|cet6|kaoyan",
  "section": str, "section_cn": str, "q_no": int, "q_index": int, "qtype": str,
  "group_key": str|null, "stem": str|null,
  "options": [ {"key": str, "text": str} ],
  "status": str, "flags": [ ... ],
  "source_file": str|null, "source_page": int|null,
  "has_answer": bool, "has_analysis": bool
}
```
- `options` = `json.loads(options_json or "[]")` 原样（CET）；考研被 `kaoyan.clean_options` 只留 `{key,text}`。
- `flags` = `json.loads(flags_json or "[]")`，非 list 则回退 `[]`。
- `has_answer` = `answer is not None`；`has_analysis` = `bool(analysis_text)`。

`with_answer=True`（CET 分支）追加：
```json
{ "answer": str|null, "answer_source": str|null, "analysis_text": str|null,
  "answer_word": str }
```
- `answer_word` = `analysis_json.answer_word`（默认 `""`）；若 `qtype=="blank" && manual_locked`，改为在 `options` 里找 `key==answer` 的 `text`。

考研分支 `_kaoyan_question`：基础字段之上设
```json
{ "section_cn": kaoyan.section_label(section, variant),
  "variant": str|null, "options": clean_options(...),
  "source_file": null, "source_url": <原 questions.source_file> }
```
`with_answer=True` 再追加：
```json
{ "answer": str|null, "answer_source": kaoyan.answer_source(section),
  "analysis_text": str|null,
  "answer_word": kaoyan.answer_word(section, options, answer) }
```
客观题（section ∈ OBJECTIVE_SECTIONS）再加 `answer_check`（见 §3.2）。
- `variant` 由 `kaoyan.question_variant(section, layout, answer)` 决定（cloze→"cloze"，reading1→"reading"，matching→layout.matching 或 "match"，translation→layout.translation 或按有无答案 "translation_sentence"/"translation_passage"，writing→"writing"）。

### 3.2 answer_check 块（`kaoyan.answer_check`）
```json
{ "status": "external_agree|disputed_resolved|disputed_unresolved|source_only|manual",
  "label": str, "summary": str, "basis": str|null,
  "primary": {"name": "懒笔记整卷答案表", "url": str|null},
  "external": [ ... ], "ruling": { ... }|null,
  "stale": bool }
```
- 无 `answer_checks` 行 → `{status:"source_only", label:"仅来源答案", summary:"参考答案取自懒笔记，尚未找到可定位的外部资料核对", basis:null, primary:{name,url}, external:[], ruling:null, stale:false}`。
- 有行 → status/label/summary/basis 取该行；`stale = check.answer != 当前answer`；`external`/`ruling`/`primary` 从 `detail_json` 解析。
- `manual_locked=1` → 覆盖为 `{status:"manual", label:"已人工校正", summary:"本题答案已由你人工校正"}`。

### 3.3 答案归一化 `_normalize_answer(conn, question, value)`
- `value is None` → None；非 str → 400 `作答必须是选项字母或草稿文本`。
- 非客观题型（essay/translation）→ 原样返回（草稿文本）。
- 客观题：`value.strip().upper()`；空串 → None；必须 ∈ `_choice_keys`，否则 400 `{uid} 的选项无效`。
- `_choice_keys`：`options_json` 里的 key 集合；若 `qtype=="match"` 再并入该组 `section_materials.content_json.paragraphs[].label`；集合为空时回退 `set("ABCD")`（mcq）或 `set("ABCDEFGHIJKLMNOPQRSTUVWXYZ")`（blank）。

### 3.4 考研卷别/标题/覆盖
- `track(paper_key, set_no)`：key 匹配 `^(\d{4})-kaoyan-(1|2|historical)` → 1→one,2→two,其它→historical；否则 set_no 1→one,2→two,其它→historical。**month 从不参与**。
- `display_title(year, track)` = `f"{year} 年考研英语（{一|二|统考}）"`。
- `coverage_note(year)`：1998–2001 → `"来源未收录原卷的语法与词汇部分；题号按来源网站重新编号，与原卷不同。"`；2002–2004 → `"来源未收录原卷的听力部分；题号按来源网站重新编号，与原卷不同。"`；其余 None。
- `paper_fields(row)` = `{track, display_title}`。

---

## 4. 接口清单（共 29 个 `/api` 路由）

| # | 方法 | 路径 | 作用 |
|---|---|---|---|
| 1 | GET | `/api/papers` | 试卷列表 |
| 2 | GET | `/api/papers/{paper_key}` | 单卷详情（材料+题目，无答案） |
| 3 | POST | `/api/sessions` | 建/取整卷会话 |
| 4 | POST | `/api/sessions/redo` | 错题重做会话 |
| 5 | POST | `/api/sessions/{sid}/restart` | 重开空白会话 |
| 6 | GET | `/api/sessions/{sid}` | 会话全量数据 |
| 7 | PUT/POST | `/api/sessions/{sid}` | 保存作答进度（带回滚版本控制） |
| 8 | POST | `/api/sessions/{sid}/reveal` | 标记查看解析 |
| 9 | POST | `/api/sessions/{sid}/submit` | 交卷判分 |
| 10 | GET | `/api/sessions/{sid}/result` | 取交卷结果 |
| 11 | GET | `/api/history` | 练习历史 |
| 12 | GET | `/api/questions/{uid}` | 单题详情（含答案/解析/材料） |
| 13 | POST | `/api/favorites/{uid}` | 加收藏 |
| 14 | DELETE | `/api/favorites/{uid}` | 取消收藏 |
| 15 | PUT | `/api/notes/{uid}` | 保存笔记 |
| 16 | POST | `/api/questions/{uid}/fix` | 人工校正 |
| 17 | GET | `/api/review/wrong` | 错题本 |
| 18 | GET | `/api/review/favorites` | 收藏列表 |
| 19 | GET | `/api/report` | 题库导入报告 |
| 20 | GET | `/api/marks` | 取某卷某题型标记 |
| 21 | GET | `/api/marks/all` | 全部标记 |
| 22 | POST | `/api/marks` | 新增标记 |
| 23 | DELETE | `/api/marks/{mark_id}` | 删除标记 |
| 24 | GET | `/api/backup/export` | 导出个人数据 |
| 25 | POST | `/api/backup/import` | 导入个人数据 |
| 26 | GET | `/api/audio/{paper_key}` | 听力音频流 |
| 27 | GET | `/api/pdf` | 原 PDF 流 |
| 28 | GET | `/api/health` | 健康检查 |
| 29 | POST | `/api/local/shutdown` | 本机启动器停服 |

---

## 5. `GET /api/papers`

**Query**：`year:int?`, `month:int?`, `section:str?`, `exam:ExamType?`（全可选）。

**逻辑**：
1. `SELECT * FROM papers`，按需 AND `exam_type=?`/`year=?`/`month=?`，再 `ORDER BY year DESC, month DESC, set_no`。
2. 对每卷计算（逐卷 N+1 查询，离线实现可批量）：
   - `question_counts`：`SELECT section,qtype,COUNT(*) n,SUM(answer IS NOT NULL) na FROM questions WHERE paper_id=? GROUP BY section,qtype` → `{section: {"n":int,"answers":int}}`（同 section 多 qtype 时后者覆盖前者）。
   - `objective_total`、`objective_keyed`：仅客观题 section 的 `n` / `na` 求和。
   - `has_audio = _audio_available(audio_path)`（`AUDIO_EDITION!="NoAudio"` 且 `_safe_source_path(audio_path).is_file()`）。
   - `audio_edition = "WithAudio"|"NoAudio"`。
   - `shared_sources = json.loads(shared_sources_json or "{}")`。
   - 取该卷 `mode='full'` 的所有会话（`ORDER BY id DESC`）：
     - `latest = 最新一条`；若 `latest.submitted_at is None` → `active_session_id=latest.id`，解析其 `answers_json`（须 uid ∈ 该卷题目、值为非空字符串），`has_work=bool(filled)`，`active_answered=Σ(qtype∈{mcq,blank,match})`。
     - `last_submitted_session_id` = 第一条 `submitted_at` 非空的会话 id；`last_submitted_at` 其时间。
     - `status`：有 active → (`in_progress` 若 has_work 否则 `not_started`)；无 active → (`done` 若 last_submitted 否则 `not_started`)。
   - `_filtered_out = bool(section and section not in sections)`（该字段会随 paper 对象返回）。
   - 考研卷追加：`track`, `display_title`（`kaoyan.paper_fields`），`coverage_note`，`answer_check_counts`（见 §3、`_answer_check_counts`：客观题按 status 计数，`manual_locked`→`manual`，无 answer_checks 行→`source_only`）。
3. 若传 `section`，过滤掉 `_filtered_out=True` 的卷。

**响应**：
```json
{ "papers": [ Paper... ], "section_cn": { "<section>": "<中文>" } }
```
`section_cn`：`exam=="kaoyan"` → kaoyan.SECTION_CN，否则 CET SECTION_CN。

**Paper 字段全集**：`papers` 表全部列（`id, paper_key, year, month, set_no, has_listening, has_cloze, has_matching, has_reading1, has_reading2, has_writing, has_translation, audio_path, import_version, created_at, exam_type, shared_sources_json`）+ 计算字段 `question_counts, objective_total, objective_keyed, has_audio, audio_edition, shared_sources, active_session_id, active_updated_at, active_answered, last_submitted_at, last_submitted_session_id, status, _filtered_out`（+ 考研 `track, display_title, coverage_note, answer_check_counts`）。

**前端用法**：`pages/Papers.tsx` 按 `exam` 拉取；用 `question_counts[section].n>0` 做题型筛选；`status` 过滤 未开始/进行中/已完成；`objective_total`、`objective_keyed`、`active_answered` 画进度条与"待核对"；`answer_check_counts` 组合成"答案核对 x/y"；`track` 做考研卷别筛选；`coverage_note` 显示覆盖说明。**分页：本接口无分页**，前端一次取全量后本地过滤/排序/分组。

---

## 6. `GET /api/papers/{paper_key}`

404 `试卷不存在`。

**CET 响应**：
```json
{
  "paper": { ...papers 行全部列... },
  "sections": { "<section>": { "<group_key|main>": {
      "directions": str|null, "content": object, "translation": object,
      "analysis_text": str|null, "status": str, "source_file": str|null } } },
  "questions": [ QuestionPublic(无答案，按 SECTION_ORDER_SQL, q_index 排序) ],
  "raw_pdfs": [ "<file_path>" ],   // materials 里 kind∈{question,analysis} 的 file_path
  "audio_url": "/api/audio/{paper_key}" | null
}
```

**考研响应**：
```json
{
  "paper": { ...papers 列..., "track": str, "display_title": str, "coverage_note": str|null },
  "sections": { "<section>": { "<group_key>": Material } },   // kaoyan.materials(include_refs=False)，见 §7
  "questions": [ 考研 QuestionPublic(无答案，按 q_no 排序) ],
  "raw_pdfs": [ ... ], "audio_url": null
}
```

**前端用法**：`pages/Papers.tsx` 不直接调用；实际单卷详情主要走 `/api/sessions/{sid}`（练习页）。`raw_pdfs`/`audio_url` 供媒体入口。

---

## 7. 考研材料结构（`kaoyan.materials`，contract §5.4）——离线复刻重点

`materials(rows, layout, include_refs)` 返回 `{section: {group_key: Material}}`，按 `(section, group_key)` 行序：
```json
Material = {
  "group_key": str,               // row.group_key or "main"
  "directions": str,              // row.directions or ""
  "section_directions": str,      // 该 section 第一条非空 directions
  "status": "ok|needs_review|missing",
  "content": Body,                // 见下，按 section 变化
  "translation": {} | {"paragraphs":[str], "source":str},
  "analysis_text": null
}
```

各 section 的 `Body`（`_material`）：

- **cloze**：`{"variant":"cloze","paragraphs":[str]}`（= passage 按 `\n\n` 拆分）。
- **reading1**：`{"variant":"reading","title":str,"paragraphs":[str]}`（title 缺省 `Text <group 末段号>`）。
- **matching**：variant 由 `partb_variant` 决定：
  - `ordering`：`{"variant":"ordering","paragraphs":[],"labeled_paragraphs":[{"label":str,"text":str}],"chain":[{"given":str}|{"q_no":int}],"given":[str...],"options":[]}`
  - 其它（gap/heading/opinion/match）：`{"variant":<v>,"paragraphs":[str],"options":shared_options}`；`tf` 时 `options=[]`。
- **translation**：`{"variant":"translation_sentence|translation_passage","paragraphs":[str]}`；sentence 变体加 `"underlines":[{"q_no":int,"paragraph":int,"marker_start":int,"marker_end":int,"start":int,"end":int}]`（UTF‑16 偏移），`include_refs` 时加 `"reference_sentences":[{"q_no":int,"text":str}]`；passage 变体 `include_refs` 时加 `"reference_paragraphs":[str], "reference_notes":str|null`。
- **writing**：`{"variant":"writing","title":str,"prompt":str,"images":[{"src":str,"alt":"作文图表|作文图画"}]}`；`include_refs` 时加 `"model_essay":str|null, "model_essay_cn":str|null`。

`translation` 字段（段落译文）：仅当 `include_refs` 且 section 属 `{cloze,reading1,matching}` 且段落数对齐时给 `{"paragraphs":[...],"source":str}`，否则 `{}`。**翻译/写作永不返回段落译文**（会泄答案）。

关键判定 `partb_variant(directions, content, option_keys)`：有 `given_chain`/`chain_structure`→`ordering`；`option_keys=={"T","F"}`→`tf`；段落内含 `__(n)__` 空位 → directions 含 "heading"→`heading`、含 "opinion|comment|statement|summar"→`opinion`、否则 `gap`；其它→`match`。

`paper_layout(materials, questions)` 预计算整卷事实（Part B variant、翻译是否逐句、cloze 段落、shared options）。这两种存储结构（45 套 canonical / 2026-kaoyan-1 旧结构）都要兼容：`content` 里的 `source_html`、远程图片地址**从不下发**。

**交卷前隐藏参考** `own_references`：`/api/questions/{uid}?session=` 在会话未交卷时，只保留本题所属 group 的 references，且 `reference_sentences` 只留本题那句；非本 group 的 `_GROUP_REFERENCES = ("model_essay","model_essay_cn","reference_paragraphs","reference_notes","reference_sentences")` 全删。

---

## 8. `POST /api/sessions`

**Query**：`paper_key:str`（必填）, `mode:Literal["full","redo","wrong_redo"]="full"`, `restart:bool=false`。

**逻辑**（`BEGIN IMMEDIATE`）：
- 试卷缺失 → 404 `试卷不存在`。
- `mode=="full" and not restart`：取该卷最新 `mode='full'` 会话；存在 → 返回 `{"session_id": id, "resumed": <not submitted>, "reviewing": <submitted>}`（不新建）。
- 否则新建：`INSERT sessions(paper_id, mode, session_key=uuid4)` → `{"session_id": lastrowid, "resumed": false}`。

**前端用法**：`Papers.tsx start()` → `nav('/practice/{session_id}')`。

---

## 9. `POST /api/sessions/redo`

**Body**：
```json
{ "uids": ["uid", ...],   // 必填，max 10000 项
  "mode": "redo" | "wrong_redo" }   // 默认 "redo"
```
**逻辑**：空 → 400 `uids 为空`；dedup 后查 questions+papers；有缺 → 404 `部分题目不存在，请刷新题目列表`；跨 exam_type → 400 `不能把不同考试的题目放在同一次重做中，请分别重做`；`paper_id` 取首个 uid 所属卷；`INSERT sessions(paper_id, mode, scope_json=json(uids), session_key=uuid4)`；返回 `{"session_id": id}`。

**前端用法**：`Review.tsx redo()` → `nav('/practice/{sid}')`。

---

## 10. `POST /api/sessions/{sid}/restart`

404 `会话不存在`。复制 `previous.paper_id / mode / scope_json` 新建会话，返回 `{"session_id": id, "resumed": false}`。保留原会话全部作答与结果。前端 `Practice.startAgain()`。

---

## 11. `GET /api/sessions/{sid}`（练习页核心）

404 `会话不存在`；400 `练习范围数据损坏，无法恢复该会话`。

**响应**：
```json
{
  "session": {
    "id": int, "paper_id": int, "mode": str, "paper_key": str,
    "started_at": str, "submitted_at": str|null,
    "answers": { "<uid>": "<选项字母或草稿文本>" },
    "current_uid": str|null, "elapsed_sec": int, "audio_pos": float,
    "audio_paper_key": str,            // == sess.audio_paper_key or paper_key
    "state_revision": int,
    "revealed": [ "<uid>" ],
    "scope": [ "<uid>" ],              // _scope_uids 结果
    "result": object|null              // json(result_json)
  },
  "paper": { ...papers 列... } | _kaoyan_paper(p),
  "questions": [ QuestionPublic(with_answer=submitted) ],  // 排序见下
  "sections": { "<section>": { "<group>": {"directions","content","translation","analysis_text","status"} } },  // 主卷；CET 无 source_file
  "sections_by_paper": { "<paper_key>": {同 sections 结构} },  // 含重做跨卷所有卷
  "audio_by_paper": { "<paper_key>": "/api/audio/<key>"|null },
  "audio_url": "/api/audio/<主卷key>"|null,
  "audio_edition": "WithAudio|NoAudio",
  "papers_by_key": { "<paper_key>": _paper_brief(row) },
  "pdfs_by_paper": { "<kaoyan_key>": [ {"label":str,"path":str,"url":str|null} ] }  // 仅含考研卷时出现
}
```

- `_paper_brief(p)` = `{"paper_key","exam_type","year","month","set_no"}`（考研再加 `track, display_title`）。
- 排序：考研 `kaoyan.kaoyan_order(qs, uids)`（按 SECTION_ORDER 段序→scope 首次出现卷序→q_no）；否则 `(SECTION_ORDER 索引, q_index)`。
- `sections`（CET，来自 smats 循环）：`{"directions","content","translation","analysis_text","status"}` —— **注意与 `/api/papers/{key}` 相比少了 `source_file`**。考研卷的 materials 由 `kaoyan.materials(..., include_refs=submitted)` 生成。
- `questions` 的 `with_answer=submitted`：交卷后才带 `answer/answer_source/analysis_text/answer_word/answer_check`。

**`_scope_uids(conn, sess)`**：解析 `scope_json`（须 list[str]，否则 400 数据损坏）；非空则 dedup 返回；空则取该卷全部题 uid（考研按 q_no，否则 `SECTION_ORDER_SQL, q_index`）。

**前端用法**：`Practice.tsx` 载入即调用；用 `session.answers/current_uid/elapsed_sec/audio_pos/audio_paper_key/state_revision` 初始化 `SessionSaver`；`sections_by_paper`/`questions` 渲染材料与题卡；`pdfs_by_paper` 给考研整卷 PDF 链接；`audio_by_paper` 给听力。

---

## 12. `PUT` / `POST /api/sessions/{sid}`（保存作答，带回滚版本控制）

> 同一 handler，`POST` 供 `navigator.sendBeacon`（关页/刷新）与 `keepalive fetch` 使用。

**Body `SaveState`**（全部可选，`None` 表示不改）：
```json
{
  "answers": { "<uid>": "<str|null>" } | null,
  "current_uid": str|null,
  "elapsed_sec": int|null,        // ge=0, le=2147483647
  "audio_pos": float|null,        // ge=0, allow_inf_nan=False
  "audio_paper_key": str|null,
  "client_id": str|null,          // min_len=1, max_len=128
  "client_revision": int|null,    // ge=0, le=9223372036854775806
  "base_revision": int|null        // 同上
}
```

**逻辑**（`BEGIN IMMEDIATE`）：
1. 404 会话；若 `submitted_at` → 400 `已交卷，不能再修改作答`。
2. **版本控制**：`versioned = 任一 client_id/client_revision/base_revision 非 None`。
   - `versioned` 但三者缺一 → 400 `保存版本字段不完整`。
   - `client_id == sess.state_client_id`：若 `client_revision <= sess.state_client_revision` → 直接返回 `{"ok":true,"ignored":true,"state_revision":sess.state_revision}`（幂等丢弃）。
   - 否则（不同 client_id）若 `base_revision != sess.state_revision` → 409 `另一页面已修改此练习，请保留当前作答并刷新核对`。
3. `answers` 处理：每 uid 必须在 scope 内，否则 400 `作答包含本次练习范围以外的题目`；逐个 `_normalize_answer`；值为 None/"" 则从 dict 删除，否则写入。
4. `cur`：body 未给 `current_uid` 时保留旧值；给了且不在 scope → 400 `当前题目不在本次练习范围内`。
5. `elapsed`/`audio` 未给则保留旧值。
6. `audio_key`：非 None 且不在本会话题目所属卷集合 → 400 `音频所属试卷不在本次练习范围内`。
7. `state_revision = 旧值+1`；`UPDATE sessions SET answers_json, current_uid, elapsed_sec, audio_pos, audio_paper_key, state_revision, state_client_id, state_client_revision=client_revision||0, updated_at=now`。
8. 返回 `{"ok": true, "saved": <answers 总数>, "state_revision": <新值>}`。

**前端用法**：`SessionSaver`（`sessionSaver.ts`）维护 `progress{answers,current_uid,elapsed_sec,audio_pos,audio_paper_key}` + `client_id/client_revision/base_revision`；`save()` 串行队列，`base_revision` 用上次确认的 `state_revision`；收到 409 置 `conflict`，页面提示"另一页面已保存"，阻止覆盖。防抖 800ms + 15s 兜底 + `beforeunload/pagehide/visibilitychange` 用 `sendBeacon` POST。

---

## 13. `POST /api/sessions/{sid}/reveal`

**Body**：`{"uid": str}`。404 会话；uid 不在 scope → 400 `题目不在本次练习范围内`；若已交卷 → 直接 `{"ok":true}`（不写）；否则把 uid 并入 `revealed_uids`（排序后存）→ `{"ok":true}`。

**前端用法**：`Practice.onReveal()` 先 `markRevealed`（未交卷时），再 `questionDetail(uid, sid)`。

---

## 14. `POST /api/sessions/{sid}/submit`（判分核心）

**逻辑**（`BEGIN IMMEDIATE`）：
- 404 会话；已交卷 → `{"ok":true,"already":true,"result":<已存 result>}`。
- `uids = _scope_uids`；若考研重排为 `kaoyan_order`（per_section 按段序）。
- 遍历每题：
  - 主观题（非客观 section）：`detail[uid] = {"kind":"subjective","text": <choice 为 str 否则 "">}`，不判分。
  - 客观题但 `answer` 为空：`detail[uid]={"kind":"objective","verdict":"no_key","choice":choice|null,"revealed":bool}`，`per_section[section].no_key += 1`。
  - 客观题有答案：`verdict = "unanswered"(无 choice) | "correct"(choice==answer) | "wrong"`；`detail[uid]={"kind":"objective","verdict",choice,answer,revealed}`；`per_section[section][verdict]+=1`。
  - 每题若 `revealed` 则该 section `revealed += 1`。
- 顶级计数：`correct/wrong/unanswered/no_key`（仅 objective detail）。
- `graded = correct + wrong`；`accuracy = round(correct/graded,4) if graded else null`。
- `labels = kaoyan.SECTION_CN if is_kaoyan else SECTION_CN`；`per_section` 键用中文标签（`labels.get(section)`）。
- `note`：考研用 `kaoyan.RESULT_NOTE`；否则 `"正确率为客观题正确数/已作答且有标准答案的题数，非四六级考试成绩。"`。

**result 结构**：
```json
{
  "submitted_at": "YYYY-MM-DDTHH:MM:SS",     // datetime.now().isoformat(timespec="seconds")
  "correct": int, "wrong": int, "unanswered": int, "no_key": int,
  "accuracy": float|null,                     // 0..1，4 位小数
  "per_section": { "<中文题型>": {"correct":int,"wrong":int,"unanswered":int,"no_key":int,"revealed":int} },
  "detail": { "<uid>": <DetailItem> },
  "note": str,
  "score": <Score>                             // 仅考研 & mode=="full" & year>=2005
}
```
`DetailItem`（objective）：`{"kind":"objective","verdict":"correct|wrong|unanswered|no_key","choice":str|null,"answer":str?,"revealed":bool}`；`DetailItem`（subjective）：`{"kind":"subjective","text":str}`。

`Score`（`kaoyan.score`，半分制精确）：
```json
{ "earned": 数值(整或 .5), "total": 数值, 
  "by_section": { "<中文题型>": {"earned": 数值, "total": 数值} },
  "rule": "完形每题 0.5 分，阅读理解 Part A 与新题型每题 2 分；不含翻译和写作（40 分）" }
```
`HALF_POINTS = {"cloze":1,"reading1":4,"matching":4}`（各 ÷2 得 0.5/2/2）；只累加这三个 section；`_points(halves)`：偶数 → 整数，奇数 → `.5`。

**判分副作用（错题本）**：遍历 `detail`：
- `verdict=="wrong"` → UPSERT `wrong_book`: 新行 `wrong_count=1`；已存在 `wrong_count+1, resolved=0, session_id=本次, last_wrong_at=now, updated_at=now`。
- `verdict=="correct" 且 !revealed` → `UPDATE wrong_book SET resolved=1, updated_at=now WHERE uid=?`（若存在）。
- `submitted_at=datetime('now','localtime')`，`result_json=json(result)` 落库。

**响应**：`{"ok": true, "result": <result>}`（首次）；重复交卷 `{"ok":true,"already":true,"result":...}`。

**前端用法**：`Practice.doSubmit()`：先 flush 保存→`submitSession`→若 `response.result` 用 `completeSubmission`，再 `getSession` 拉全量渲染 `ResultHero`（用 `correct/wrong/unanswered/no_key/accuracy/per_section/note/score`）。

---

## 15. `GET /api/sessions/{sid}/result`

404 会话；无 `result_json` → 400 `尚未交卷`；返回 `json(result_json)`（结构同 §14 `result`）。

---

## 16. `GET /api/history`

**Query**：`limit:int`（`Query(100, ge=1, le=1000)`）。

**逻辑**：JOIN sessions+papers，`WHERE submitted_at IS NOT NULL ORDER BY submitted_at DESC, id DESC LIMIT ?`。

**响应**：
```json
{ "history": [ {
  "id": int, "mode": str, "started_at": str, "submitted_at": str,
  "paper_key": str, "year": int, "month": int, "set_no": int,
  "correct": int|null, "wrong": int|null, "accuracy": float|null,
  "exam_type": "cet4|cet6|kaoyan"
  // 考研额外： "track", "display_title",
  //   "score": {"earned": num, "total": num}   // 仅当 result 里含 dict 型 score
} ] }
```
（`correct/wrong/accuracy` 取自 result_json。）

**前端用法**：`Review.tsx historyList()`；客户端按 `examOf(row)` 分板；考研显示参考分列。

---

## 17. `GET /api/questions/{uid}`

**Query**：`session:int?`。404 `题目不存在`。

**响应 = 单题 QuestionPublic(with_answer=True) + `materials` + `note` + `favorite`**：
```json
{
  ...QuestionPublic(with_answer=True)...,
  "materials": [ ... ],
  "note": str,        // notes.text 或 ""
  "favorite": bool
}
```
- CET `materials`：`[{"group_key","directions","content":obj,"translation":obj,"analysis_text"}]`（该卷该 section 全部材料，无 status/source_file）。
- 考研 `materials`：`list(_kaoyan_sections(include_refs=True, section).get(section).values())`；若传了 `session` 且该会话未交卷 → `kaoyan.own_references(mats, r)` 只留本题参考。

**前端用法**：`QuestionDetailModal`（错题/收藏回看，不带 session，拿全参考）；`Practice.onReveal()`（带 session，交卷前只拿本题参考）。

---

## 18. 收藏 / 笔记 / 人工校正

- `POST /api/favorites/{uid}`：404 题目缺失；`INSERT OR IGNORE`；`{"ok":true}`。
- `DELETE /api/favorites/{uid}`：直接删；`{"ok":true}`。
- `PUT /api/notes/{uid}`：Body `{"text": str}`（`max_length=10000`）；404 题目缺失；UPSERT notes(text, updated_at=now)；`{"ok":true}`。
- `POST /api/questions/{uid}/fix`：Body `{"field": "answer"|"stem", "value": any}`；404 题目；`_normalize_fix`（answer 仅客观题且走归一化；stem≤8000 或 null）；`UPDATE questions SET <field>=?, manual_locked=1`；UPSERT `manual_fixes(uid,field,value=json(value),created_at)`；`{"ok":true}`。

**前端用法**：`Practice.toggleFav()`、`api.ts` 的 saveNote（`noteDrafts.ts` 汇总后落盘）、`fixQuestion`（题目校正弹层）。

---

## 19. `GET /api/review/wrong`

**逻辑**：`wrong_book JOIN questions`，`ORDER BY resolved ASC, last_wrong_at DESC`。

**响应**：
```json
{ "wrong": [ {
  "uid": str, "wrong_count": int, "last_wrong_at": str, "resolved": bool,
  "section": str, "section_cn": str, "q_no": int, "stem": "前 120 字",
  "paper_key": str, "options": [ {"key","text"} ],
  "has_answer": bool, "status": str, "flags": [...]
  // 考研额外（_review_row）："exam_type":"kaoyan","year","month","set_no","track","display_title",
  //   "group_key","variant","preview": str（一行提示，≤120 字）
} ] }
```
- CET：`section_cn` 用 `SECTION_CN`；考研：`section_cn=kaoyan.section_label(section,variant)`、`options=clean_options`、`preview=kaoyan.preview(...)`。
- `first_wrong_at` 未出现在响应中（SQL 查了但组装时未放）。

**前端用法**：`Review.tsx wrongBook()`；`resolved` 过滤"只看未掌握"；勾选 uid 批量 `createRedo`。

---

## 20. `GET /api/review/favorites`

`favorites JOIN questions ORDER BY created_at DESC`。
```json
{ "favorites": [ {
  "uid", "created_at", "section", "section_cn", "q_no", "stem":"前120字",
  "paper_key", "options":[...]
  // 考研额外同上（exam_type/year/month/set_no/track/display_title/group_key/variant/preview）
} ] }
```

---

## 21. `GET /api/report`

**Query**：`exam:ExamType?`（None 表示全部；`cet4/cet6/kaoyan`）。

**通用 summary 计算**（DB 聚合）：
```json
"summary": {
  "papers": int,                    // COUNT(DISTINCT paper_key)
  "questions": int,                 // COUNT(*)
  "objective": {"questions": int, "with_answers": int},  // qtype∈(mcq,blank,match)
  "subjective": int,                // qtype∈(essay,translation)
  "writing_with_model_essay": int,  // COUNT(DISTINCT paper_id) section='writing' 且 content_json LIKE '%model_essay%'
  "translation_with_reference": int,// COUNT(DISTINCT paper_id) section='translation' 且 content_json LIKE '%reference_translation%'
  "generated_at": str|null
}
```
- `exam` 有值时所有统计都加 `JOIN papers p ... WHERE p.exam_type=?`。

**CET 分支**（exam != "kaoyan"）：先读 `PROJECT/data/import-report.json`（不存在 → 404 `尚未生成导入报告`），`issues` 来自 `import_issues` 表（按需按 exam 过滤）。
```json
{ "summary": {...}, "papers": <import-report.json 的 papers 数组>, 
  "issues": [ {"paper_key","section","uid","level","message"} ] }
```

**考研分支**（`_kaoyan_report`）：`summary.generated_at` 改为“考研卷 MAX(created_at) 空格→T”。
```json
{
  "summary": {...},
  "answer_checks": { "<status>": int },       // 全库客观题按 status 计数（manual 覆盖）
  "answer_sources": <meta['kaoyan_answer_checks'] 的 JSON 或 null>,  // 前端读 .sources[]，每项 {id,name,kind,coverage,doc,note}
  "papers": [ {
    "paper_key", "track", "display_title", "coverage_note",
    "sections": { "<section>": {"questions":int,"answers":int /*writing:+"essay":bool*/ /*translation:+"reference_translation":bool*/} },
    "answer_check_counts": { "<status>": int }
  } ],
  "issues": [ {"paper_key","section","uid","level","message"} ]   // 含 coverage 说明(info)、争议题、过期核验
}
```
`issues` 排序：`(paper_key, rank, q_no)`，rank 0=覆盖说明 / 1=import_issues / 2=题级核验。争议状态：`disputed_resolved`→level `info`，`disputed_unresolved`→`warn`；过期（`checked_answer != answer`）→`warn`，文案 `答案核验记录已过期：核对时为 X，题库现为 Y`。

**前端用法**：`Report.tsx reportApi(exam)`；分板渲染，考研展示核验条/来源清单/各套明细/待核对。

---

## 22. 文章标记 marks

### 22.1 `GET /api/marks?paper_key=&section=`
两参数必填。返回 `{"marks":[ {text_marks 全部列} ]}`，`ORDER BY created_at`（`id,paper_key,section,passage_index,start_offset,end_offset,text,created_at`）。

### 22.2 `GET /api/marks/all?exam=`
```json
{ "marks": [ {
  ...text_marks 列...,
  "exam_type": "cet4|cet6|kaoyan",   // COALESCE(p.exam_type, key 前缀回退)
  "year": int|null, "month": int|null, "set_no": int|null,
  "paper_missing": bool,             // LEFT JOIN，p.id IS NULL
  "section_cn": str                  // _section_cn(section, exam_type)
} ] }
```
无 exam 参数 → 全部；否则 `WHERE <exam_sql>=?`。`ORDER BY created_at DESC, rowid DESC`。孤儿标记（paper 缺失）按 key 前缀保留。

### 22.3 `POST /api/marks`
**Body `TextMark`**：
```json
{ "id": str (1..64，须 uuid), "paper_key": str (1..100，须已在 papers),
  "section": "listening|cloze|matching|reading1|reading2|writing|translation",
  "passage_index": int (0..999999), "start_offset": int (0..1000000),
  "end_offset": int (1..1000000), "text": str (1..500),
  "created_at": str (须 ISO 日期时间) }
```
**校验 `_validate_mark`**：`uuid.UUID(id)`；`datetime.fromisoformat(created_at)`；`end_offset > start_offset` 且 `end_offset-start_offset == len(text.encode('utf-16-le'))//2`；paper_key 必须存在。任一失败 → 400 `标记记录无效`。
**响应**：返回落库的 row（= `mark.model_dump()`）。前端 `POST` 后 `setMarks([...marks, added])`。

### 22.4 `DELETE /api/marks/{mark_id}`
直接删，`{"ok":true}`（id 不存在也 200）。

**前端用法**：`MarkableMaterial.tsx`（练习页：选中文本→`GET /api/marks` 载入→`POST` 新增→`DELETE` 取消）；`Review.tsx`（复习空间"我的标记"：`allMarks()` 全量→前端按 exam 过滤、去重统计、分组、导出 TXT/CSV；`deleteMark`）。

---

## 23. 备份 / 恢复

### 23.1 `GET /api/backup/export`
返回 JSON（`Content-Disposition: attachment; filename="cet6-backup-YYYYmmdd-HHMMSS.json"`）：
```json
{
  "format": "cet6-backup", "version": 1,
  "exported_at": "YYYY-MM-DDTHH:MM:SS",
  "sessions": [ { ...sessions 全部列..., "paper_key": str } ],   // JOIN papers
  "wrong_book": [ { ...wrong_book 全部列... } ],
  "favorites": [ { ...favorites 全部列... } ],
  "notes": [ { ...notes 全部列... } ],
  "text_marks": [ { ...text_marks 全部列... } ],
  "manual_fixes": [ { ...manual_fixes 全部列... } ]
}
```
**不含题库本体**（材料/题目/试卷定义不导出）。

### 23.2 `POST /api/backup/import?merge=`
**Query**：`merge:bool=true`。**Body**：`{"data": <上述导出 JSON 对象>}`。

**两阶段：全量校验 → 逐表合并/替换（单事务，失败整体回滚）**。核心校验（失败均 400 且"未修改任何数据"）：
- `format=="cet6-backup"`、`type(version) is int` 且 `version==1`，否则 `文件格式或备份版本不正确`。
- 必需表 `sessions(id,paper_id)`、`wrong_book(uid)`、`favorites(uid)`、`notes(uid)`、`manual_fixes(uid,field)`；缺表/缺字段/重复键 → 报错。`text_marks` 可空 list。
- 每条 session：`id/paper_id` 正整数；`session_key` 若给须 uuid；`mode∈{full,redo,wrong_redo}`；`scope_json/answers_json/revealed_uids` 类型正确；所有 uid 必须存在于 questions；`answers/revealed ⊆ scope`；`current_uid ∈ scope`；答案归一化；`elapsed_sec/audio_pos/state_revision` 合法；`submitted_at` 与 `result_json` 必须同有同无；`result_json` 经 `_backup_result` 严格校验（detail 键集合 == scope，counts 与 detail 一致，accuracy 与 correct/graded 一致，per_section 数值合法）。
- `paper_key` 缺失时从 uid 反推；仍不确定/多卷 → 报错。卷未导入 → `备份所需的试卷尚未导入，未修改任何数据`。
- marks 走 `_validate_mark` 且 id 不重复。

**合并语义（merge=true）**：
- sessions：按 `session_key` 去重（旧备份无 key 用内容指纹 `_session_backup_identity` 去重）；已存在则跳过；id 冲突则分配新 id（max+1），引用随之重映射。
- wrong_book：`wrong_count=max(本地,导入)`；`last_wrong_at` 取较新；`first_wrong_at` 取较早；`resolved/updated_at` 按 `updated_at|last_wrong_at` 较新者覆盖。
- favorites：`INSERT OR IGNORE`。
- notes：导入 `updated_at` 比本地新才覆盖。
- text_marks：`INSERT OR IGNORE`（按 id）。
- manual_fixes：导入 `created_at` 比本地新才覆盖，并同步 `UPDATE questions SET <field>=?, manual_locked=1`；未被导入覆盖的本地校正计入 `retained_manual_fixes`。

**替换语义（merge=false）**：
- 先 `DELETE FROM wrong_book / sessions / favorites / notes / text_marks`（**不删** manual_fixes 与题库）。
- 导入 session 若与本地 id 冲突，`state_revision` 抬到 `max(本地,导入)+1`（防旧页面队列保存覆盖）。
- manual_fixes 仍按"本地较新保留"逻辑，未被覆盖的本地校正保留（`retained_manual_fixes`）。

**响应**：
```json
{ "ok": true,
  "imported": {"sessions":int,"wrong_book":int,"favorites":int,"notes":int,"text_marks":int,"manual_fixes":int},
  "retained_manual_fixes": int }
```

**前端用法**：`Backup.tsx`：导出 `api('/api/backup/export')` → 下载 JSON；导入读文件→校验 `format==='cet6-backup'`→`backupImport(data, merge)`；展示 `imported` 计数与 `retained_manual_fixes`。考研记录缺失时提示先导考研题库。

---

## 24. `GET /api/audio/{paper_key}`（离线化特殊处理）

- 404 试卷；`AUDIO_EDITION=="NoAudio"` → 404 `当前为无听力音频版，题目、录音原文和解析仍可使用`；`audio_path` 空 → 404 `该套次无听力音频`。
- `path = _safe_source_path(audio_path)`（相对 `ROOT`，防目录穿越：拒绝 `..`/绝对路径/盘符/`\x00`，`resolve()` 后须 `is_relative_to(ROOT)`，否则 403 `非法路径`）。文件不存在 → 404 `音频文件不存在`。
- 返回 **`FileResponse(path, media_type=<mimetypes 猜测或 "audio/mp4">, headers={"Accept-Ranges":"bytes"})`** —— 即**文件流**（Starlette 处理 Range/If-Range/416）。
- **离线化**：改为前端本地资源（`/public` 下的音频文件 URL 或 IndexedDB 存 Blob → `URL.createObjectURL`）。前端 `AudioPlayer.tsx` 用 `<audio src={src}>` 播放，`onTimeUpdate` 回报 `audio_pos`（写入会话 `audio_pos`）。

## 25. `GET /api/pdf`（离线化特殊处理）

- **Query**：`path:str`（必填）。
- `p = _safe_source_path(path, PDF_ROOT)`（`PDF_ROOT` 来自 `CET_PDF_RESOURCE_ROOT` 环境变量；未设则用 `ROOT`）；同样的目录穿越校验。
- 若 `p.suffix.lower() != ".pdf"` 或文件不存在 → 返回 **HTML**（`status_code=404`）：`'<meta charset="utf-8"><h1>尚未安装这份原 PDF</h1><p>刷题和解析不受影响。四六级原 PDF 可从项目 Releases 下载 Optional-PDF；考研 PDF 请使用练习页的在线下载入口。</p>'`（**非 JSON**）。
- 否则 `FileResponse(p, media_type="application/pdf", filename=p.name)` 文件流；前端以 `#page=N` 锚点新窗口打开。
- **路径来源**：CET 用 `questions.source_file`（相对路径）+`source_page`；考研用 `kaoyan.PDF_LINKS`（`kaoyan_pdf_links.py`）里的在线 `url`，或 `materials.section='full'` 的 `file_path`；证据引用用 `kaoyan.evidencePdf(doc)`（补 `cet6-practice/` 前缀）。
- **离线化**：这是最难的一点——前端需把 PDF 二进制放进 IndexedDB（或随包静态文件），用 `URL.createObjectURL(blob)` 打开，且保留 `#page=N` 页码定位；`evidencePdf` 的路径补全规则要照搬。

---

## 26. `GET /api/health` 与 `POST /api/local/shutdown`

- `GET /api/health` → `{"ok": true, "instance_id": "source"|str, "version": "1.5.0", "audio_edition": "WithAudio|NoAudio"}`。
- `POST /api/local/shutdown`：需请求头 `X-CET6-Instance` 与环境 `CET6_INSTANCE_TOKEN` 恒等（`hmac.compare_digest`），否则 403 `仅允许本机启动器停止此实例`；无 `app.state.local_server` → 503 `未由便携启动器启动`；成功 `{"stopping": true}`（后台置 `should_exit`）。**离线化可忽略。**

---

## 27. report 统计口径 / 判分 / 错题归集（汇总）

- **正确率**：`accuracy = round(correct / (correct + wrong), 4)`；`correct+wrong==0` → `null`。**未作答、缺答案(no_key) 不进分母**。
- **per_section**：按中文题型标签聚合 `correct/wrong/unanswered/no_key/revealed`；考研段序 = 完形→阅读→新题型→翻译→写作。
- **考研参考分 `score`**：仅 `mode=="full"` 且 `year>=2005`；`HALF_POINTS={cloze:1,reading1:4,matching:4}`（÷2 → 0.5/2/2 分）；`earned/total` 为客观题参考分（满分 60，不含翻译写作 40 分）；半分制精确换算。
- **错题归集**：交卷时 `wrong` → UPSERT `wrong_book`（wrong_count+1、resolved=0）；`correct 且未 reveal` → `resolved=1`。同一 uid 唯一。
- **report exam=kaoyan** 的 `answer_checks`/`answer_check_counts` 一律：`manual_locked`→`manual`，有 answer_checks 行取 status，无行→`source_only`；顺序按 `CHECK_LABEL` 键序。

---

## 28. 前端调用点总览（第 6 项要求）

| 接口 | 调用文件 | 用法要点 |
|---|---|---|
| GET /api/papers | `pages/Papers.tsx` | `listPapers(URLSearchParams({exam}))`；本地按 date/section/status/search/sort/track 过滤分组；无分页 |
| GET /api/papers/{key} | （无直接调用；练习页数据走 sessions/{sid}） | — |
| POST /api/sessions | `pages/Papers.tsx` | `createSession(paper_key, restart)` → 跳 `practice/{session_id}` |
| POST /api/sessions/redo | `pages/Review.tsx` | `createRedo(uids)` → 跳练习 |
| POST /api/sessions/{sid}/restart | `pages/Practice.tsx` | `startAgain()` → 跳新会话 |
| GET /api/sessions/{sid} | `pages/Practice.tsx` | 初始化 saver、渲染材料/题卡/音频/PDF、交卷后取 result |
| PUT/POST /api/sessions/{sid} | `sessionSaver.ts` + `Practice.tsx` | `saveState(sid, payload)`；版本冲突 409 |
| POST /api/sessions/{sid}/reveal | `Practice.tsx` | `onReveal` 前调用 |
| POST /api/sessions/{sid}/submit | `Practice.tsx` | `doSubmit()` |
| GET /api/sessions/{sid}/result | （间接，submit 后 getSession） | — |
| GET /api/history | `pages/Review.tsx` | `historyList()`（limit=1000），本地按 exam 过滤 |
| GET /api/questions/{uid} | `components/QuestionDetailModal.tsx`（不带 session）、`Practice.onReveal`（带 session） | 详情/解析 |
| POST/DELETE /api/favorites/{uid} | `Practice.tsx` | `toggleFav` |
| PUT /api/notes/{uid} | `noteDrafts.ts` / `api.saveNote` | 笔记草稿汇总保存 |
| POST /api/questions/{uid}/fix | `api.fixQuestion`（题目校正） | 人工改 answer/stem |
| GET /api/review/wrong | `pages/Review.tsx` | 错题本 tab |
| GET /api/review/favorites | `pages/Review.tsx` | 收藏 tab |
| GET /api/report | `pages/Report.tsx` | `reportApi(exam)`，分板 |
| GET /api/marks | `components/MarkableMaterial.tsx` | 练习页高亮 |
| GET /api/marks/all | `pages/Review.tsx` | 我的标记 tab（本地 stats/分组/导出） |
| POST /api/marks | `components/MarkableMaterial.tsx` | 新增标记 |
| DELETE /api/marks/{id} | `MarkableMaterial.tsx`、`Review.tsx` | 取消标记 |
| GET /api/backup/export | `pages/Backup.tsx` | 下载 JSON |
| POST /api/backup/import | `pages/Backup.tsx` | 合并/替换恢复 |
| GET /api/audio/{key} | `AudioPlayer.tsx`（`src` 来自 `audio_url`/`audio_by_paper`） | `<audio>` 播放，回报 audio_pos |
| GET /api/pdf | `QuestionCard`/`QuestionDetailModal`/`SentenceInsights`/`KaoyanEvidence`/`KaoyanPractice` | `href=/api/pdf?path=...#page=N` 新窗口 |

---

## 29. `EXAM_FALLBACK_SQL` 与考试归属回退

```sql
CASE WHEN {key} LIKE 'cet4-%' THEN 'cet4'
     WHEN {key} LIKE '%-kaoyan-%' THEN 'kaoyan' ELSE 'cet6' END
```
用于：`/api/marks/all`（孤儿标记无 papers 行时）、`kaoyan.exam_of_key`（`cet4-`前缀→cet4，含`-kaoyan-`→kaoyan，否则 cet6）。前端 `exam.ts examOf()` 与服务端一致（优先 `exam_type`，否则 key 前缀）。
