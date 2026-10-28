#!/usr/bin/env python3
"""Verify the project's external prerequisites, defined in .github/plan/prereqs.json.

Each entry:
    {"id": "P-01", "what": "...", "kind": "tool|account|credential|console|purchase|decision",
     "needed_by": ["M0-05"], "who": "owner|claude", "how": "exact command or console path",
     "lands_in": ".env KEY / Secret Manager name / scope / ADC", "verify": "shell command",
     "required": true}

`verify` runs in bash with the project's .env loaded into the environment (never read or printed
by this script); its stdout and stderr are discarded, so a verify command can never leak a value.
Only its exit code matters. Entries without `verify` (decisions, purchases) are checked against
`"status": "done"` in the JSON instead.

Usage:
    python3 scripts/check-prereqs.py                    # table, exit 1 if a required item is missing
    python3 scripts/check-prereqs.py --only P-01,P-07   # just these (used by /start Phase 1)
    python3 scripts/check-prereqs.py --ticket M1-02     # the ticket's `needs:` from its plan file
    python3 scripts/check-prereqs.py --json             # machine-readable (used by waves.py)
    python3 scripts/check-prereqs.py --render           # rewrite docs/PREREQS.md from the JSON
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True,
                           text=True).stdout.strip() or ".")
SOURCE = ROOT / ".github/plan/prereqs.json"
DOC = ROOT / "docs/PREREQS.md"
PLAN = ROOT / ".github/plan"


def load() -> list[dict]:
    if not SOURCE.exists():
        print(f"no {SOURCE.relative_to(ROOT)}: run ticket M0-00 first", file=sys.stderr)
        sys.exit(2)
    return json.loads(SOURCE.read_text())


def ticket_needs(tid: str) -> list[str]:
    for p in PLAN.glob(f"{tid}-*.md"):
        m = re.search(r"^needs:\s*\[(.*?)\]", p.read_text(), re.M)
        return [x.strip().strip("\"'") for x in m.group(1).split(",") if x.strip()] if m else []
    print(f"no plan file for {tid}", file=sys.stderr)
    sys.exit(2)


def check(entry: dict) -> bool:
    cmd = entry.get("verify")
    if not cmd:
        return entry.get("status") == "done"
    env_file = ROOT / ".env"
    loader = f"set -a; . '{env_file}'; set +a; " if env_file.exists() else ""
    r = subprocess.run(["bash", "-c", f"{loader}{cmd}"], cwd=ROOT,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    return r.returncode == 0


def render(entries: list[dict], results: dict[str, bool]) -> None:
    rows = ["| id | what | kind | needed by | who | how | lands in | status |",
            "|---|---|---|---|---|---|---|---|"]
    for e in entries:
        status = "ok" if results.get(e["id"]) else ("MISSING" if e.get("required", True) else "optional")
        rows.append("| {id} | {what} | {kind} | {nb} | {who} | {how} | {li} | {st} |".format(
            id=e["id"], what=e["what"], kind=e.get("kind", ""), nb=", ".join(e.get("needed_by", [])),
            who=e.get("who", ""), how=e.get("how", "").replace("|", "\\|"),
            li=e.get("lands_in", "").replace("|", "\\|"), st=status))
    DOC.parent.mkdir(parents=True, exist_ok=True)
    DOC.write_text("# Prerequisites\n\nGenerated from `.github/plan/prereqs.json` by "
                   "`scripts/check-prereqs.py --render`. Edit the JSON, not this file.\n"
                   "Values are never recorded here: only where each one lives.\n\n"
                   + "\n".join(rows) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--ticket")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--render", action="store_true")
    a = ap.parse_args()

    entries = load()
    wanted = None
    if a.only:
        wanted = {x.strip() for x in a.only.split(",") if x.strip()}
    if a.ticket:
        wanted = set(ticket_needs(a.ticket))
    if wanted is not None:
        unknown = wanted - {e["id"] for e in entries}
        if unknown:
            print(f"unknown prerequisite ids: {sorted(unknown)}", file=sys.stderr)
            sys.exit(2)
        entries = [e for e in entries if e["id"] in wanted]

    results = {e["id"]: check(e) for e in entries}
    missing = [e for e in entries if not results[e["id"]] and e.get("required", True)]

    if a.render:
        render(load() if wanted is not None else entries, results)
    if a.json:
        print(json.dumps([{**{k: e.get(k) for k in ("id", "what", "kind", "who", "how",
                                                    "lands_in", "needed_by")},
                           "ok": results[e["id"]], "required": e.get("required", True)}
                          for e in entries], indent=2))
    else:
        for e in entries:
            mark = "ok     " if results[e["id"]] else ("MISSING" if e.get("required", True) else "skip   ")
            print(f"{mark} {e['id']:<6} {e['what']}")
            if not results[e["id"]]:
                print(f"        who: {e.get('who', '?')} · how: {e.get('how', '?')}")
        print(f"\n{len(entries) - len(missing)}/{len(entries)} ready"
              + (f" · {len(missing)} required missing" if missing else ""))
    sys.exit(1 if missing else 0)


if __name__ == "__main__":
    main()
