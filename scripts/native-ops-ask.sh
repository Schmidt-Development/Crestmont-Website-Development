#!/usr/bin/env bash
# One request to the production Worker's /api/ops/portfolio-native, authorized by a one-time challenge
# (src/services/ops-challenge.ts). Used by .github/workflows/portfolio-native-ops.yml for check, onboard and
# resume (advance) alike.
#
#   scripts/native-ops-ask.sh '<JSON body without the challenge>' <response-file>
#
# Contract (regression for production run 44456707770, where `http=$(ask …)` captured the ::add-mask:: line together
# with the status, so a successful HTTP 200 was reported as a failure and the challenge was printed unmasked):
#   • the HTTP status (exactly three digits, 000 when the request could not be made) is written to <response-file>.status
#     — never to stdout, so a caller never has to capture this script's output;
#   • stdout carries only the GitHub `::add-mask::` command for the challenge, which the runner then hides everywhere;
#   • the challenge never reaches stderr, a summary or <response-file>: any copy of it in the response is replaced by ***;
#   • the challenge's files are removed before the script returns.
# Needs: PRODUCTION_URL, and WRANGLER (the pinned wrangler command) with the production Cloudflare token in the env.
set -euo pipefail
body=${1:?JSON body}
out=${2:?response file}
: "${PRODUCTION_URL:?PRODUCTION_URL}" "${WRANGLER:?WRANGLER}"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
rm -f "$out" "$out.status"
node --no-warnings scripts/ops-challenge.ts --purpose portfolio_native --out-sql "$dir/c.sql" --out-nonce "$dir/nonce" > /dev/null
nonce=$(cat "$dir/nonce")
[[ "$nonce" =~ ^[0-9a-f]{32,128}$ ]] || { echo "000" > "$out.status"; echo "::error::the one-time challenge could not be prepared" >&2; exit 0; }
echo "::add-mask::$nonce"
if ! $WRANGLER d1 execute crestmont-production --remote --env production --file "$dir/c.sql" --yes > /dev/null 2>&1; then
  echo "000" > "$out.status"; echo "::error::the one-time challenge could not be written to production" >&2; exit 0
fi
req=$(node -e 'const b=JSON.parse(process.argv[1]);b.challenge=process.argv[2];console.log(JSON.stringify(b))' "$body" "$nonce")
code=$(curl -s -o "$dir/r.json" -w '%{http_code}' --max-time 300 -X POST -H 'content-type: application/json' --data-binary @- "$PRODUCTION_URL/api/ops/portfolio-native" <<< "$req" || true)
[[ "$code" =~ ^[0-9]{3}$ ]] || code=000
# Keep the answer, never the challenge.
if [ -f "$dir/r.json" ]; then sed "s/$nonce/***/g" "$dir/r.json" > "$out"; else : > "$out"; fi
echo "$code" > "$out.status"
