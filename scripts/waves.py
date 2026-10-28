#!/usr/bin/env python3
"""Plan the parallel execution of one milestone for /start-milestone.

Decides, deterministically and before any worker starts:

  1. Waves: topological levels over `blocked_by` among the milestone's OPEN tickets. Tickets in a
     wave share no dependency and may run in parallel.
  2. Batches: each wave split so no batch exceeds `max_workers` or holds two tickets claiming the
     same EXCLUSIVE resource. Resources come only from each ticket's `resources:` frontmatter
     (plus `UI` for `frontend`-labelled tickets); limits come from `.github/plan/resources.json`:
         {"max_workers": 3,
          "exclusive": {"DEPLOY": "one Terraform state / one set of services"},
          "budgeted":  {"LLM": "spend budget per ticket"}}
  3. A PORT_OFFSET per worker so parallel local stacks never collide.
  4. Holds: a ticket whose `needs:` prerequisites fail `scripts/check-prereqs.py` is HELD, and so is
     everything that depends on it. Held tickets are not spawned; everything else still runs.
  5. Pre-flight: dirty tree, not on main, docker down, stray `.prp/` or `feat/` branches,
     `status:blocked`, `status:in-progress` (owned by another session).

Membership and open/closed state come from GitHub (`gh`, which must run OUTSIDE the Bash sandbox).
No GitHub, no plan: exit 2. Gate tickets (label `gate`) are never spawned; the owner runs /gate.

Usage:
    python3 scripts/waves.py M1        # or a bare digit: 1
    python3 scripts/waves.py 1 --json

Exit codes: 0 plan · 1 unknown/empty milestone · 2 cannot reach GitHub.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

PLAN = Path(".github/plan")
ISSUE_MAP = PLAN / "issue-map.json"
RESOURCES = PLAN / "resources.json"


@dataclass
class Ticket:
    tid: str
    issue: int
    title: str
    blocked_by: list[str]
    labels: list[str]
    needs: list[str]
    state: str = "OPEN"
    resources: list[str] = field(default_factory=list)
    hazards: list[str] = field(default_factory=list)
    held: list[str] = field(default_factory=list)
    port_offset: int = 0


def sh(args: list[str]) -> tuple[int, str]:
    r = subprocess.run(args, capture_output=True, text=True)
    return r.returncode, (r.stdout if r.returncode == 0 else r.stderr).strip()


def frontmatter(path: Path) -> dict:
    m = re.match(r"^---\n(.*?)\n---\n", path.read_text(encoding="utf-8"), re.S)
    meta: dict = {}
    for line in (m.group(1).splitlines() if m else []):
        k, _, v = line.partition(":")
        v = v.strip()
        meta[k.strip()] = ([x.strip().strip("\"'") for x in v[1:-1].split(",") if x.strip()]
                           if v.startswith("[") else v.strip("\"'"))
    return meta


def load_plan() -> dict[str, dict]:
    out = {}
    for p in sorted(PLAN.glob("*.md")):
        m = re.match(r"^([A-Z0-9]+-[A-Z0-9]+)", p.name)
        if m:
            out[m.group(1)] = frontmatter(p)
    return out


def load_limits() -> tuple[int, set[str]]:
    if not RESOURCES.exists():
        return 3, set()
    cfg = json.loads(RESOURCES.read_text())
    return int(cfg.get("max_workers", 3)), set(cfg.get("exclusive", {}))


def failing_prereqs() -> tuple[dict[str, dict], str | None]:
    script = Path("scripts/check-prereqs.py")
    if not script.exists() or not (PLAN / "prereqs.json").exists():
        return {}, "no prerequisites inventory yet (ticket M0-00): holds not evaluated"
    code, out = sh([sys.executable, str(script), "--json"])
    try:
        rows = json.loads(out)
    except json.JSONDecodeError:
        return {}, f"check-prereqs.py failed: {out[:200]}"
    return {r["id"]: r for r in rows if not r["ok"] and r.get("required", True)}, None


def resolve_milestone(requested: str, titles: list[str]) -> str:
    num = requested.upper().lstrip("MD")
    for t in titles:
        if re.match(rf"^[MD]{re.escape(num)}\b", t) or t.lower() == requested.lower():
            return t
    print(f"unknown milestone {requested!r}; known: {titles}", file=sys.stderr)
    sys.exit(1)


def waves_for(tickets: dict[str, Ticket], done: set[str]) -> list[list[str]]:
    remaining = {t for t, k in tickets.items() if k.state == "OPEN"}
    done = set(done)
    waves: list[list[str]] = []
    while remaining:
        ready = sorted(t for t in remaining if all(b in done for b in tickets[t].blocked_by))
        if not ready:
            waves.append(sorted(remaining))
            break
        waves.append(ready)
        done |= set(ready)
        remaining -= set(ready)
    return waves


def batches_for(wave: list[str], tickets: dict[str, Ticket], cap: int,
                exclusive: set[str]) -> list[list[str]]:
    batches: list[list[str]] = []
    for t in wave:
        for b in batches:
            used = {r for x in b for r in tickets[x].resources}
            if len(b) < cap and not (set(tickets[t].resources) & used & exclusive):
                b.append(t)
                break
        else:
            batches.append([t])
    return batches


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("milestone")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    plan = load_plan()
    imap: dict[str, int] = json.loads(ISSUE_MAP.read_text()) if ISSUE_MAP.exists() else {}
    code, out = sh(["gh", "issue", "list", "--state", "all", "--limit", "500",
                    "--json", "number,title,state,labels,milestone"])
    if code != 0:
        print(f"cannot reach GitHub: {out}\n(run gh outside the Bash sandbox)", file=sys.stderr)
        sys.exit(2)
    issues = json.loads(out)
    by_num = {i["number"]: i for i in issues}
    ms = resolve_milestone(args.milestone,
                           sorted({i["milestone"]["title"] for i in issues if i.get("milestone")}))
    cap, exclusive = load_limits()
    closed = {t for t, n in imap.items() if by_num.get(n, {}).get("state") == "CLOSED"}

    tickets: dict[str, Ticket] = {}
    unmapped: list[str] = []
    for i in issues:
        if (i.get("milestone") or {}).get("title") != ms:
            continue
        tid = next((t for t, n in imap.items() if n == i["number"]), None)
        if tid is None:
            if i["state"] == "OPEN":
                unmapped.append(f"#{i['number']} {i['title']}")
            continue
        meta = plan.get(tid, {})
        labels = [l["name"] for l in i["labels"]]
        res = list(meta.get("resources", []))
        if "frontend" in labels and "UI" not in res:
            res.append("UI")
        tickets[tid] = Ticket(tid=tid, issue=i["number"], title=i["title"],
                              blocked_by=meta.get("blocked_by", []), labels=labels,
                              needs=meta.get("needs", []), state=i["state"], resources=res)
    if not tickets:
        print(f"milestone {ms!r} has no mapped tickets", file=sys.stderr)
        sys.exit(1)

    open_ids = [t for t, k in tickets.items() if k.state == "OPEN"]
    gates = [t for t in open_ids if "gate" in tickets[t].labels]
    owned = [t for t in open_ids if "status:in-progress" in tickets[t].labels]
    external = sorted({b for t in open_ids for b in tickets[t].blocked_by
                       if b not in tickets and b not in closed})

    global_h: list[str] = []
    if sh(["git", "status", "--porcelain"])[1]:
        global_h.append("dirty working tree")
    branch = sh(["git", "branch", "--show-current"])[1]
    if branch != "main":
        global_h.append(f"not on main (on {branch!r})")
    if sh(["docker", "info", "--format", "{{.ServerVersion}}"])[0] != 0:
        global_h.append("docker is not running")
    branches = sh(["git", "branch", "-a", "--format=%(refname:short)"])[1].splitlines()

    missing, prereq_note = failing_prereqs()
    for t in open_ids:
        k = tickets[t]
        if Path(f".prp/{t}.md").exists():
            k.hazards.append(f".prp/{t}.md exists: interrupted work, resume with /start {t}")
        if any(f"feat/{t.lower()}-" in b for b in branches):
            k.hazards.append(f"a feat/{t.lower()}-* branch exists")
        if "status:blocked" in k.labels:
            k.hazards.append("labelled status:blocked: read its blocked note first")
        for b in k.blocked_by:
            if b in external:
                k.held.append(f"blocker {b} (outside this milestone) is still open")
        for n in k.needs:
            if n in missing:
                k.held.append(f"prerequisite {n} missing: {missing[n]['what']} "
                              f"(who: {missing[n].get('who')}; how: {missing[n].get('how')})")

    # Holds propagate to dependants inside the milestone.
    changed = True
    while changed:
        changed = False
        for t in open_ids:
            for b in tickets[t].blocked_by:
                if b in tickets and (tickets[b].held or tickets[b].hazards) and \
                        not any(b in h for h in tickets[t].held):
                    tickets[t].held.append(f"depends on {b}, which is held")
                    changed = True

    layout = waves_for(tickets, closed | set(external))
    skip = set(gates) | set(owned)
    plan_out = []
    offset = 0
    for w in layout:
        runnable = [t for t in w if t not in skip and not tickets[t].held and not tickets[t].hazards]
        batches = batches_for(runnable, tickets, cap, exclusive)
        for b in batches:
            for t in b:
                offset += 100
                tickets[t].port_offset = offset
        plan_out.append({"batches": batches,
                         "held": [t for t in w if t not in skip and (tickets[t].held or tickets[t].hazards)]})

    spawnable = [t for w in plan_out for b in w["batches"] for t in b]
    safe = not global_h and bool(spawnable)

    if args.json:
        print(json.dumps({"milestone": ms, "safe_to_spawn": safe, "global_hazards": global_h,
                          "prereq_note": prereq_note, "unmapped_issues": unmapped,
                          "owned_by_other_session": owned, "gates": gates, "waves": plan_out,
                          "tickets": {t: asdict(k) for t, k in tickets.items()}}, indent=2))
        return

    print(f"Milestone: {ms}   open {len(open_ids)} / total {len(tickets)}   "
          f"max_workers={cap} exclusive={sorted(exclusive) or '-'}")
    if prereq_note:
        print(f"⚠ {prereq_note}")
    for h in unmapped:
        print(f"⚠ issue in milestone but not in issue-map.json (not planned): {h}")
    for h in global_h:
        print(f"✋ pre-flight: {h}")
    for t in owned:
        print(f"⏳ owned by another session: {t} (#{tickets[t].issue})")
    for wi, w in enumerate(plan_out):
        print(f"\nWave {wi}")
        for bi, b in enumerate(w["batches"]):
            print(f"  batch {bi} ({len(b)} worker{'s' if len(b) != 1 else ''})")
            for t in b:
                k = tickets[t]
                print(f"    {t:<9} #{k.issue:<4} [{','.join(k.resources) or '-'}] "
                      f"PORT_OFFSET={k.port_offset}  {k.title}")
        for t in w["held"]:
            k = tickets[t]
            print(f"  HELD {t:<9} #{k.issue:<4} {k.title}")
            for h in k.hazards + k.held:
                print(f"         ✋ {h}")
    for g in gates:
        print(f"\nGate (not spawned; the owner runs it): /gate {g}")
    print(f"\nSpawnable now: {len(spawnable)} · Held: "
          f"{sum(len(w['held']) for w in plan_out)} · Safe to spawn: {'YES' if safe else 'NO'}")


if __name__ == "__main__":
    main()
