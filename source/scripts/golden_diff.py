import json, pathlib, sys
sys.stdout.reconfigure(encoding="utf-8")
ROOT = pathlib.Path(r"C:\Users\Administrator\Desktop\cet-practice")
be = json.load(open(ROOT/"scripts"/"_golden_backend.json", encoding="utf-8"))
off = json.load(open(ROOT/"scripts"/"_golden_offline.json", encoding="utf-8"))
IGN = {"source_file","source_url","answer_source","document_json","has_audio","audio_url",
       "audio_edition","audio_path","shared_sources_json","url","final_url","download"}
diffs = []
def short(v):
    try: s = json.dumps(v, ensure_ascii=False)
    except Exception: s = str(v)
    return s[:90]
def walk(a,b,p):
    if isinstance(a,dict) and isinstance(b,dict):
        for k in list(set(a)|set(b)):
            if k in IGN: continue
            if k not in a: diffs.append((p+"/"+k,"<only-offline>",short(b[k]))); continue
            if k not in b: diffs.append((p+"/"+k,short(a[k]),"<only-backend>")); continue
            walk(a[k],b[k],p+"/"+k)
    elif isinstance(a,list) and isinstance(b,list):
        if len(a)!=len(b): diffs.append((p+"[len]",len(a),len(b)))
        for i,(x,y) in enumerate(zip(a,b)): walk(x,y,p+f"[{i}]")
    else:
        if a!=b: diffs.append((p,short(a),short(b)))
for path in be["snap"]:
    A=be["snap"][path]; B=off["snap"].get(path)
    if B is None: diffs.append((path,"<no-offline>","")); continue
    if A["status"]!=B["status"]: diffs.append((path+" #status",A["status"],B["status"]))
    walk(A["json"],B["json"],path)
print("总差异条目:",len(diffs))
from collections import Counter
# 按末段键聚合
c=Counter(d[0].split("/")[-1].split("[")[0] for d in diffs)
print("差异键分布:", dict(c.most_common(20)))
for d in diffs[:80]: print(d)
if not diffs: print("== 完全一致（忽略去痕迹字段） ==")
