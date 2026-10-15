// Decides what the summon key does, from `herdr pane list` JSON. The watchmen session's pane is
// the one labelled "watchmen" (bin/watchmen sets the label with `herdr pane rename` when it starts
// inside herdr; herdr reports it as the pane's `label`).
//
//   SPAWN <tab> <pane> <cwd?>   none is running: split beside the focused pane and start one
//   BRING <id> <tab> <pane>     it runs in another tab: move it beside the focused pane
//   SEND <id>                   it is in the focused tab: send it to a tab of its own
//   ERROR <reason>              the input cannot be trusted: do nothing
//
// Every id printed has passed isSafeId, so it can go into an argv as it is.

export const WATCHMEN_LABEL = 'watchmen'

export function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && !id.startsWith('-') && /^[A-Za-z0-9_:.-]+$/.test(id)
}

export function decideSummon(json) {
  let panes
  try {
    panes = JSON.parse(json)?.result?.panes
  } catch (error) {
    return `ERROR pane list is not JSON: ${error.message}`
  }
  if (!Array.isArray(panes)) return 'ERROR pane list has no panes'
  const focused = panes.find(pane => pane?.focused === true)
  if (!focused) return 'ERROR no focused pane'
  if (!isSafeId(focused.pane_id) || !isSafeId(focused.tab_id)) return 'ERROR the focused pane has an unsafe id'

  const watch = panes.filter(pane => pane?.label === WATCHMEN_LABEL)
  if (watch.length === 0) {
    const cwd = typeof focused.cwd === 'string' && focused.cwd.startsWith('/') ? focused.cwd : ''
    return `SPAWN ${focused.tab_id} ${focused.pane_id}${cwd ? ` ${cwd}` : ''}`
  }
  const here = watch.find(pane => pane.tab_id === focused.tab_id)
  if (here) return isSafeId(here.pane_id) ? `SEND ${here.pane_id}` : 'ERROR the watchmen pane has an unsafe id'
  const there = watch[0]
  if (!isSafeId(there.pane_id)) return 'ERROR the watchmen pane has an unsafe id'
  return `BRING ${there.pane_id} ${focused.tab_id} ${focused.pane_id}`
}
