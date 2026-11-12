# -*- coding: utf-8 -*-
"""反查三个 APK 内部：题库/音频/图片引用完整性 + 抽样与 master 逐题比对。"""
import zipfile, json, os, glob

ROOT = r'C:\Users\Administrator\Desktop\cet-practice'
MD = os.path.join(ROOT, 'build-input', 'master-public', 'data', 'paper')
DESK = r'C:\Users\Administrator\Desktop'

apks = [f for f in glob.glob(os.path.join(DESK, '*.apk')) if any(k in os.path.basename(f) for k in ('四级研习社','六级研习社','考研研习社'))]

for apk in sorted(apks):
    nm = os.path.basename(apk)
    z = zipfile.ZipFile(apk)
    names = set(z.namelist())
    idx = json.loads(z.read('assets/public/data/index.json').decode('utf-8'))
    papers = idx['papers']
    exam = sorted(set(p.get('exam_type') for p in papers))

    # 音频引用
    slugs = set()
    for p in papers:
        ap = p.get('audio_path')
        if ap:
            slugs.add(os.path.basename(ap))
    miss_audio = [s for s in slugs if ('assets/public/audio/' + s) not in names]

    # 分片文件数
    paper_files = [n for n in names if 'assets/public/data/paper/' in n and n.endswith('.json')]

    # 图片引用 vs 实际文件
    img_ref = set()
    for f in paper_files:
        d = json.loads(z.read(f).decode('utf-8'))
        for sm in d.get('section_materials', []):
            cj = sm.get('content_json') or {}
            if isinstance(cj, str):
                try: cj = json.loads(cj)
                except Exception: cj = {}
            for si in (cj.get('source_images') or []):
                dl = si.get('download') or {}
                fp = dl.get('file')
                if fp:
                    img_ref.add(os.path.basename(fp))
    img_files = set(os.path.basename(n) for n in names if 'assets/public/kaoyan-assets/' in n)
    miss_img = img_ref - img_files

    print('%s  exam=%s papers=%d paperfiles=%d' % (nm, exam, len(papers), len(paper_files)))
    print('   audio_ref=%d missing_audio=%d | img_ref=%d img_files=%d missing_img=%d'
          % (len(slugs), len(miss_audio), len(img_ref), len(img_files), len(miss_img)))
    if miss_audio: print('   MISSING AUDIO:', miss_audio[:5])
    if miss_img: print('   MISSING IMG:', list(miss_img)[:5])

    # 抽样：每个 APK 取 2 卷与 master 逐题比对 uid/answer/stem/options
    import urllib.parse
    diff = 0; compared = 0
    for p in papers[:2]:
        key = p['paper_key']
        cand = os.path.join(MD, key + '.json')
        if not os.path.exists(cand):
            continue
        m = json.load(open(cand, encoding='utf-8'))
        mq = {q['uid']: q for q in m.get('questions', [])}
        # 找 APK 内该卷分片
        target = None
        for f in paper_files:
            if f.endswith('/' + key + '.json') or f.endswith('/' + urllib.parse.quote(key, safe='-_.~') + '.json'):
                target = f; break
        if not target: continue
        aq = {q['uid']: q for q in json.loads(z.read(target).decode('utf-8')).get('questions', [])}
        for uid in set(mq) & set(aq):
            compared += 1
            for k in ('stem','options_json','answer','section','q_no','qtype'):
                if mq[uid].get(k) != aq[uid].get(k):
                    diff += 1
                    break
        if set(mq) != set(aq):
            print('   UID SET DIFF in', key, len(set(mq)-set(aq)), len(set(aq)-set(mq)))
    print('   sample compared questions=%d field-diff=%d' % (compared, diff))
print('DONE')
