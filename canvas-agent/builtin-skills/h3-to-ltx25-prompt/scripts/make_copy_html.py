#!/usr/bin/env python
"""从 Markdown 稿生成「一键复制」HTML，并自带 md ↔ <pre> 逐字比对校验。

用法：
    python make_copy_html.py --md <稿.md> [--out <稿.html>] [--sub "副标题"] [--note "警示段"]

为什么必须用脚本：手写 HTML 时最容易把英文直引号敲成中文弯引号、或者漏转义 `<`，
同一份稿在两处不一致。这个脚本从 md 抽 ```text 块、自动转义、生成完立刻回读比对。
"""

from __future__ import annotations

import argparse
import html
import re
import sys
from pathlib import Path

BLOCK_RE = re.compile(r"```(?:text)?[ \t]*\r?\n(.*?)```", re.S)
PRE_RE = re.compile(r'<pre class="copy-src"[^>]*data-idx="(\d+)"[^>]*>(.*?)</pre>', re.S)

TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>__TITLE__</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 24px 80px;
    background: #14161a; color: #e6e8ec;
    font: 14px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  h1 { font-size: 19px; margin: 0 0 4px; font-weight: 600; }
  .sub { color: #8b93a1; font-size: 12.5px; margin-bottom: 20px; }
  .note {
    border-left: 3px solid #d97706; background: #1e1a12; color: #f0d9a8;
    padding: 10px 14px; border-radius: 4px; font-size: 13px; margin-bottom: 20px;
    white-space: pre-wrap;
  }
  section { margin-bottom: 26px; }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .head h2 { font-size: 13.5px; font-weight: 600; margin: 0; color: #b9c0cc; }
  button {
    border: 1px solid #3a4150; background: #232830; color: #cfd5df;
    border-radius: 5px; padding: 4px 12px; font-size: 12px; cursor: pointer;
  }
  button:hover { background: #2d333d; border-color: #4a5464; }
  button.done { border-color: #2f855a; color: #9ae6b4; background: #1c2b23; }
  pre {
    margin: 0; padding: 14px 16px; background: #0f1115; border: 1px solid #262b34;
    border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
    font: 13px/1.7 "Cascadia Code", Consolas, "Microsoft YaHei", monospace;
  }
  .bar { position: fixed; right: 24px; bottom: 20px; }
  .bar button { padding: 8px 18px; font-size: 13px; }
</style>
</head>
<body>
<h1>__TITLE__</h1>
<div class="sub">__SUB__</div>
__NOTE__
__SECTIONS__
<div class="bar"><button id="copy-all">复制全部</button></div>
<script>
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
  const old = btn.textContent;
  btn.textContent = "已复制";
  btn.classList.add("done");
  setTimeout(() => { btn.textContent = old; btn.classList.remove("done"); }, 1200);
}
document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const pre = document.getElementById(btn.dataset.copy);
    copyText(pre.textContent, btn);
  });
});
document.getElementById("copy-all").addEventListener("click", (e) => {
  const all = Array.from(document.querySelectorAll("pre")).map((p) => p.textContent).join("\\n\\n");
  copyText(all, e.currentTarget);
});
</script>
</body>
</html>
"""


def collect(md_text: str) -> list[dict[str, str]]:
    """抽出所有代码块，标题取块前最近的一个 # 标题行。"""
    items: list[dict[str, str]] = []
    cursor = 0
    for match in BLOCK_RE.finditer(md_text):
        head = md_text[cursor:match.start()]
        title = ""
        for line in reversed(head.splitlines()):
            if line.lstrip().startswith("#"):
                title = line.lstrip().lstrip("#").strip()
                break
        items.append({"title": title, "body": match.group(1).rstrip("\r\n")})
        cursor = match.end()
    return items


def render(items: list[dict[str, str]], title: str, sub: str, note: str) -> str:
    sections = []
    for index, item in enumerate(items):
        heading = item["title"] or f"片段 {index + 1}"
        sections.append(
            '<section>\n'
            f'  <div class="head"><h2>{html.escape(heading)}</h2>'
            f'<button data-copy="pre-{index}">复制</button></div>\n'
            f'  <pre class="copy-src" id="pre-{index}" data-idx="{index}">{html.escape(item["body"])}</pre>\n'
            "</section>"
        )
    note_html = f'<div class="note">{html.escape(note)}</div>' if note.strip() else ""
    return (
        TEMPLATE.replace("__TITLE__", html.escape(title))
        .replace("__SUB__", html.escape(sub))
        .replace("__NOTE__", note_html)
        .replace("__SECTIONS__", "\n".join(sections))
    )


def verify(page: str, items: list[dict[str, str]]) -> list[str]:
    """回读 HTML 里的 <pre>，逐字比对。返回不一致的描述列表。"""
    problems: list[str] = []
    found = {int(m.group(1)): html.unescape(m.group(2)) for m in PRE_RE.finditer(page)}
    if len(found) != len(items):
        problems.append(f"块数不一致：md {len(items)} 块，HTML {len(found)} 块")
    for index, item in enumerate(items):
        actual = found.get(index)
        if actual is None:
            problems.append(f"第 {index + 1} 块在 HTML 里找不到")
        elif actual != item["body"]:
            hint = "引号不一致（英文直引号 vs 中文弯引号）" if actual.replace("“", '"').replace("”", '"') == item["body"] else "内容有出入"
            problems.append(f"第 {index + 1} 块逐字不一致 —— {hint}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="Markdown 稿 → 一键复制 HTML")
    parser.add_argument("--md", required=True, help="源 Markdown 路径")
    parser.add_argument("--out", help="输出 HTML 路径（默认与 md 同名）")
    parser.add_argument("--sub", default="", help="副标题")
    parser.add_argument("--note", default="", help="顶部警示段")
    args = parser.parse_args()

    md_path = Path(args.md).expanduser()
    if not md_path.exists():
        print(f"[FAIL] 找不到 {md_path}", file=sys.stderr)
        return 2

    items = collect(md_path.read_text(encoding="utf-8"))
    if not items:
        print("[FAIL] md 里没有 ```text 代码块，先确认稿子格式", file=sys.stderr)
        return 2

    title = items[0]["title"] or md_path.stem
    page = render(items, title, args.sub, args.note)
    out_path = Path(args.out).expanduser() if args.out else md_path.with_suffix(".html")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(page, encoding="utf-8", newline="\n")

    problems = verify(page, items)
    if problems:
        print("[FAIL] md ↔ HTML 逐字比对不通过：", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print(f"[PASS] {len(items)} 块，逐字一致 → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
