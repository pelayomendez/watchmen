#!/usr/bin/env bash
# The summon action: bring the watchmen session beside you, wherever you are.
#   - none running              -> split right in this tab and start `watchmen` there
#   - running in another tab    -> move it here as a right split, focused
#   - running in this tab       -> send it back to a tab of its own, labelled "watchmen", still running
# Summoning turns follow mode on (the watch moves with you between tabs); sending it home turns it off.
# herdr injects HERDR_BIN_PATH into an action. Nothing is done on input that cannot be trusted.
set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
root="$(cd "$script_dir/.." && pwd)"
ratio="0.35"
label="watchmen"

fail() {
  echo "watchmen summon: $*" >&2
  exit 1
}

# Ids come from JSON; check them again here before any reaches an argv.
safe_id() {
  case "$1" in
    -*|*[!A-Za-z0-9_:.-]*|'') return 1 ;;
  esac
}

panes="$("$herdr_bin" pane list 2>/dev/null)" || fail "herdr pane list failed"
decision="$(printf '%s' "$panes" | node "$script_dir/herdr-summon-decide.mjs")" || fail "could not decide"

# The watch folder the last `watchmen` recorded, if it still exists.
watch_folder() {
  local pointer="${XDG_STATE_HOME:-$HOME/.local/state}/watchmen/current" folder
  [ -f "$pointer" ] || return 1
  folder="$(head -1 "$pointer")"
  case "$folder" in /*) [ -d "$folder" ] && printf '%s' "$folder" ;; *) return 1 ;; esac
}

# The new pane's id from a herdr answer: the first pane_id in it.
new_pane_id() {
  node -e '
    let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
      const m = /"pane_id"\s*:\s*"([^"]+)"/.exec(s); process.stdout.write(m ? m[1] : "")
    })'
}

# Follow mode: on when the watch is summoned beside you, off when it is sent home. The tab.focused
# hook (scripts/herdr-follow.mjs) reads it.
set_follow() {
  local dir="${XDG_STATE_HOME:-$HOME/.local/state}/watchmen"
  mkdir -p "$dir" && printf '%s\n' "$1" > "$dir/follow"
}

read -r verb a b c rest <<<"$decision"
case "$verb" in
  SPAWN)
    tab="$a"; target="$b"
    # The cwd is the rest of the line after the two ids, spaces and all.
    cwd=""
    [ -n "$c" ] && cwd="${decision#SPAWN "$a" "$b" }"
    safe_id "$tab" && safe_id "$target" || fail "unsafe id in decision"
    folder="$(watch_folder || true)"
    [ -n "$folder" ] || folder="$cwd"
    case "$folder" in /*) [ -d "$folder" ] || folder="" ;; *) folder="" ;; esac
    args=(pane split "$target" --direction right --ratio "$ratio" --focus)
    [ -n "$folder" ] && args+=(--cwd "$folder")
    created="$("$herdr_bin" "${args[@]}" 2>/dev/null)" || fail "pane split failed"
    pane="$(printf '%s' "$created" | new_pane_id)"
    safe_id "$pane" || fail "pane split gave no usable pane id"
    "$herdr_bin" pane rename "$pane" "$label" >/dev/null 2>&1 || true
    set_follow on
    exec "$herdr_bin" pane run "$pane" "$(printf '%q' "$root/bin/watchmen")"
    ;;
  BRING)
    pane="$a"; tab="$b"; target="$c"
    safe_id "$pane" && safe_id "$tab" && safe_id "$target" || fail "unsafe id in decision"
    set_follow on
    exec "$herdr_bin" pane move "$pane" --tab "$tab" --target-pane "$target" --split right --ratio "$ratio" --label "$label" --focus
    ;;
  SEND)
    pane="$a"
    safe_id "$pane" || fail "unsafe id in decision"
    set_follow off
    exec "$herdr_bin" pane move "$pane" --new-tab --tab-label "$label" --label "$label" --no-focus
    ;;
  ERROR)
    fail "${decision#ERROR }"
    ;;
  *)
    fail "unexpected decision: $decision"
    ;;
esac
