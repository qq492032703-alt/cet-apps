"""从 cet6.db 导出静态题库 JSON 到 frontend/public/data/（安卓离线版用）。

用法:
    python scripts/export_static.py [db_path]
默认读 build-input/v1.5.0-cet6.db，其次 build-input/legacy-v1.1.0-cet6.db，再次 seed/cet6.db。

产物:
    frontend/public/data/index.json                 试卷列表（供 listPapers）
    frontend/public/data/paper/<paper_key>.json     单卷明细（questions/section_materials/kaoyan_canonical/answer_checks）
    frontend/public/data/answer_checks.json         全局答案核验（若存在）
    scripts/audio_manifest.json                     音频映射清单（src 原始相对路径 -> 输出文件），供 build_audio.py 用

音频策略：数据库里 audio_path 形如 "2015-06/第1套/听力/听力音频.m4a"，
多个试卷可能共享同一 audio_path（一整套听力），因此按 audio_path 的唯一值做
sha1 slug，导出后 audio_path 统一改写为 /audio/<slug>.m4a。原始音频由
build_audio.py 依据 audio_manifest.json 提取并压缩。
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
import urllib.parse
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
OUT = PROJECT / "frontend" / "public" / "data"
MANIFEST = PROJECT / "scripts" / "audio_manifest.json"

# TEXT 列里存的是 JSON 字符串，导出时解析成对象，前端直接用
JSON_COLS = {
    "options_json", "analysis_json", "flags_json", "content_json",
    "translation_json", "document_json", "shared_sources_json",
    "scope_json", "detail_json", "state_json",
}

# 前端从不读取 document_json（考研材料整包原文，实测占 ~72MB），导出时剥离以减小包体
STRIP_COLS = {"document_json"}


def resolve_db() -> Path:
    if len(sys.argv) > 1:
        p = Path(sys.argv[1])
        if not p.is_file():
            sys.exit(f"db not found: {p}")
        return p
    for cand in [
        PROJECT / "build-input" / "v1.5.0-cet6.db",
        PROJECT / "build-input" / "legacy-v1.1.0-cet6.db",
        PROJECT / "seed" / "cet6.db",
    ]:
        if cand.is_file():
            return cand
    sys.exit("no db found; pass path or put it at build-input/v1.5.0-cet6.db")


def table_cols(conn, table):
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def table_exists(conn, table):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def dump_rows(conn, table, where: str = "", params: tuple = ()):
    cols = table_cols(conn, table)
    sql = f"SELECT * FROM {table}" + (f" WHERE {where}" if where else "")
    rows = []
    for r in conn.execute(sql, params):
        d = dict(zip(cols, r))
        for c in cols:
            if c in JSON_COLS and isinstance(d[c], str) and d[c]:
                try:
                    d[c] = json.loads(d[c])
                except Exception:
                    pass
        for c in STRIP_COLS:
            d.pop(c, None)
        rows.append(d)
    return rows


def safe_name(paper_key: str) -> str:
    return urllib.parse.quote(paper_key, safe="-_.~") + ".json"


def audio_slug(audio_path: str) -> str:
    return hashlib.sha1(audio_path.encode("utf-8")).hexdigest()[:12]


def main():
    db = resolve_db()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "paper").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    print(f"db = {db}")

    papers = dump_rows(conn, "papers")

    # 音频映射：唯一 audio_path -> slug
    manifest = {}
    for p in papers:
        ap = p.get("audio_path")
        if ap:
            slug = audio_slug(ap)
            manifest[slug] = {"src": ap, "out": slug + ".m4a"}
            p["audio_path"] = "/audio/" + slug + ".m4a"
    MANIFEST.write_text(
        json.dumps(sorted(manifest.values(), key=lambda x: x["src"]),
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"audio unique={len(manifest)} (papers with audio={sum(1 for p in papers if p.get('audio_path'))})")

    (OUT / "index.json").write_text(
        json.dumps({"papers": papers}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"index.json: {len(papers)} papers")

    # 全局答案核验状态（可选）
    global answer_checks
    answer_checks = []
    if table_exists(conn, "answer_checks"):
        answer_checks = dump_rows(conn, "answer_checks")
        (OUT / "answer_checks.json").write_text(
            json.dumps(answer_checks, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        print(f"answer_checks.json: {len(answer_checks)} rows")

    # 按卷分片
    total_q = 0
    for p in papers:
        pid, key = p["id"], p["paper_key"]
        questions = dump_rows(conn, "questions", "paper_id=?", (pid,))
        questions.sort(key=lambda q: (q.get("section_order", 0), q.get("q_index", 0)))
        sm = dump_rows(conn, "section_materials", "paper_id=?", (pid,))
        ky = {}
        if table_exists(conn, "kaoyan_canonical"):
            rows = dump_rows(conn, "kaoyan_canonical", "paper_id=?", (pid,))
            ky = rows[0] if rows else {}
        ac = [a for a in answer_checks if any(q["uid"] == a.get("uid") for q in questions)]
        payload = {
            "paper": p,
            "questions": questions,
            "section_materials": sm,
            "kaoyan_canonical": ky,
            "answer_checks": ac,
        }
        (OUT / "paper" / safe_name(key)).write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        total_q += len(questions)

    print(f"paper shards: {len(papers)} files, {total_q} questions total")
    print(f"OUT = {OUT}")


if __name__ == "__main__":
    main()
