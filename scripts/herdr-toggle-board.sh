#!/usr/bin/env bash
# The toggle-board action: open the watch board in a split beside the focused pane, focus it when
# it is open but not focused, close it when it is. herdr injects HERDR_BIN_PATH into an action.
set -uo pipefail

herdr_bin="${HERDR_BIN_PATH:-herdr}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

decision="OPEN"
panes="$("$herdr_bin" pane list 2>/dev/null || true)"
if [ -n "$panes" ]; then
  decision="$(printf '%s' "$panes" | node "$script_dir/herdr-board-decision.mjs" 2>/dev/null || echo OPEN)"
fi

# The decision script prints only ids that pass its argv guard; check again before using one.
pane_id() {
  case "$1" in
    -*|*[!A-Za-z0-9_:.-]*|'') return 1 ;;
  esac
  printf '%s' "$1"
}

case "$decision" in
  "FOCUS "*)
    pid="$(pane_id "${decision#FOCUS }")" || decision="OPEN"
    if [ "$decision" != "OPEN" ]; then
      # herdr has no focus-by-id: zoom on focuses the pane, zoom off restores the layout.
      "$herdr_bin" pane zoom "$pid" --on >/dev/null 2>&1 || true
      exec "$herdr_bin" pane zoom "$pid" --off
    fi
    ;;
  "CLOSE "*)
    pid="$(pane_id "${decision#CLOSE }")" || decision="OPEN"
    [ "$decision" != "OPEN" ] && exec "$herdr_bin" pane close "$pid"
    ;;
esac

exec "$herdr_bin" plugin pane open \
  --plugin watchmen \
  --entrypoint board \
  --placement split \
  --direction right \
  --focus
