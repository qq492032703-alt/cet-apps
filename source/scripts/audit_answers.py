# -*- coding: utf-8 -*-
"""答案/结构合法性抽检：题型分布、答案是否落在选项内、状态与已知问题。"""
import sqlite3, json, os
from collections import Counter, defaultdict

ROOT = r'C:\Users\Administrator\Desktop\cet-practice'
DB = os.path.join(ROOT, 'build-input', 'v1.5.0-cet6.db')
conn = sqlite3.connect(f'file:{DB}?mode=ro', uri=True); conn.row_factory = sqlite3.Row

def rows(t):
    return [dict(r) for r in conn.execute(f'SELECT * FROM {t}')]

qs = rows('questions')
papers = {p['id']: p for p in rows('papers')}

# qtype x section 分布
qt = Counter((q['section'], q.get('qtype')) for q in qs)
print('== 题型分布 (section,qtype) ==')
for k, v in sorted(qt.items(), key=lambda x: (str(x[0][0]), str(x[0][1]))):
    print('  %-12s %-14s %d' % (k[0], k[1], v))

# 答案合法性：客观题答案应能在选项里找到
OBJ = {'listening','cloze','matching','reading1','reading2'}
invalid = []
checked = 0
ansfmt = Counter()
for q in qs:
    if q['section'] not in OBJ: continue
    checked += 1
    ans = (q.get('answer') or '').strip()
    ansfmt[ans if len(ans) <= 3 else 'LONG:'+ans[:8]] += 1
    opts = q.get('options_json')
    if isinstance(opts, str):
        try: opts = json.loads(opts)
        except Exception: opts = None
    if not isinstance(opts, list) or not opts:
        continue
    # 提取选项 key 集合
    keys = set()
    for o in opts:
        if isinstance(o, dict):
            for kk in ('key','label','letter','value','id'):
                if kk in o and isinstance(o[kk], (str,int)):
                    keys.add(str(o[kk]).strip()); break
        elif isinstance(o, str):
            keys.add(o.strip()[:1])
    if keys and ans and ans.upper() not in {k.upper() for k in keys}:
        invalid.append((q['uid'], q['section'], ans, sorted(keys)[:6]))

print('\n== 客观题 %d 道；答案不在选项集合内的=%d ==' % (checked, len(invalid)))
for x in invalid[:20]: print('  INVALID', x)

print('\n== 答案取值分布(前15) ==')
for k, v in ansfmt.most_common(15): print('  %-8r %d' % (k, v))

# status / import_issues
st = Counter((q['section'], q.get('status')) for q in qs)
print('\n== 题目 status 分布 ==')
for k, v in sorted(st.items(), key=lambda x: str(x[0])): print('  %-12s %-10s %d' % (k[0], str(k[1]), v))

try:
    iss = rows('import_issues')
    print('\n== import_issues 记录数 = %d ==' % len(iss))
    lev = Counter(i.get('level') for i in iss)
    print('   level 分布:', dict(lev))
    for i in iss[:8]: print('   ', i.get('paper_key'), i.get('section'), i.get('level'), str(i.get('message'))[:50])
except Exception as e:
    print('import_issues err', e)

# papers.has_* 与实际 section 一致性
print('\n== has_* 标志 vs 实际 section 一致性 ==')
flagmap = {'listening':'has_listening','cloze':'has_cloze','matching':'has_matching',
           'reading1':'has_reading1','reading2':'has_reading2','writing':'has_writing','translation':'has_translation'}
bysec = defaultdict(set)
for q in qs: bysec[q['paper_id']].add(q['section'])
incons = 0
for pid, p in papers.items():
    for sec, fl in flagmap.items():
        actual = sec in bysec.get(pid, set())
        flag = bool(p.get(fl))
        # has_* 为音频/材料层可能含 section_materials 而非 questions，这里只报 flag=1 但无题且非空材料的可疑
        if flag != actual:
            incons += 1
print('   has_* 与 questions 出现不一致条目=%d（section 可能仅有材料无独立题，正常会偏低）' % incons)
print('DONE')
