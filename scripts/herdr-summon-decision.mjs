// Decides what the summon key does, from `herdr pane list` JSON. The watchmen session's pane is
// the one labelled "watchmen" (bin/watchmen sets the label with `herdr pane rename` when it starts
// inside herdr; herdr reports it as the pane's `label`).
//
//   SPAWN <tab> <pane> <cwd?>   none is running: split beside the focused pane and start one
//   RESPAWN <old> <tab> <pane> <cwd?>  the labelled pane outlived its watch (the pid in its record
//                               under watchmen/panes is gone): clear its label, then spawn as above
//   BRING <id> <tab> <pane>     it runs in another tab of this space: move it beside the focused pane
//   SEND <id>                   it is in the focused tab: send it to a tab of its own
//   ERROR <reason>              the input cannot be trusted: do nothing
//
// Every id printed has passed isSafeId, so it can go into an argv as it is.

export const WATCHMEN_LABEL = 'watchmen'

export function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && !id.startsWith('-') && /^[A-Za-z0-9_:.-]+$/.test(id)
}

/**
 * @param json `herdr pane list` JSON
 * @param facts `isPaneAlive(paneId)`: whether the watch in that pane still runs
 */
export function decideSummon(json, { isPaneAlive = () => true } = {}) {
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
  const cwd = typeof focused.cwd === 'string' && focused.cwd.startsWith('/') ? focused.cwd : ''
  const spawn = `${focused.tab_id} ${focused.pane_id}${cwd ? ` ${cwd}` : ''}`

  const watch = panes.filter(pane => pane?.label === WATCHMEN_LABEL)
  if (watch.length === 0) return `SPAWN ${spawn}`
  // A labelled pane whose own watch has ended holds only the shell claude left: replace it.
  const stale = watch.find(pane => isSafeId(pane.pane_id) && !isPaneAlive(pane.pane_id))
  if (stale && watch.every(pane => !isSafeId(pane.pane_id) || !isPaneAlive(pane.pane_id))) {
    return `RESPAWN ${stale.pane_id} ${spawn}`
  }
  const alive = watch.filter(pane => !isSafeId(pane.pane_id) || isPaneAlive(pane.pane_id))
  const here = alive.find(pane => pane.tab_id === focused.tab_id)
  if (here) return isSafeId(here.pane_id) ? `SEND ${here.pane_id}` : 'ERROR the watchmen pane has an unsafe id'
  // A watch keeps to its own space: it is never moved into another workspace.
  const there = alive.find(pane => pane.workspace_id === focused.workspace_id)
  if (!there) return 'ERROR the watch runs in another space; summon it from there'
  if (!isSafeId(there.pane_id)) return 'ERROR the watchmen pane has an unsafe id'
  return `BRING ${there.pane_id} ${focused.tab_id} ${focused.pane_id}`
}
