import json
B=json.load(open(r'C:\Users\Administrator\Desktop\cet-practice\scripts\_golden_backend.json',encoding='utf-8'))['snap']
O=json.load(open(r'C:\Users\Administrator\Desktop\cet-practice\scripts\_golden_offline.json',encoding='utf-8'))['snap']
for key in ['/api/papers/cet4-2026-06-1','/api/papers/2026-06-1']:
    bj=B[key]['json']; oj=O[key]['json']
    bs=bj.get('sections'); os_=oj.get('sections')
    for sec in bs:
        bp=bs[sec].get('prompt') if isinstance(bs[sec],dict) else None
        op=(os_.get(sec) or {}).get('prompt') if isinstance(os_.get(sec),dict) else None
        if bp and op and isinstance(bp.get('analysis_text'),str) and isinstance(op.get('analysis_text'),str):
            b=bp['analysis_text']; o=op['analysis_text']
            i=0;m=min(len(b),len(o))
            while i<m and b[i]==o[i]: i+=1
            print(key,sec,'首位差',i,'lenB',len(b),'lenO',len(o))
            print('   B:',repr(b[max(0,i-30):i+95]))
            print('   O:',repr(o[max(0,i-30):i+95]))
