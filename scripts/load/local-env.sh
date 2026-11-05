# Source before the M4-06 local gate lines: `source scripts/load/local-env.sh` (bash or zsh).
# Local, non-secret values only: a run-scoped session secret and RSA key pair under $TMPDIR, a dummy PayPal
# client (the worker's capture re-fetch is answered by apps/worker/test/load/paypal-replay.ts, msw replaying the
# recorded sandbox response; nothing reaches PayPal or OpenAI), and the webhook test signing harness, which
# the web server accepts only under NODE_ENV=test (src/server/test-signing.ts).
# It never reads or writes a .env. Keep DATABASE_URL / PORT_OFFSET exported first.
_root="$(git rev-parse --show-toplevel)"
_dir="${TMPDIR:-/tmp}/cleared-load"
mkdir -p "$_dir"
if [ ! -f "$_dir/signing.key" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$_dir/signing.key" 2>/dev/null
  openssl pkey -in "$_dir/signing.key" -pubout -out "$_dir/signing.pub" 2>/dev/null
fi
export PORT="${LOAD_WEB_PORT:-3000}"
export APP_BASE_URL="http://localhost:${PORT}"
export SESSION_SECRET="$(openssl rand -base64 32)"
export PAYPAL_ENV=sandbox
export PAYPAL_WEBHOOK_ID=WH-M4-06-LOCAL
export PAYPAL_CLIENT_ID=load-local-client
export PAYPAL_CLIENT_SECRET=load-local-secret
export PAYPAL_WEBHOOK_TEST_PUBLIC_KEY_FILE="$_dir/signing.pub"
export LOAD_SIGNING_PRIVATE_KEY_FILE="$_dir/signing.key"
# the burst's captures belong to the seeded seller workspace (packages/db/src/seed.ts SEED_WORKSPACE_ID)
export LOAD_REPLAY=1
export LOAD_REPLAY_WORKSPACE=00000000-0000-4000-8000-00000000a5a1
export NODE_OPTIONS="--import ${_root}/apps/worker/test/load/paypal-replay.ts"
export LOG_LEVEL=warn
unset _root _dir
