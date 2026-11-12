"""对拍金标准：用真实 FastAPI 后端（原项目 backend）对只读接口生成快照。
输出 scripts/_golden_backend.json，供与离线 localBackend 快照逐字段比较。"""
import os, sys, json, shutil, pathlib
sys.stdout.reconfigure(encoding="utf-8")
ROOT = pathlib.Path(r"C:\Users\Administrator\Desktop\cet-practice")
src = ROOT / "build-input" / "v1.5.0-cet6.db"
tmp = ROOT / "build-input" / "_goldendb" / "cet6.db"
tmp.parent.mkdir(exist_ok=True)
shutil.copyfile(src, tmp)
os.environ["CET6_DB_PATH"] = str(tmp)
os.environ["CET6_PROJECT_DIR"] = str(ROOT)
os.environ["CET_RESOURCE_ROOT"] = str(ROOT / "resources")
os.environ["CET_AUDIO_EDITION"] = "NoAudio"
sys.path.insert(0, str(ROOT))
from backend.app.main import app
from fastapi.testclient import TestClient

c = TestClient(app)
def gj(p):
    r = c.get(p)
    try:
        j = r.json()
    except Exception:
        j = None
    return {"status": r.status_code, "json": j}

snap = {}
keys = {}
for ex in ["cet4", "cet6", "kaoyan"]:
    k = f"/api/papers?exam={ex}"
    s = gj(k); snap[k] = s
    ps = (s["json"] or {}).get("papers") or []
    keys[ex] = ps[0]["paper_key"] if ps else None
for ex, key in keys.items():
    if key:
        k = f"/api/papers/{key}"; snap[k] = gj(k)
for ex in ["cet4", "cet6", "kaoyan"]:
    k = f"/api/report?exam={ex}"; snap[k] = gj(k)
for k in ["/api/review/wrong", "/api/review/favorites", "/api/marks/all",
          "/api/backup/export", "/api/history"]:
    snap[k] = gj(k)

out = ROOT / "scripts" / "_golden_backend.json"
json.dump({"keys": keys, "snap": snap}, open(out, "w", encoding="utf-8"), ensure_ascii=False)
print("backend snap ok paths=", len(snap), "sample keys", keys)
