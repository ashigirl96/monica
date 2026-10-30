import re
import sys
from pathlib import Path

LINK = re.compile(r"\]\(([^)\s]*)\)")
FENCE = re.compile(r"^\s*(```|~~~)")


def slug(heading):
    # shortcut: ASCII の見出しに限って GitHub の slug の作り方を近似する。元の見出しに ASCII 以外が入るなら完全なアルゴリズムが要る。
    text = re.sub(r"^#+\s*", "", heading).strip().lower()
    text = re.sub(r"[^a-z0-9 _-]", "", text)
    return text.replace(" ", "-")


def heading_lines(lines):
    found, in_fence = {}, False
    for i, line in enumerate(lines):
        if FENCE.match(line):
            in_fence = not in_fence
        elif not in_fence and line.startswith("#"):
            found.setdefault(slug(line), i)
    return found


def main(root):
    root = Path(root).resolve()
    sources = sorted(p for p in root.rglob("*.md") if not p.name.endswith(".ja.md"))
    problems = 0
    for src in sources:
        ja = src.with_name(src.stem + ".ja.md")
        if not ja.exists():
            print(f"MISSING {ja.relative_to(root)}")
            problems += 1
            continue
        a, b = src.read_text().splitlines(), ja.read_text().splitlines()
        counts = [(len(x), sum(len(LINK.findall(l)) for l in x), sum(bool(FENCE.match(l)) for l in x)) for x in (a, b)]
        status = "OK" if counts[0] == counts[1] else "MISMATCH"
        problems += status != "OK"
        print(f"{status} {src.relative_to(root)} lines {counts[0][0]}/{counts[1][0]} links {counts[0][1]}/{counts[1][1]} fences {counts[0][2]}/{counts[1][2]}")

    for ja in sorted(root.rglob("*.ja.md")):
        for n, line in enumerate(ja.read_text().splitlines(), 1):
            for target in LINK.findall(line):
                path, _, anchor = target.partition("#")
                if path.endswith(".md") and not path.endswith(".ja.md") and "://" not in path:
                    dest = (ja.parent / path).resolve()
                    if dest.is_relative_to(root):
                        print(f"LEFTOVER {ja.relative_to(root)}:{n} {target}")
                        problems += 1
                if anchor and "://" not in path:
                    problems += fix_anchor(root, ja if not path else (ja.parent / path).resolve(), anchor)
    print("DONE" if problems == 0 else f"{problems} problem(s)")


def fix_anchor(root, target_ja, anchor):
    if not target_ja.name.endswith(".ja.md") or not target_ja.exists():
        return 0
    src = target_ja.with_name(target_ja.name.removesuffix(".ja.md") + ".md")
    lines = target_ja.read_text().splitlines(keepends=True)
    tag = f'<a id="{anchor}"></a>'
    if any(tag in l for l in lines):
        return 0
    n = heading_lines(src.read_text().splitlines()).get(anchor)
    if n is None or n >= len(lines) or not lines[n].startswith("#"):
        print(f"ANCHOR {target_ja.relative_to(root)}#{anchor} not found by line; add the id by hand")
        return 1
    lines[n] = lines[n].rstrip("\n") + f" {tag}\n"
    target_ja.write_text("".join(lines))
    print(f"FIXED {target_ja.relative_to(root)}:{n + 1} #{anchor}")
    return 0


if __name__ == "__main__":
    main(sys.argv[1])
