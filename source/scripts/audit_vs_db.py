# -*- coding: utf-8 -*-
"""源库(v1.5.0-cet6.db) <-> 导出数据(master-public) 逐题核对。"""
import sqlite3, json, os, glob, urllib.parse
from collections import Counter, defaultdict

ROOT = r'C:\Users\Administrator\Desktop\cet-practice'
DB = os.path.join(ROOT, 'build-input', 'v1.5.0-cet6.db')
MD = os.path.join(ROOT, 'build-input', 'master-public', 'data')
JSON_COLS = {'options_json','analysis_json','flags_json','content_json','translation_json',
             'document_json','shared_sources_json','scope_json','detail_json','state_json'}
STRIP = {'document_json'}

conn = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
conn.row_factory = sqlite3.Row

def cols(t):
    return [r[1] for r in conn.execute(f'PRAGMA table_info({t})')]

def rows(t, where='', params=()):
    cs = cols(t)
    out = []
    for r in conn.execute(f'SELECT * FROM {t}' + (f' WHERE {where}' if where else ''), params):
        d = dict(zip(cs, r))
        for c in cs:
            if c in JSON_COLS and isinstance(d[c], str) and d[c]:
                try: d[c] = json.loads(d[c])
                except Exception: pass
        for c in STRIP: d.pop(c, None)
        out.append(d)
    return out

print('== TABLES ==', [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")])
print('question cols =', cols('questions'))
print('section_materials cols =', cols('section_materials'))
print('papers cols =', cols('papers'))

papers = rows('papers')
print('\n== DB 汇总 ==')
byexam = Counter(p.get('exam_type') for p in papers)
print('papers total=%d by exam=%s' % (len(papers), dict(byexam)))
q_total_db = 0
papers_with_audio = 0
for p in papers:
    qs = rows('questions', 'paper_id=?', (p['id'],))
    q_total_db += len(qs)
    if p.get('audio_path'): papers_with_audio += 1
print('questions total=%d, papers_with_audio=%d' % (q_total_db, papers_with_audio))

# 逐卷核对
IGN = {'document_json'}
field_diff = Counter()
examples = defaultdict(list)
missing_paper = []
qcount_bad = []
uid_bad = []
sm_diff = []
total_master_q = 0
per_exam_q = Counter()

def load_master(key):
    for name in (key + '.json', urllib.parse.quote(key, safe='-_.~') + '.json'):
        f = os.path.join(MD, 'paper', name)
        if os.path.exists(f):
            return json.load(open(f, encoding='utf-8'))
    return None

for p in papers:
    key = p['paper_key']; exam = p.get('exam_type')
    m = load_master(key)
    if not m:
        missing_paper.append(key); continue
    dq = {q['uid']: q for q in rows('questions', 'paper_id=?', (p['id'],))}
    mq = {q['uid']: q for q in (m.get('questions') or [])}
    total_master_q += len(mq); per_exam_q[exam] += len(mq)
    if len(dq) != len(mq):
        qcount_bad.append((key, exam, len(dq), len(mq)))
    only_db = set(dq) - set(mq); only_m = set(mq) - set(dq)
    if only_db or only_m:
        uid_bad.append((key, len(only_db), len(only_m)))
    for uid in (set(dq) & set(mq)):
        a, b = dq[uid], mq[uid]
        for k in set(a) | set(b):
            if k in IGN: continue
            if a.get(k) != b.get(k):
                field_diff[k] += 1
                if len(examples[k]) < 8:
                    examples[k].append((key, uid, str(a.get(k))[:60], str(b.get(k))[:60]))
    # section materials
    dsm = rows('section_materials', 'paper_id=?', (p['id'],))
    msm = m.get('section_materials') or []
    if len(dsm) != len(msm):
        sm_diff.append((key, exam, len(dsm), len(msm)))

print('\n== 导出(master-public) vs DB ==')
print('master papers found=%d missing=%d' % (len(papers) - len(missing_paper), len(missing_paper)))
if missing_paper: print('  MISSING papers:', missing_paper[:10])
print('master questions total=%d  per_exam=%s' % (total_master_q, dict(per_exam_q)))
print('qcount mismatch papers=%d' % len(qcount_bad))
for x in qcount_bad[:15]: print('   qcount', x)
print('uid set mismatch papers=%d' % len(uid_bad))
for x in uid_bad[:15]: print('   uid', x)
print('section_materials count mismatch=%d' % len(sm_diff))
for x in sm_diff[:15]: print('   sm', x)

print('\n== 逐字段差异统计（题目字段）==')
for k, v in field_diff.most_common():
    print('  %-16s diff=%d' % (k, v))
    for e in examples[k][:3]:
        print('       e.g.', e)

# 答案完整性
print('\n== 答案完整性（DB）==')
OBJ = {'listening','cloze','matching','reading1','reading2'}
noans = Counter(); withans = Counter()
for p in papers:
    for q in rows('questions', 'paper_id=?', (p['id'],)):
        sec = q.get('section')
        ans = q.get('answer')
        if sec in OBJ:
            if ans in (None, ''): noans[sec] += 1
            else: withans[sec] += 1
print('objective with answer by section:', dict(withans))
print('objective WITHOUT answer by section:', dict(noans))
print('sum with answer=%d, WITHOUT=%d' % (sum(withans.values()), sum(noans.values())))

print('\nDONE')
