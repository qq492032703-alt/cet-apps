# -*- coding: utf-8 -*-
"""完整性校验：构建产物 dist 与源数据/DB 一致性，确保离线 App 无缺件。"""
import json, os, re, sys, glob
ROOT=r'C:\Users\Administrator\Desktop\cet-practice'
DIST=os.path.join(ROOT,'frontend','dist')
DATA=os.path.join(DIST,'data')
errs=[]; warns=[]
def J(p): return json.load(open(p,encoding='utf-8'))

idx=J(os.path.join(DATA,'index.json'))
papers=idx['papers']; print('index papers=',len(papers))
meta=J(os.path.join(DATA,'meta.json'))
qc = meta if isinstance(meta,dict) else {}
# meta structure: {papers:{key:{qcounts...}}} or {qcounts:{key:..}}
def meta_qcount(key):
    for path in [('papers',key,'qcounts'),('qcounts',key),('papers',key,'questions')]:
        cur=meta
        ok=True
        for p in path:
            if isinstance(cur,dict) and p in cur: cur=cur[p]
            else: ok=False;break
        if ok and isinstance(cur,(int,float)): return int(cur)
        if ok and isinstance(cur,dict): return cur
    return None

# 1) paper json 存在 & 题量
total_q=0; missing_paper=0
paper_files=glob.glob(os.path.join(DATA,'paper','*.json'))
print('paper json files=',len(paper_files))
for p in papers:
    key=p['paper_key']
    fn=os.path.join(DATA,'paper',key+'.json')  # quote() only special chars; keys are ascii-safe
    if not os.path.exists(fn):
        # try URL-quoted name present
        alts=glob.glob(os.path.join(DATA,'paper','*.json'))
        missing_paper+=1; errs.append('缺少试卷文件: '+key); continue
    frag=J(fn)
    n=len(frag.get('questions') or [])
    total_q+=n
print('total questions in paper files=',total_q,' missing_paper=',missing_paper)

# 2) audio 引用
miss_audio=0; audio_refs=0
for p in papers:
    ap=p.get('audio_path')
    if ap and str(ap).startswith('/audio/'):
        audio_refs+=1
        f=os.path.join(DIST, ap.lstrip('/'))
        if not os.path.exists(f): miss_audio+=1; errs.append('缺音频: '+ap)
audio_files=glob.glob(os.path.join(DIST,'audio','*.m4a'))
print('audio refs=',audio_refs,' audio files=',len(audio_files),' miss_audio=',miss_audio)

# 3) kaoyan 图片引用
img_refs=set()
for fn in paper_files:
    try: frag=J(fn)
    except: continue
    def walk(o):
        if isinstance(o,dict):
            d=o.get('download')
            if isinstance(d,dict) and isinstance(d.get('file'),str) and d['file'].startswith('assets/'):
                img_refs.add(os.path.basename(d['file']))
            for v in o.values(): walk(v)
        elif isinstance(o,list):
            for v in o: walk(v)
    walk(frag)
miss_img=0
for name in img_refs:
    if not os.path.exists(os.path.join(DIST,'kaoyan-assets',name)): miss_img+=1; errs.append('缺图片: '+name)
print('kaoyan img refs=',len(img_refs),' miss_img=',miss_img)

# 4) 外链残留扫描（js/html/json）
pat=re.compile(r'(lazynote|Sakurajima|linux\.do|懒笔记|english-exam\.)',re.I)
hits=[]
for ext in ('**/*.js','**/*.html','**/*.json'):
    for f in glob.glob(os.path.join(DIST,ext),recursive=True):
        try: t=open(f,encoding='utf-8',errors='ignore').read()
        except: continue
        m=pat.findall(t)
        if m: hits.append((os.path.relpath(f,DIST),set(m)))
print('外链/品牌残留文件数=',len(hits))
for h in hits[:10]: print('   ',h)
if hits: errs.append('存在品牌/外链残留 %d 文件'%len(hits))

# 5) 关键静态资源
for need in ['index.html','data/index.json','data/meta.json']:
    if not os.path.exists(os.path.join(DIST,need)): errs.append('缺 '+need)

print('\n==== 结论: ', 'PASS 无缺件' if not errs else ('FAIL %d 项'%len(errs)))
for e in errs[:40]: print('  -',e)
