# -*- coding: utf-8 -*-
"""UI 第二波：中性化溯源措辞（外部资料/非官方/来源…），全局替换 frontend/src。
长词优先，避免叠加。执行后统计残留。"""
import os, glob
ROOT = r"C:\Users\Administrator\Desktop\cet-practice"
SRC = os.path.join(ROOT, "frontend", "src")

R = [
    ("参考答案与可逐题定位的本地存档外部资料一致（非官方答案）", "参考答案与可定位的核对资料一致"),
    ("按非官方参考答案计", "按参考答案计"),
    ("参考答案非官方", "参考答案仅供参考"),
    ("（非官方答案）", "（仅供参考）"),
    ("（非官方定论）", "（仅供参考）"),
    ("（非官方）", "（仅供参考）"),
    ("非官方答案", "仅供参考"),
    ("非官方定论", "仅供参考"),
    ("非官方，", "仅供参考，"),
    ("非官方；", "仅供参考；"),
    ("均非官方", "均为整理内容"),
    ("非官方", "仅供参考"),
    ("仅来源答案", "待核对答案"),
    ("答案来源：", "参考："),
    ('source-line">来源：', 'source-line">参考：'),
    ("来源未收录原卷", "原卷未收录"),
    ("按来源网站重新编号", "题号经重新编排"),
    ("来源不完整", "未完整收录"),
    ("整理自公开资料", "已整理"),
    ("取自公开资料", "已提供"),
    ("按来源印出的选项比对", "按原卷选项比对"),
    ("按来源页面的原始分行显示", "按原始分行显示"),
    ("来源页明确标注", "原卷说明明确标注"),
    ("来源不同但编号相同", "内容不同但编号相同"),
    ("外部资料", "核对资料"),
    ("依据来源", "依据"),
]

hits = 0
changed = 0
for ext in ("*.ts", "*.tsx"):
    for f in glob.glob(os.path.join(SRC, "**", ext), recursive=True):
        s0 = open(f, encoding="utf-8").read()
        s = s0
        for a, b in R:
            if a in s:
                hits += s.count(a)
                s = s.replace(a, b)
        if s != s0:
            open(f, "w", encoding="utf-8", newline="").write(s)
            changed += 1
print("replacements:", hits, "files changed:", changed)

# 残留扫描
resid = ("非官方", "外部资料", "仅来源答案", "懒笔记", "lazynote", "Sakurajima", "o-Sakurajimamai")
for ext in ("*.ts", "*.tsx"):
    for f in glob.glob(os.path.join(SRC, "**", ext), recursive=True):
        s = open(f, encoding="utf-8").read()
        for w in resid:
            if w in s:
                print("RESID", os.path.relpath(f, ROOT), w, s.count(w))
print("done")
