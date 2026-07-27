#!/usr/bin/env bash
# oracle.sh — weighted composite quality score (servo Tier-0 template)
#
# Exit codes (servo contract — do not change):
#   0  composite >= THRESHOLD
#   1  composite <  THRESHOLD
#   2  environment error (missing tool, no components, bad component rc)
#
# Each component contributes a score in [0.0, 1.0] via a `score_<name>` shell
# function, with a weight registered in the COMPONENTS array as "<name>:<weight>".
# The final composite is a weighted average: sum(weight * score) / sum(weight).
#
# Components live inside `# SEED:start <name>` / `# SEED:end <name>` blocks so
# servo can find, replace, or splice them on re-scaffold.  See README.md
# (section "Adding a component") for the full convention.
#
# Override at runtime:
#   THRESHOLD=0.8 ./oracle.sh   # raise the gate
#   THRESHOLD=0   ./oracle.sh   # accept any score (smoke test)

set -euo pipefail

# 1.0 for the 015-01 loop: all deterministic ACs must pass ("met all ACs"),
# not the scaffold default of 0.5. Override at runtime with THRESHOLD=...
THRESHOLD="${THRESHOLD:-1.0}"

# Registered components — one "<name>:<weight>" entry per scoring function.
COMPONENTS=(
  # `tests` (full `npm test`) lifted out of the per-iteration loop gate on
  # 2026-07-01: this repo's suite includes Chrome/network tests that would
  # derail loop convergence. Whole-suite-green is enforced at jig reconcile/DoD.
  # Re-enable for a repo-wide regression gate: "tests:1"
)

# SEED:start tests
# Runs the repo's declared test command (`npm test` → node --test over
# .agents/scripts/**/test/*.test.js). Score is binary: 1.0 all-green, 0.0 otherwise.
score_tests() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ( cd "$dir" && npm test >/dev/null 2>&1 ); then
    echo "1.0"
  else
    echo "0.0"
  fi
}
# SEED:end tests







weighted_sum="0"
total_weight="0"
missing=()

for entry in "${COMPONENTS[@]:+${COMPONENTS[@]}}"; do
  name="${entry%%:*}"
  weight="${entry##*:}"
  if score="$("score_${name}")"; then
    weighted_sum="$(awk -v s="$weighted_sum" -v c="$score" -v w="$weight" \
      'BEGIN { printf "%.6f", s + c*w }')"
    total_weight="$(awk -v t="$total_weight" -v w="$weight" \
      'BEGIN { printf "%.6f", t + w }')"
  else
    rc=$?
    if [ "$rc" -eq 2 ]; then
      missing+=("$name")
    else
      echo "oracle: score_${name} returned rc=${rc}" >&2
      exit 2
    fi
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "oracle: missing components: ${missing[*]}" >&2
  exit 2
fi

if awk -v t="$total_weight" 'BEGIN { exit !(t+0 == 0) }'; then
  echo "oracle: no signals detected — populate # SEED: blocks manually" >&2
  exit 2
fi

composite="$(awk -v s="$weighted_sum" -v t="$total_weight" \
  'BEGIN { printf "%.4f", s/t }')"

printf 'oracle: composite=%s threshold=%s\n' "$composite" "$THRESHOLD"

awk -v c="$composite" -v t="$THRESHOLD" 'BEGIN { exit !(c+0 >= t+0) }'
