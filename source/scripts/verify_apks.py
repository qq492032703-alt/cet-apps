# -*- coding: utf-8 -*-
import zipfile, json, glob, os
from collections import Counter

desk = r'C:\Users\Administrator\Desktop'
keys = ('四级研习社', '六级研习社', '考研研习社')
apks = [f for f in glob.glob(os.path.join(desk, '*.apk')) if any(k in os.path.basename(f) for k in keys)]
for f in sorted(apks):
    nm = os.path.basename(f)
    z = zipfile.ZipFile(f)
    names = z.namelist()
    idx = [p for p in names if p.endswith('assets/public/data/index.json')]
    audio = [p for p in names if 'assets/public/audio/' in p and p.endswith('.m4a')]
    imgs = [p for p in names if 'assets/public/kaoyan-assets/' in p]
    paperfiles = [p for p in names if 'assets/public/data/paper/' in p and p.endswith('.json')]
    print('%s | MB=%.1f' % (nm, os.path.getsize(f) / 1048576))
    if idx:
        d = json.loads(z.read(idx[0]).decode('utf-8'))
        c = Counter(p.get('exam_type') for p in d['papers'])
        print('   papers=%d %s paperfiles=%d' % (len(d['papers']), dict(c), len(paperfiles)))
    print('   audio=%d kaoyan-assets=%d' % (len(audio), len(imgs)))
