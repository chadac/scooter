# Before the agent's kanban_set_status: run the command gates its move must pass, in this
# sandbox, and record each run with the broker, which refuses the move without a fresh pass.
in=$(cat)
stage=$(printf '%s' "$in" | jq -r '.tool_input.column // empty')
[ -n "$stage" ] || exit 0
query=$(jq -rn --arg s "$stage" '"stage=\($s | @uri)"')
todo=$(agent-broker "kanban/gates/run?$query" -f) || exit 0
n=$(printf '%s' "$todo" | jq '.gates | length')
[ "${n:-0}" -gt 0 ] || exit 0

runs='[]'
failed=""
for i in $(seq 0 $((n - 1))); do
  gate=$(printf '%s' "$todo" | jq -c ".gates[$i]")
  id=$(printf '%s' "$gate" | jq -r .id)
  name=$(printf '%s' "$gate" | jq -r .name)
  cmd=$(printf '%s' "$gate" | jq -r .command)
  clean=$(printf '%s' "$gate" | jq -r .clean)
  limit=$(printf '%s' "$gate" | jq -r .timeout_seconds)
  dir=/workspace/$(printf '%s' "$gate" | jq -r .workdir)
  log=$(mktemp)
  commit=""
  wt=""
  ok=false
  if [ ! -d "$dir" ]; then
    echo "$dir does not exist. Clone the repo there, or ask the user to fix the gate's directory." >"$log"
  elif [ "$clean" = true ] && ! commit=$(git -C "$dir" rev-parse HEAD 2>>"$log"); then
    echo "$dir is not a git repository with a commit, so there is nothing to check out cleanly." >>"$log"
  else
    run_in=$dir
    if [ "$clean" = true ]; then
      # The last commit only: uncommitted edits and stray files don't count.
      wt=$(mktemp -d /tmp/kanban-gate.XXXXXX)
      git -C "$dir" worktree add --quiet --detach "$wt" "$commit" >>"$log" 2>&1 && run_in=$wt
    fi
    if [ "$run_in" = "$dir" ] && [ "$clean" = true ]; then
      echo "could not check out $commit cleanly." >>"$log"
    elif (cd "$run_in" && timeout "$limit" bash -c "$cmd") >>"$log" 2>&1; then
      ok=true
    else
      code=$?
      [ "$code" = 124 ] && echo "timed out after ${limit}s" >>"$log"
    fi
    [ -n "$wt" ] && git -C "$dir" worktree remove --force "$wt" >/dev/null 2>&1
  fi
  out=$(tail -c 4000 "$log")
  rm -f "$log"
  runs=$(printf '%s' "$runs" | jq -c --arg g "$id" --argjson p "$ok" --arg o "$out" --arg c "$commit" \
    '. + [{gate: $g, passed: $p, output: $o, commit: $c}]')
  if [ "$ok" != true ]; then
    failed="$failed

The gate \"$name\" failed${commit:+ on ${commit:0:12}}:
$(printf '%s' "$out" | tail -c 2000)"
    # Later gates wait until this one passes.
    break
  fi
done

printf '%s' "$runs" | jq -c '{runs: .}' | agent-broker kanban/gates/runs -f -X POST -H 'Content-Type: application/json' -d @- >/dev/null 2>&1 || true
if [ -n "$failed" ]; then
  echo "This card can't leave its stage yet.$failed

Fix what failed, commit, and call kanban_set_status again." >&2
  exit 2
fi
exit 0
