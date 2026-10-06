#!/usr/bin/env python3
"""PROTOTYPE (throwaway): write a stand-in for the incident's `git pull` diffstat.

Same shape as the real one (1409 files, ~150-column padded lines, ~217KB) without its file names.
"""
import random, sys

random.seed(1)
out = []
for i in range(1409):
    path = f"apps/service-{i % 37}/src/module-{i % 113}/component-{i}.test.ts"
    n = random.randint(1, 900)
    bar = "+" * min(n // 20, 30) + "-" * random.randint(0, 3)
    out.append(f" {path:<110}| {n:>5} {bar}")
out.append(" 1409 files changed, 401438 insertions(+), 19702 deletions(-)")
sys.stdout.write("\n".join(out) + "\n")
