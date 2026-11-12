# -*- coding: utf-8 -*-
"""把全量 master-public 子集化为单一考试，写入 frontend/public，并生成 .env.production.local。
用法: python scripts/prepare_variant.py <cet4|cet6|kaoyan> key=val ...
  可传: name mark sub slogan version（品牌/版本）
"""
import json, os, sys, shutil, glob
try:
    from urllib.parse import quote
except Exception:
    quote = lambda s: s

ROOT = r'C:\Users\Administrator\Desktop\cet-practice'
MASTER = os.path.join(ROOT, 'build-input', 'master-public')
PUB = os.path.join(ROOT, 'frontend', 'public')

exam = sys.argv[1]
cfg = {}
for a in sys.argv[2:]:
    if '=' in a:
        k, v = a.split('=', 1)
        cfg[k] = v

md = os.path.join(MASTER, 'data')
idx = json.load(open(os.path.join(md, 'index.json'), encoding='utf-8'))
kept = [p for p in idx['papers'] if p.get('exam_type') == exam]
keys = set(p['paper_key'] for p in kept)
if not kept:
    print('ERROR: no papers for exam', exam); sys.exit(2)

# 清空目标
for d in ('data', 'audio', 'kaoyan-assets'):
    t = os.path.join(PUB, d)
    if os.path.isdir(t):
        shutil.rmtree(t)
os.makedirs(os.path.join(PUB, 'data', 'paper'), exist_ok=True)
os.makedirs(os.path.join(PUB, 'audio'), exist_ok=True)

# index
idx2 = dict(idx); idx2['papers'] = kept
json.dump(idx2, open(os.path.join(PUB, 'data', 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False)

# meta
meta = json.load(open(os.path.join(md, 'meta.json'), encoding='utf-8'))
meta2 = dict(meta)
meta2['papers'] = {k: v for k, v in (meta.get('papers') or {}).items() if k in keys}
ci = meta.get('cet_issues')
if isinstance(ci, list):
    meta2['cet_issues'] = [it for it in ci if it.get('paper_key') in keys]
json.dump(meta2, open(os.path.join(PUB, 'data', 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False)

# answer_checks
json.dump({}, open(os.path.join(PUB, 'data', 'answer_checks.json'), 'w', encoding='utf-8'))

# paper json + 音频收集
audio_slugs = set()
missing_paper = 0
for p in kept:
    k = p['paper_key']
    src = os.path.join(md, 'paper', k + '.json')
    if not os.path.exists(src):
        alt = os.path.join(md, 'paper', quote(k) + '.json')
        src = alt if os.path.exists(alt) else src
    if not os.path.exists(src):
        missing_paper += 1
        print('  ! missing paper json:', k)
        continue
    shutil.copy2(src, os.path.join(PUB, 'data', 'paper', os.path.basename(src)))
    ap = p.get('audio_path')
    if ap and str(ap).startswith('/audio/'):
        audio_slugs.add(os.path.basename(ap))

missing_audio = 0
for slug in audio_slugs:
    s = os.path.join(MASTER, 'audio', slug)
    if os.path.exists(s):
        shutil.copy2(s, os.path.join(PUB, 'audio', slug))
    else:
        missing_audio += 1
        print('  ! missing audio:', slug)

# 图片（仅考研发）
img_n = 0
if exam == 'kaoyan':
    msrc = os.path.join(MASTER, 'kaoyan-assets')
    if os.path.isdir(msrc):
        shutil.copytree(msrc, os.path.join(PUB, 'kaoyan-assets'))
        img_n = len(glob.glob(os.path.join(PUB, 'kaoyan-assets', '*')))

# .env.production.local
env = {
    'VITE_APP_EXAM': exam,
    'VITE_BRAND_NAME': cfg.get('name', '英语研习室'),
    'VITE_BRAND_MARK': cfg.get('mark', '研'),
    'VITE_BRAND_SUB': cfg.get('sub', ''),
    'VITE_HERO_SLOGAN': cfg.get('slogan', ''),
    'VITE_SIDEBAR_QUOTE': cfg.get('quote', ''),
    'VITE_APP_VERSION': cfg.get('version', 'v1.0'),
}
with open(os.path.join(ROOT, 'frontend', '.env.production.local'), 'w', encoding='utf-8') as fh:
    for k, v in env.items():
        fh.write(f'{k}="{v}"\n')

print(f'[prepare] exam={exam} papers={len(kept)} missing_paper={missing_paper} '
      f'audio={len(audio_slugs)} missing_audio={missing_audio} images={img_n} name={env["VITE_BRAND_NAME"]}')
