# -*- coding: utf-8 -*-
"""导出指定 uid 的完整题目与所属材料，供人工核对。"""
import sqlite3, json

DB = r'C:\Users\Administrator\Desktop\cet-practice\build-input\v1.5.0-cet6.db'
TARGETS = ['cet4-2020-12-2:matching:44', 'cet4-2025-12-1:reading1:50']

c = sqlite3.connect(f'file:{DB}?mode=ro', uri=True); c.row_factory = sqlite3.Row

def j(x):
    if isinstance(x, str):
        try: return json.loads(x)
        except Exception: return x
    return x

for uid in TARGETS:
    q = c.execute('select * from questions where uid=?', (uid,)).fetchone()
    if not q:
        print('NOT FOUND', uid); continue
    q = dict(q)
    print('=' * 70)
    print('UID:', uid)
    print('paper_id:', q['paper_id'], 'paper_key:', q['paper_key'], 'section:', q['section'], 'qtype:', q.get('qtype'), 'q_no:', q.get('q_no'))
    print('answer:', repr(q.get('answer')), 'status:', q.get('status'))
    print('stem:', q.get('stem'))
    print('options:', json.dumps(j(q.get('options_json')), ensure_ascii=False, indent=2))
    print('analysis_text:', q.get('analysis_text'))
    print('-- 材料 (section_materials, 该 section 全部) --')
    mats = c.execute('select * from section_materials where paper_id=? and section=?', (q['paper_id'], q['section'])).fetchall()
    for m in mats:
        m = dict(m)
        cj = j(m.get('content_json'))
        print('  group_key:', m.get('group_key'), 'status:', m.get('status'))
        print('  content:', json.dumps(cj, ensure_ascii=False)[:5000])
    print('-- 同 paper + section 全部题目的答案 --')
    for r in c.execute('select uid, q_no, answer from questions where paper_id=? and section=? order by q_index, id', (q['paper_id'], q['section'])):
        print('   ', r['uid'], 'q_no=', r['q_no'], 'ans=', repr(r['answer']))
