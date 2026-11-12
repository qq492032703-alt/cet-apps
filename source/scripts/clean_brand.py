# -*- coding: utf-8 -*-
"""清除原作者痕迹：静态数据 JSON + 前端源码文案。
- data/paper/*.json, index.json, meta.json, answer_checks.json：递归清洗所有字符串，
  source_file / source_url 一律置 null（离线无 PDF，且避免暴露作者域名/路径），
  answer_source 若为外链则置 null，否则做品牌替换。
- frontend/src/**/*.ts(x)：文本替换品牌词。
可重复执行（幂等）。
"""
import json, glob, os, sys

ROOT = r"C:\Users\Administrator\Desktop\cet-practice"
DATA = os.path.join(ROOT, "frontend", "public", "data")
SRC  = os.path.join(ROOT, "frontend", "src")

# 顺序很重要：长的、带括号的放前面
REPL = [
    ("懒笔记（lazynote）历年真题网页", "历年真题公开资料网页"),
    ("懒笔记整卷答案表", "整卷参考答案速查"),
    ("懒笔记分题型解析页", "分题型参考解析"),
    ("懒笔记段落译文", "参考段落译文"),
    ("懒笔记存档", "公开资料存档"),
    ("lazynote", "资料"),
    ("懒笔记", "公开资料"),
    ("o-Sakurajimamai", "englishstudy"),
    ("Sakurajima", "englishstudy"),
    ("linux.do", "englishstudy"),
]
BAD_SUB = ("懒笔记", "lazynote", "sakurajima", "o-sakurajimamai", "linux.do")

stats = {"repl": 0, "null_source": 0, "null_answer": 0}

def clean_str(s: str) -> str:
    for a, b in REPL:
        if a in s:
            stats["repl"] += s.count(a)
            s = s.replace(a, b)
    return s

def is_bad(v):
    return isinstance(v, str) and any(b in v.lower() for b in BAD_SUB)

def walk(o):
    if isinstance(o, dict):
        for k in list(o.keys()):
            v = o[k]
            if k in ("source_file", "source_url"):
                if v not in (None, ""):
                    stats["null_source"] += 1
                o[k] = None
                continue
            if k == "answer_source":
                if is_bad(v) or (isinstance(v, str) and v.strip().startswith("http")):
                    o[k] = None
                    stats["null_answer"] += 1
                else:
                    o[k] = clean_str(v) if isinstance(v, str) else v
                continue
            o[k] = walk(v)
        return o
    if isinstance(o, list):
        return [walk(x) for x in o]
    if isinstance(o, str):
        return clean_str(o)
    return o

def process_json_files():
    files = glob.glob(os.path.join(DATA, "paper", "*.json"))
    files += [os.path.join(DATA, n) for n in ("index.json", "meta.json", "answer_checks.json")]
    for f in files:
        if not os.path.exists(f):
            continue
        raw = open(f, "r", encoding="utf-8").read()
        try:
            d = json.loads(raw)
        except Exception as e:
            print("SKIP(json err)", f, e); continue
        d = walk(d)
        out = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
        open(f, "w", encoding="utf-8", newline="").write(out)
    print("json files processed:", len(files))

def process_src():
    n = 0
    for ext in ("*.ts", "*.tsx"):
        for f in glob.glob(os.path.join(SRC, "**", ext), recursive=True):
            raw = open(f, "r", encoding="utf-8").read()
            new = clean_str(raw)
            if new != raw:
                open(f, "w", encoding="utf-8", newline="").write(new)
                n += 1
    print("src files changed:", n)

if __name__ == "__main__":
    process_json_files()
    process_src()
    print("STATS", stats)
