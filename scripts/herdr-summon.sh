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
# herdr's --ratio is the FIRST pane's share: 0.7 leaves you 70% and the watch 30%. WATCHMEN_RATIO
# overrides it with 0.1 to 0.9 (up to three decimals); anything else is ignored.
ratio="0.7"
if [[ "${WATCHMEN_RATIO:-}" =~ ^0?\.([1-8][0-9]{0,2}|9|90{1,2})$ ]]; then ratio="$WATCHMEN_RATIO"; fi
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
  # herdr 0.9.0 does not run the tab.focused hook on UI tab switches, so a follower process
  # subscribes to the socket instead: started detached, once, and gone when follow turns off.
  if [ "$1" = "on" ]; then
    node "$script_dir/herdr-follower.mjs" --spawn >/dev/null 2>&1 || true
  fi
}

# Splits beside <target> in <tab>, labels the new pane and starts watchmen in it, in the watch
# folder of the last watch or else <cwd>.
spawn_beside() {
  local tab="$1" target="$2" cwd="$3" folder created pane
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
}

read -r verb a b c d rest <<<"$decision"
case "$verb" in
  SPAWN)
    # The cwd is the rest of the line after the two ids, spaces and all.
    cwd=""
    [ -n "$c" ] && cwd="${decision#SPAWN "$a" "$b" }"
    spawn_beside "$a" "$b" "$cwd"
    ;;
  RESPAWN)
    # The old pane is a shell claude left behind: it loses the label, so it is no longer the watch.
    safe_id "$a" || fail "unsafe id in decision"
    "$herdr_bin" pane rename "$a" --clear >/dev/null 2>&1 || true
    cwd=""
    [ -n "$d" ] && cwd="${decision#RESPAWN "$a" "$b" "$c" }"
    spawn_beside "$b" "$c" "$cwd"
    ;;
  BRING)
    pane="$a"; tab="$b"; target="$c"
    safe_id "$pane" && safe_id "$tab" && safe_id "$target" || fail "unsafe id in decision"
    set_follow on
    # --label is only valid with --new-tab or --new-workspace; the pane keeps its label when it moves.
    "$herdr_bin" pane move "$pane" --tab "$tab" --target-pane "$target" --split right --ratio "$ratio" --focus \
      | node "$script_dir/herdr-rekey.mjs" "$pane"
    ;;
  SEND)
    pane="$a"
    safe_id "$pane" || fail "unsafe id in decision"
    set_follow off
    "$herdr_bin" pane move "$pane" --new-tab --label "$label" --no-focus \
      | node "$script_dir/herdr-rekey.mjs" "$pane"
    ;;
  ERROR)
    fail "${decision#ERROR }"
    ;;
  *)
    fail "unexpected decision: $decision"
    ;;
esac
