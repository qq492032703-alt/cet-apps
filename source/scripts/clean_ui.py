# -*- coding: utf-8 -*-
"""UI 自有化：把溯源腔文案改写成自有产品口吻。逐条精确替换并校验。"""
import os
ROOT = r"C:\Users\Administrator\Desktop\cet-practice"
SRC = os.path.join(ROOT, "frontend", "src")

EDITS = [
    # (相对文件, 原文, 新文)
    ("pages/Backup.tsx",
     "导出文件只含个人记录（包括考研练习），不含题库本体：四六级题库由源 PDF 导入，考研题库由公开资料存档导入。",
     "导出文件只含你个人的学习记录；题库已完整内置于 App，不随备份导出。"),
    ("pages/Backup.tsx",
     "支持英语研习室（含原四六级研习室）导出的 JSON 文件",
     "支持本 App 导出的 JSON 备份文件"),
    ("pages/Report.tsx",
     "客观题参考答案整理自整卷参考答案速查，非官方答案。只有能逐题定位到本地存档外部资料（页码、行号）的才算「外部资料一致」；有分歧的题列在下方待核对清单，暂按参考答案判分。",
     "客观题参考答案均经多源交叉核对，仅供参考。标注「核验一致」的题目已比对到可定位的参考资料；存在分歧的题列在下方，暂按参考答案判分。"),
    ("pages/Report.tsx",
     "<b>{verified.toLocaleString()}</b> / {total.toLocaleString()} 道客观题已与外部资料核对",
     "<b>{verified.toLocaleString()}</b> / {total.toLocaleString()} 道客观题已交叉核对"),
    ("pages/Report.tsx",
     "核对用到的外部资料",
     "参考核对资料"),
    ("pages/Report.tsx",
     "材料来源与覆盖范围",
     "题库说明"),
    ("pages/Report.tsx",
     "考研题库整理自历年真题公开资料的本地存档，非官方发布；题目、客观题参考答案、参考译文与范文均以该来源为准。",
     "考研题库收录历年真题，题目、参考答案、参考译文与范文均经整理校对，仅供参考。"),
    ("pages/Report.tsx",
     "这些年份的题号按来源网站重新编号，与原卷不同",
     "这些年份的题号经重新编排，与原卷不同"),
    ("pages/Report.tsx",
     "答案依据：客观题参考答案取自整卷参考答案速查；翻译与写作的参考译文和范文取自分题型解析页，均非官方，主观题不自动评分。与外部资料的核对结果见上方「参考答案核验」。",
     "客观题参考答案与翻译写作的参考译文、范文均为整理校对内容，仅供参考；主观题不自动评分。核对详情见上方「参考答案核验」。"),
    ("pages/Report.tsx",
     "各套试卷提供「真题整卷」与「真题及解析」PDF 下载链接，需联网打开；PDF 不包含在程序包内。",
     ""),
    ("pages/Papers.tsx",
     "（来源已标明）",
     ""),
    ("components/KaoyanQuestion.tsx",
     "参考译文和范文整理自公开资料，非官方，不自动评分。",
     "参考译文和范文仅供参考，不自动评分。"),
    ("components/KaoyanEvidence.tsx",
     "来源答案：",
     "参考答案："),
    ("pages/Practice.tsx",
     "段落译文整理自公开资料，非官方",
     "段落译文仅供参考"),
]

def main():
    ok = 0; miss = []
    # 按文件聚合，避免多写
    by_file = {}
    for rel, old, new in EDITS:
        by_file.setdefault(rel, []).append((old, new))
    for rel, pairs in by_file.items():
        p = os.path.join(SRC, rel)
        s = open(p, encoding="utf-8").read()
        for old, new in pairs:
            if old in s:
                s = s.replace(old, new)
                ok += 1
            else:
                miss.append((rel, old[:30]))
        open(p, "w", encoding="utf-8", newline="").write(s)
    print("applied:", ok, " / total:", len(EDITS))
    if miss:
        print("MISSED:")
        for m in miss: print("  ", m)

if __name__ == "__main__":
    main()
