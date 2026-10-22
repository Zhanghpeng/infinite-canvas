#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""LTX-2.5 提示词自检器 —— 把 h3转ltx25精修提示词 SKILL.md §8 的清单变成可执行的检查。

用法:
    python check_ltx_prompt.py --ltx <ltx提示词.txt> [--h3 <H3原稿.txt>]

退出码: 0 = 全部通过 / 1 = 有 FAIL
"""
import argparse
import io
import re
import sys

CJK = re.compile(r'[\u4e00-\u9fff]')

CUT_STMT = re.compile(
    r'hard cut transitions to'
    r'|the view cuts to'
    r'|cuts to a static'
    r'|dissolves into'
    r'|match cut connects',
    re.I,
)
SOUND_WORDS = [
    'room tone', 'ambience', 'ambient', 'music', 'drone', 'score', 'tick',
    'sound', 'silence', 'quiet', 'keeps running', 'continue',
    'fills the air', 'noise', 'crack',
]
NEG_QUALITY = re.compile(
    r'\bavoid\b'
    r'|\bno\s+(?:\w+\s+){0,2}(?:distortion|deformation|artifacts?|blur|glitch|flicker|warp|noise|deform)\b',
    re.I,
)
BANNED = [
    (r'\[Shot\s*\d', '[Shot N] 分镜标签（官方明令禁 shot list）'),
    (r'\b\d{1,2}:\d{2}', 'MM:SS 时间码（官方明令禁时间码）'),
    (r'\d\s*[-\u2011\u2013\u2014]\s*\d+\s*s\b', '0-4s 区间时间码（官方明令禁时间码）'),
    (r'<Subject', '<Subject N> 尖括号标签（LTX 无此机制）'),
    (r'<Picture', '<Picture N> 尖括号标签（LTX 无此机制）'),
    (r'<d>|</d>', '<d> 对白包裹标签'),
    (r'\(S\d\)', '(S1)/(S2) 说话人编号标记'),
    (r'\[VISUAL\]|\[SPEECH\]|\[SOUNDS\]', '[VISUAL]/[SPEECH]/[SOUNDS] 标签（仅官方 ID-LoRA 可用）'),
]
WARN_PATTERNS = [
    (r'\b(?:Setting|Soundscape|Non-?diegetic|Shot)\s*:', '字段式键值前缀'),
]
STOPWARDS = set('''with wearing and the his her that from into over which have this
they their them then than when where also while whose been being very more most
such same only just both each other another'''.split())

# 认脸关键特征：这些词在 LTX 里丢了 = 身份锚点被削弱，判 FAIL。
# 其余普通特征词丢失只报 WARN（精修稿有意精简是可以接受的）。
CRITICAL_TRAITS = {
    'tattoo', 'earring', 'piercing', 'scar', 'mole', 'birthmark', 'eyepatch',
    'bun', 'braid', 'shaggy', 'glasses', 'beard', 'moustache', 'freckle',
    'dimple', 'headdress', 'mask', 'veil', 'qipao', 'kimono', 'uniform',
}


def _stem(w):
    for suf in ('ing', 'ed', 'es', 's'):
        if len(w) - len(suf) >= 4 and w.endswith(suf):
            return w[:-len(suf)]
    return w


def _present(token, low_text):
    """token 及其词干/连字符成分出现在 LTX 里即算覆盖。"""
    forms = {token, _stem(token)}
    forms |= set(token.split('-'))
    forms |= {_stem(p) for p in token.split('-')}
    return any(f and f in low_text for f in forms)


def check_traits(h3_text, ltx_text):
    m = re.search(r'subject_definitions\s*:(.*?)(?:\n\s*\n|\nsummary\s*:)', h3_text, re.S | re.I)
    block = m.group(1) if m else h3_text
    lines = [l for l in block.splitlines() if '<Subject' in l]
    if not lines:
        return None, [], []
    ltx_low = ltx_text.lower()
    missing = []
    for line in lines:
        body = re.sub(r'<[^>]+>', ' ', line)
        for t in sorted(set(re.findall(r'[a-z][a-z\-]{3,}', body.lower()))):
            if t in STOPWARDS or t in ('subject', 'picture'):
                continue
            if not _present(t, ltx_low):
                missing.append(t)
    missing = sorted(set(missing))
    # 原词和词干都要比 —— 否则 earring 会被 stem 成 earr 而漏判
    critical = [t for t in missing
                if t in CRITICAL_TRAITS or _stem(t) in CRITICAL_TRAITS]
    return len(lines), missing, critical


def load(path):
    with io.open(path, encoding='utf-8') as f:
        return f.read()


def sentences(text):
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+', text) if s.strip()]


def shot_blocks(text):
    """返回 (镜头数, [每个镜头的文本块])。"""
    labels = re.findall(r'\[\s*shot\s+(\d+)', text, re.I)
    if labels:
        parts = re.split(r'\[\s*shot\s+\d+[^\]]*\]', text, flags=re.I)
        return max(int(x) for x in labels), [p for p in parts[1:] if p.strip()]
    sents = sentences(text)
    blocks, cur = [], []
    for s in sents:
        if CUT_STMT.search(s):
            blocks.append(' '.join(cur))
            cur = [s]
        else:
            cur.append(s)
    blocks.append(' '.join(cur))
    return len(blocks), [b for b in blocks if b.strip()]


def check_ltx(text):
    fails, warns, oks = [], [], []

    for pat, name in BANNED:
        hit = re.findall(pat, text)
        if hit:
            fails.append('残留 %s ×%d（例: %s）' % (name, len(hit), str(hit[0])[:28]))
    if not any('残留' in f for f in fails):
        oks.append('无残留标签 / 时间码 / 键值前缀')

    for pat, name in WARN_PATTERNS:
        hit = re.findall(pat, text)
        if hit:
            warns.append('用了 %s ×%d（官方允许 screenplay 风格，但流动散文更稳）' % (name, len(hit)))

    # 引号里的 CJK 不一定是台词：短的（如纹身字 "愛"、品牌名）要排除。
    # 判定为台词的条件：CJK 字数 ≥4，或含句读标点。
    dialogs = []
    for d in re.findall(r'"([^"]*)"', text):
        cjk_n = len(CJK.findall(d))
        if cjk_n >= 4 or re.search(r'[？！。…，、]', d):
            dialogs.append(d)
    bad_lang = []
    for d in dialogs:
        idx = text.find('"%s"' % d)
        back = text[max(0, idx - 220):idx]
        if not re.search(r'\bin\s+(Chinese|Mandarin)\b', back, re.I):
            bad_lang.append(d)
    if bad_lang:
        for d in bad_lang:
            fails.append('台词缺语言声明: "%s"' % d[:18])
    elif dialogs:
        oks.append('全部 %d 句台词均声明了语言' % len(dialogs))
    else:
        warns.append('未找到中文台词 —— 若本段确实无台词可忽略')

    shots, blocks = shot_blocks(text)
    if shots > 4:
        fails.append('镜头数 %d 超出官方建议 2–4（需合并）' % shots)
    else:
        oks.append('镜头数 %d，落在官方建议 2–4 区间' % shots)

    silent = []
    for i, b in enumerate(blocks, 1):
        if i == len(blocks):
            # 最后一镜后面没有切点，官方「每个切点交代声音」不适用于它
            continue
        low = b.lower()
        if not any(w in low for w in SOUND_WORDS):
            silent.append(i)
    if silent:
        for i in silent:
            fails.append('第 %d 个镜头块未声明任何声音（官方要求每切点交代声音是否延续）' % i)
    elif len(blocks) > 1:
        oks.append('全部 %d 个切点都交代了声音延续' % (len(blocks) - 1))
    else:
        oks.append('单镜头，切点声音延续检查不适用（声音写进收尾段即可）')

    neg = set(n.strip() for n in NEG_QUALITY.findall(text) if n.strip())
    if neg:
        fails.append('正向提示词含否定式质量声明: %s（应删或挪进负向名词清单）' % ', '.join(sorted(neg))[:60])
    else:
        oks.append('正向无否定式质量声明')
    narrative = re.findall(r'\b(?:no dialogue|without \w+ing|no large \w+)\b', text, re.I)
    if narrative:
        oks.append('叙事性否定 %d 处（正常描写，不计问题）' % len(narrative))

    return fails, warns, oks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ltx', required=True)
    ap.add_argument('--h3')
    a = ap.parse_args()

    ltx = load(a.ltx)
    print('=' * 70)
    print('LTX 提示词自检: %s' % a.ltx)
    print('  %d 字符' % len(ltx))
    print('=' * 70)

    fails, warns, oks = check_ltx(ltx)
    for o in oks:
        print('  [PASS] %s' % o)
    for w in warns:
        print('  [WARN] %s' % w)
    for f in fails:
        print('  [FAIL] %s' % f)

    if a.h3:
        h3 = load(a.h3)
        n, missing, critical = check_traits(h3, ltx)
        print('-' * 70)
        if n is None:
            print('  [WARN] H3 稿里找不到 <Subject N> 描述行，跳过特征覆盖检查')
        elif critical:
            print('  [FAIL] %d 个 <Subject N> 段落，认脸关键特征词丢失: %s'
                  % (n, ', '.join(critical)))
            print('         （这些是身份锚点，锁脸 LoRA 靠它们把参考块的相位贴对人）')
            fails.append('认脸关键特征词丢失')
            rest = [t for t in missing if t not in critical]
            if rest:
                print('  [WARN] 另有 %d 个普通特征词未出现: %s'
                      % (len(rest), ', '.join(rest[:20])))
        elif missing:
            print('  [WARN] %d 个普通特征词未出现（精修稿有意精简可接受）: %s'
                  % (len(missing), ', '.join(missing[:20])))
        else:
            print('  [PASS] %d 个 <Subject N> 段落的特征词 100%% 覆盖到 LTX' % n)

    print('=' * 70)
    print('结论: %s' % ('FAIL（%d 项）' % len(fails) if fails else 'PASS'))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
