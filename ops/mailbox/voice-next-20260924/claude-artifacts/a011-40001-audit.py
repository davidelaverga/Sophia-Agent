"""A-011 independent audit: every explicit 40001 raise in backend/migrations,
including doubled-quote ('') forms inside DO-block dynamic SQL, compared with
rpc_business_errors._FORMER_40001_MESSAGES. Run from the repo root at the PR head."""
import glob
import re

src = open("backend/packages/harness/deerflow/sophia/rpc_business_errors.py").read()
py = set(re.findall(r'"([a-z0-9_]+)"', src.split("_FORMER_40001_MESSAGES")[1].split("def ")[0]))
found, sites = {}, 0
for f in sorted(glob.glob("backend/migrations/*.sql")):
    if "non_retryable" in f:
        continue
    t = open(f).read()
    for m in re.finditer(r"ERRCODE\s*=\s*('{1,2})40001\1", t, re.I):
        sites += 1
        after, before = t[m.end():m.end() + 140], t[max(0, m.start() - 200):m.start()]
        mm = re.match(r"\s*,\s*MESSAGE\s*=\s*'{1,2}([a-z0-9_]+)", after, re.I) or re.search(
            r"RAISE\s+EXCEPTION\s+'{1,2}([a-z0-9_]+)'{1,2}\s+USING\s*$", before, re.I)
        found.setdefault(mm.group(1) if mm else "??", set()).add((f.rsplit("/", 1)[-1], "doubled" if len(m.group(1)) == 2 else "single"))
print("raise sites:", sites)
print("in SQL, not in Python list:", {k: sorted(v) for k, v in found.items() if k not in py})
print("in Python list, not in SQL:", sorted(py - set(found)))
