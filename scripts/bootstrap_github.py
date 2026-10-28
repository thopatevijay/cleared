#!/usr/bin/env python3
"""
Generic. Create/sync GitHub labels, milestones and issues from .github/plan/*.md — idempotent.

Every ticket is a versioned markdown file with frontmatter. This script is the ONLY way issues get
created, so the plan in git and the plan on GitHub never drift. Safe to re-run: existing issues are
updated in place, never duplicated.

Writes .github/plan/issue-map.json (COMMITTED) mapping ticket-id -> issue number. That file is how
any future Claude session resolves "M2-04" to an issue number without prior context.

Usage:
    python3 scripts/bootstrap_github.py [--repo owner/name] [--dry-run]
"""
from __future__ import annotations

import argparse, json, re, subprocess, sys
from pathlib import Path

PLAN = Path(".github/plan")
MAP = PLAN / "issue-map.json"

MILESTONES_FILE = PLAN / "milestones.json"


def load_milestones() -> list[tuple[str, str, str]]:
    """[{title, due, description}] from .github/plan/milestones.json."""
    if not MILESTONES_FILE.exists():
        raise SystemExit(f"missing {MILESTONES_FILE} — see the template for its shape")
    return [(m["title"], m["due"], m.get("description", ""))
            for m in json.loads(MILESTONES_FILE.read_text())]

LABELS = {
    "day-0": "0e8a16", "day-1": "1d76db", "day-2": "5319e7", "day-3": "b60205", "day-4": "d93f0b",
    "gate": "000000", "backlog": "fbca04", "meta": "cfd3d7",
    "backend": "0052cc", "frontend": "006b75", "cv": "5319e7", "infra": "444444",
    "data": "1d76db", "docs": "c2e0c6", "deploy": "d4c5f9", "security": "b60205",
    "pillar-1": "c5def5", "pillar-2": "c5def5", "pillar-3": "c5def5", "pillar-4": "c5def5",
    "differentiator": "ff9f1c", "critical": "b60205", "headline": "ff9f1c",
    "mandatory-requirement": "b60205", "mandatory-deliverable": "b60205",
    "model-1-deliverable": "0e8a16", "model-3-core": "0e8a16",
    "scored-dimension": "fbca04", "test-case": "d93f0b", "compliance": "5319e7",
    "bonus": "bfdadc", "stretch": "bfdadc", "recon": "0e8a16",
    "blocker-risk": "e11d21", "high-value": "ff9f1c", "submission": "d93f0b",
    "ai": "5319e7", "perf": "fef2c0", "status:in-progress": "fbca04",
    "status:blocked": "e11d21", "status:done": "0e8a16",
}


def sh(args: list[str], check=True) -> str:
    r = subprocess.run(args, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"FAILED: {' '.join(args)}\n{r.stderr.strip()}")
    return r.stdout.strip()


def parse(path: Path) -> dict:
    """Minimal frontmatter parser — title/milestone/estimate as scalars, labels/blocked_by as lists."""
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        raise SystemExit(f"{path}: missing frontmatter")
    fm, body = m.group(1), m.group(2).strip()
    meta: dict = {}
    for line in fm.splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if v.startswith("["):
            meta[k] = [x.strip().strip('"\'') for x in v[1:-1].split(",") if x.strip()]
        else:
            meta[k] = v.strip('"\'')
    meta["body"] = body
    tid = re.match(r"^([A-Z0-9]+-[A-Z0-9]+)", path.name)
    if not tid:
        raise SystemExit(f"{path}: filename must start with a ticket id like M2-04- or BL-01-")
    meta["ticket_id"] = tid.group(1)
    meta["file"] = str(path)
    for req in ("title", "milestone"):
        if req not in meta:
            raise SystemExit(f"{path}: frontmatter missing '{req}'")
    return meta


FALLBACK_COLOUR = "ededed"


def ensure_labels(repo: str, dry: bool, used: set[str] | None = None) -> None:
    existing = {l["name"] for l in json.loads(
        sh(["gh", "label", "list", "-R", repo, "--limit", "200", "--json", "name"]) or "[]")}
    wanted = dict(LABELS)
    for name in sorted(used or set()):
        wanted.setdefault(name, FALLBACK_COLOUR)
    for name, colour in wanted.items():
        if name in existing:
            continue
        print(f"  + label {name}")
        if not dry:
            sh(["gh", "label", "create", name, "-R", repo, "--color", colour, "--force"])


def ensure_milestones(repo: str, dry: bool) -> dict[str, int]:
    out = sh(["gh", "api", f"repos/{repo}/milestones?state=all&per_page=100"])
    rows = json.loads(out or "[]")
    have = {m["title"]: m["number"] for m in rows}
    current = {m["title"]: m for m in rows}
    for title, due, desc in MILESTONES:
        if title in have:
            m = current[title]
            if (m.get("due_on") or "")[:10] != due or (m.get("description") or "") != desc:
                print(f"  ~ milestone {title} (syncing due date / description)")
                if not dry:
                    sh(["gh", "api", f"repos/{repo}/milestones/{m['number']}", "-X", "PATCH",
                        "-f", f"description={desc}", "-f", f"due_on={due}T23:59:59Z"])
            continue
        print(f"  + milestone {title}")
        if dry:
            have[title] = -1
            continue
        res = sh(["gh", "api", f"repos/{repo}/milestones", "-X", "POST",
                  "-f", f"title={title}", "-f", f"description={desc}",
                  "-f", f"due_on={due}T23:59:59Z"])
        have[title] = json.loads(res)["number"]
    return have


def existing_issues(repo: str) -> dict[str, dict]:
    """Open issues keyed by ticket id (the title prefix), so renaming a ticket's title updates its
    issue instead of creating a duplicate. Closed issues are ignored for matching."""
    out = sh(["gh", "issue", "list", "-R", repo, "--state", "open", "--limit", "300",
              "--json", "number,title,state"])
    rows = json.loads(out or "[]")
    have: dict[str, dict] = {}
    for i in rows:
        m = re.match(r"^([A-Z0-9]+-[A-Z0-9]+)\b", i["title"])
        if m:
            have.setdefault(m.group(1), i)
    # Fallback for titles without an id prefix (e.g. BL-01): the committed issue map.
    by_num = {i["number"]: i for i in rows}
    if MAP.exists():
        for tid, num in json.loads(MAP.read_text()).items():
            if tid not in have and num in by_num:
                have[tid] = by_num[num]
    return have


def upsert_dependency_comment(repo: str, num: int, note: str) -> None:
    """Edit the existing 'Blocked by' comment if there is one, delete extra copies, else create."""
    out = sh(["gh", "api", f"repos/{repo}/issues/{num}/comments", "--paginate",
              "--jq", '[.[] | select(.body | startswith("**Blocked by:**")) | {id, body}]'])
    found = json.loads(out or "[]")
    if found and found[0]["body"] == note and len(found) == 1:
        return
    for extra in found[1:]:
        sh(["gh", "api", "-X", "DELETE", f"repos/{repo}/issues/comments/{extra['id']}"])
    if found:
        sh(["gh", "api", "-X", "PATCH", f"repos/{repo}/issues/comments/{found[0]['id']}",
            "-f", f"body={note}"])
    else:
        sh(["gh", "issue", "comment", str(num), "-R", repo, "--body", note])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", help="owner/name (default: derived from git remote origin)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    dry = args.dry_run
    if not args.repo:
        args.repo = sh(["gh", "repo", "view", "--json", "nameWithOwner",
                        "-q", ".nameWithOwner"])
        print(f"repo (from git remote): {args.repo}")

    if not PLAN.is_dir():
        raise SystemExit("run from the repo root (.github/plan not found)")

    global MILESTONES
    MILESTONES = load_milestones()
    tickets = [parse(p) for p in sorted(PLAN.glob("*.md"))]
    def order(tid: str) -> tuple[int, str]:
        m = re.match(r"^[MD](\d+)-", tid)
        return (-1 if tid.startswith("BL-") else int(m.group(1)) if m else 999, tid)
    tickets.sort(key=lambda t: order(t["ticket_id"]))
    print(f"{len(tickets)} tickets in {PLAN}\n")

    used = {l for t in tickets for l in t.get("labels", [])}
    print("labels:");     ensure_labels(args.repo, dry, used)
    print("milestones:"); ms = ensure_milestones(args.repo, dry)
    print("issues:")

    have = existing_issues(args.repo)
    mapping: dict[str, int] = json.loads(MAP.read_text()) if MAP.exists() else {}

    for t in tickets:
        tid, title = t["ticket_id"], t["title"]
        body = (f"<!-- ticket:{tid} source:{t['file']} -->\n\n"
                f"**Ticket** `{tid}` · **Milestone** {t['milestone']} · "
                f"**Estimate** {t.get('estimate','—')}\n\n{t['body']}\n")
        labels = t.get("labels", [])
        if tid in have:
            num = have[tid]["number"]
            mapping[tid] = num
            print(f"  = #{num:<3} {tid}  (exists — syncing body)")
            if not dry:
                cmd = ["gh", "issue", "edit", str(num), "-R", args.repo, "--title", title,
                       "--body", body]
                if t["milestone"] in ms:
                    cmd += ["--milestone", t["milestone"]]
                for l in labels:
                    cmd += ["--add-label", l]
                sh(cmd)
            continue
        print(f"  + {tid}  {title[:62]}")
        if dry:
            mapping.setdefault(tid, -1)
            continue
        cmd = ["gh", "issue", "create", "-R", args.repo, "--title", title, "--body", body]
        if t["milestone"] in ms:
            cmd += ["--milestone", t["milestone"]]
        for l in labels:
            cmd += ["--label", l]
        url = sh(cmd)
        mapping[tid] = int(url.rstrip("/").split("/")[-1])

    # Second pass: dependency cross-references, now that every id has a number.
    print("\ndependencies:")
    for t in tickets:
        deps = t.get("blocked_by", [])
        tid = t["ticket_id"]
        if not deps or tid not in mapping or mapping[tid] < 0:
            continue
        refs = ", ".join(f"#{mapping[d]}" for d in deps if d in mapping and mapping[d] > 0)
        if not refs:
            continue
        note = (f"**Blocked by:** {refs}\n\n"
                f"Do not start this ticket until every blocker is closed. "
                f"Verify with `/status` or `gh issue view <n>`.")
        print(f"  #{mapping[tid]:<3} {tid} blocked by {refs}")
        if not dry:
            upsert_dependency_comment(args.repo, mapping[tid], note)

    MAP.write_text(json.dumps(dict(sorted(mapping.items())), indent=2) + "\n")
    print(f"\nwrote {MAP} ({len(mapping)} tickets)")
    print("COMMIT issue-map.json — it is how any new session resolves ticket ids to issue numbers.")


if __name__ == "__main__":
    main()
