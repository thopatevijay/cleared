#!/usr/bin/env bash
# Fails if a secret-shaped literal or a forbidden file is tracked, staged, or in .dev-refs.md.
# First link in the landing-checks chain (/start Phase 6, /start-milestone § 3d).
# Never prints a matched value: only the file and line number.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
forbidden='(^|/)\.env$|(^|/)\.env\.(local|production|development|test)$|(^|/)\.dev-refs\.md$|application_default_credentials\.json$|-sa\.json$|service-account.*\.json$|\.pem$'

# 1. Forbidden files tracked or staged
if files=$( { git ls-files; git diff --cached --name-only; } | sort -u | grep -E "$forbidden" ); then
  echo "FORBIDDEN FILE tracked or staged:"; echo "$files" | sed 's/^/  /'; fail=1
fi

# 2. Secret-shaped literals in tracked + staged content (and in .dev-refs.md, which must hold pointers only)
patterns=(
  'AIza[0-9A-Za-z_-]{35}'                      # Google API key
  '"type"[[:space:]]*:[[:space:]]*"service_account"'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'gh[pousr]_[0-9A-Za-z]{36,}'                 # GitHub tokens
  'ya29\.[0-9A-Za-z_-]{20,}'                   # Google OAuth access token
  '1//[0-9A-Za-z_-]{30,}'                      # Google OAuth refresh token
  'sk-[A-Za-z0-9_-]{32,}'                      # generic provider keys
  'xox[baprs]-[0-9A-Za-z-]{10,}'               # Slack
)
targets=$(git ls-files; git diff --cached --name-only --diff-filter=AM)
[ -f .dev-refs.md ] && targets=$(printf '%s\n%s' "$targets" ".dev-refs.md")
targets=$(echo "$targets" | sort -u | grep -vE '^scripts/check-no-secrets\.sh$' || true)

for p in "${patterns[@]}"; do
  # shellcheck disable=SC2086
  if hits=$(echo "$targets" | xargs -I{} sh -c '[ -f "{}" ] && grep -nIE -- "$0" "{}" /dev/null | cut -d: -f1,2' "$p" 2>/dev/null); then
    if [ -n "$hits" ]; then echo "SECRET-SHAPED LITERAL (pattern: ${p%% *}):"; echo "$hits" | sed 's/^/  /'; fail=1; fi
  fi
done

if [ "$fail" -ne 0 ]; then echo "check-no-secrets: FAIL"; exit 1; fi
echo "check-no-secrets: ok"
