# -*- coding: utf-8 -*-
import sqlite3
from collections import defaultdict
c = sqlite3.connect(r'C:\Users\Administrator\Desktop\cet-practice\build-input\v1.5.0-cet6.db')
c.row_factory = sqlite3.Row
OBJ = ('listening','cloze','matching','reading1','reading2')
agg = defaultdict(lambda: {'q':0,'obj':0,'non':0})
for r in c.execute('select p.exam_type e, q.section s from questions q join papers p on q.paper_id=p.id'):
    a = agg[r['e']]; a['q'] += 1; a['obj' if r['s'] in OBJ else 'non'] += 1
for e in sorted(agg): print(e, agg[e])
print('--- status != ok ---')
for r in c.execute("select uid, section, status from questions where status!='ok'"):
    print(dict(r))
