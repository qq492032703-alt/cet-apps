import json
O=json.load(open(r'C:\Users\Administrator\Desktop\cet-practice\scripts\_golden_offline.json',encoding='utf-8'))['snap']
for key in ['/api/report?exam=cet4','/api/report?exam=kaoyan']:
    j=O[key]['json']
    print('====',key,'topkeys=',list(j.keys()) if isinstance(j,dict) else type(j))
    if isinstance(j,dict):
        s=j.get('summary')
        print('  summary keys:', list(s.keys()) if isinstance(s,dict) else s)
        if isinstance(s,dict):
            for k,v in s.items():
                if not isinstance(v,(dict,list)): print('    ',k,'=',v)
        a=j.get('answer_sources')
        print('  answer_sources type:', type(a), 'keys/len:', (list(a.keys()) if isinstance(a,dict) else (len(a) if isinstance(a,list) else a)))
        if isinstance(a,dict):
            srcs=a.get('sources')
            print('   sources len:', len(srcs) if isinstance(srcs,list) else srcs)
        print('  issues len:', len(j.get('issues') or []), ' papers len:', len(j.get('papers') or []))
