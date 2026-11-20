#!/usr/bin/env bash
# Drives native preparation on production until it settles (Owner, 2026-11-19: "Complete supported configuration and
# real-browser verification before asserting that the entire portfolio is native-ready"). Each round is one bounded
# "prepare" request (src/routes/ops.ts → orchestrator.advanceAllNative: published entries first, cheap preparation
# before verification, a time budget and a verification budget per round, progress stored per entry — never a
# duplicate rule or pull request). It stops when every required entry is native_verified, when nothing is in progress
# any more (the rest are genuine blockers, named in the readiness), or at the deadline.
#   scripts/native-prepare-loop.sh <out-readiness.json> [max-minutes] [slug,slug,…]
# Required entries: every PUBLISHED entry, plus the named slugs. Needs PRODUCTION_URL and WRANGLER (see native-ops-ask.sh).
set -euo pipefail
out=${1:?readiness file}
max=${2:-30}
slugs=${3:-}
dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
body=$(node -e 'const s=(process.argv[1]||"").split(",").map((x)=>x.trim()).filter(Boolean);console.log(JSON.stringify({ action: "prepare", slugs: s }))' "$slugs")
deadline=$(( $(date +%s) + max * 60 ))
round=0
while :; do
  round=$((round + 1))
  bash scripts/native-ops-ask.sh "$body" "$dir/r.json"
  http=$(cat "$dir/r.json.status")
  if [ "$http" != "200" ]; then echo "round $round: HTTP $http"; else
    cp "$dir/r.json" "$out"
    verdict=$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), named = (process.argv[2] || "").split(",").filter(Boolean);
      const req = r.readiness.filter((x) => x.published || named.includes(x.slug));
      // A verification by an older verifier (stale) is being repeated: in progress, not done.
      const busy = req.filter((x) => x.state === "checking" || x.state === "preparing" || x.stale);
      const ok = req.filter((x) => x.state === "native_verified" && !x.stale);
      console.log(`${ok.length}/${req.length} verified; in progress: ${busy.map((x) => x.slug).join(", ") || "none"}; this round: ${r.round.map((x) => x.slug + "=" + x.state).join(", ") || "nothing to do"}`);
      process.exit(ok.length === req.length ? 0 : busy.length ? 2 : 3);' "$out" "$slugs") && rc=0 || rc=$?
    echo "round $round: $verdict"
    [ "$rc" = 0 ] && { echo "every required entry is native_verified"; exit 0; }
    [ "$rc" = 3 ] && { echo "settled: nothing in progress — the rest are genuine blockers (see the readiness)"; exit 0; }
  fi
  [ "$(date +%s)" -lt "$deadline" ] || { echo "deadline reached after $round rounds — progress is stored; the 15-minute job continues"; exit 0; }
  sleep "${NATIVE_PREPARE_PAUSE:-60}"
done
