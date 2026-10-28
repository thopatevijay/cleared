"""Mechanical checks of the ticket plan, run by /kickoff (D5) and before re-syncing issues.

Checks: frontmatter fields, title prefix, milestone titles, resource names, the seven body sections,
secret-shaped text, unknown blocked_by ids, dependency cycles, and that every gate covers every
ticket of its milestone. Prints tickets and hours per milestone. Exit 1 on any problem.

    python3 scripts/check-plan.py                 # .github/plan
    python3 scripts/check-plan.py path/to/plan
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

plan = Path(sys.argv[1] if len(sys.argv) > 1 else ".github/plan")
milestones = [m["title"] for m in json.loads((plan / "milestones.json").read_text())]
resources = json.loads((plan / "resources.json").read_text())
known_res = set(resources["exclusive"]) | set(resources["budgeted"])
SECTIONS = ["## Context", "## Scope", "## Out of scope", "## Acceptance Criteria",
            "## Deliverables", "## Validation Gate", "## Handoff"]
problems, tickets = [], {}


def field(fm, name):
    m = re.search(rf"^{name}:\s*(.*)$", fm, re.M)
    return m.group(1).strip() if m else None


def as_list(raw):
    return re.findall(r'"?([A-Za-z0-9_.-]+)"?', raw.strip("[]")) if raw else []


for f in sorted(plan.glob("*.md")):
    text = f.read_text()
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        problems.append(f"{f.name}: no frontmatter"); continue
    fm, body = m.groups()
    tid = re.match(r"^([A-Z0-9]+-[A-Z0-9]+)", f.name).group(1)
    title, ms = field(fm, "title"), (field(fm, "milestone") or "").strip('"')
    est = field(fm, "estimate")
    for name in ("title", "milestone", "labels", "blocked_by", "estimate", "resources", "needs"):
        if field(fm, name) is None:
            problems.append(f"{tid}: missing {name}")
    if title and not title.strip('"').startswith(f"{tid} · "):
        problems.append(f"{tid}: title does not start with '{tid} · '")
    if ms not in milestones:
        problems.append(f"{tid}: milestone {ms!r} not in milestones.json")
    for r in as_list(field(fm, "resources")):
        if r not in known_res:
            problems.append(f"{tid}: unknown resource {r}")
    if tid != "BL-01":
        missing = [s for s in SECTIONS if s not in body]
        if missing:
            problems.append(f"{tid}: missing sections {missing}")
    if re.search(r"(sk-ant-|AKIA[0-9A-Z]{12}|-----BEGIN)", text):
        problems.append(f"{tid}: secret-shaped text")
    hours = float(re.sub(r"[^0-9.]", "", est or "0") or 0)
    tickets[tid] = {"ms": ms, "blocked_by": as_list(field(fm, "blocked_by")),
                    "labels": as_list(field(fm, "labels")), "hours": hours}

for tid, t in tickets.items():
    for b in t["blocked_by"]:
        if b not in tickets:
            problems.append(f"{tid}: blocked_by unknown {b}")

# cycles
state = {}
def visit(n, path):
    if state.get(n) == 1:
        problems.append("cycle: " + " -> ".join(path + [n])); return
    if state.get(n) == 2:
        return
    state[n] = 1
    for b in tickets[n]["blocked_by"]:
        if b in tickets:
            visit(b, path + [n])
    state[n] = 2
for n in tickets:
    visit(n, [])

# gates cover their milestone
by_ms = defaultdict(list)
for tid, t in tickets.items():
    by_ms[t["ms"]].append(tid)
for tid, t in tickets.items():
    if tid.endswith("-GATE"):
        if "gate" not in t["labels"]:
            problems.append(f"{tid}: gate without 'gate' label")
        others = {x for x in by_ms[t["ms"]] if x != tid and x != "BL-01" and not x.endswith("-SUBMIT")}
        def upstream(n, seen):
            for b in tickets[n]["blocked_by"]:
                if b in tickets and b not in seen:
                    seen.add(b); upstream(b, seen)
            return seen
        missed = others - upstream(tid, set())
        if missed:
            problems.append(f"{tid}: does not cover {sorted(missed)}")

print(f"tickets: {len(tickets)}")
for ms in milestones:
    ids = by_ms[ms]
    print(f"  {ms:32s} {len(ids):2d} tickets  {sum(tickets[i]['hours'] for i in ids):5.1f}h")
print(f"  total hours: {sum(t['hours'] for t in tickets.values()):.1f}")
print("PROBLEMS:" if problems else "no problems found")
for p in problems:
    print("  -", p)
sys.exit(1 if problems else 0)
