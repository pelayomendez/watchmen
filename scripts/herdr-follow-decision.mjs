// Decides what a tab.focused event does while the watch follows you between tabs, from the event
// and fresh `herdr pane list` / `herdr tab list` JSON.
//
//   MOVE <pane> <tab> <target>  bring the watch beside <target> in the newly focused tab
//   SKIP <reason>               nothing to do (follow off, already there, its home tab, ...)
//   STOP <reason>               the watch pane is gone: turn follow off
//   ERROR <reason>              the input cannot be trusted: do nothing
//
// Every id printed has passed isSafeId, so it can go into an argv as it is.

import { isSafeId, WATCHMEN_LABEL } from './herdr-summon-decision.mjs'

/** The focused tab and its workspace from HERDR_PLUGIN_EVENT_JSON, wherever herdr nests them. */
export function focusedTabOf(eventJson) {
  let event
  try {
    event = JSON.parse(eventJson)
  } catch {
    return undefined
  }
  for (const candidate of [event, event?.data, event?.event, event?.payload]) {
    if (typeof candidate?.tab_id === 'string') {
      return { tab_id: candidate.tab_id, workspace_id: typeof candidate.workspace_id === 'string' ? candidate.workspace_id : undefined }
    }
  }
  return undefined
}

function listOf(json, key) {
  try {
    const items = JSON.parse(json)?.result?.[key]
    return Array.isArray(items) ? items : undefined
  } catch {
    return undefined
  }
}

/**
 * @param input `isFollowing` (boolean), `eventJson`, `panesJson`, `tabsJson`
 */
export function decideFollow({ isFollowing, eventJson, panesJson, tabsJson }) {
  if (!isFollowing) return 'SKIP follow is off'
  const focus = focusedTabOf(eventJson)
  if (!focus) return 'ERROR the event names no tab'
  if (!isSafeId(focus.tab_id)) return 'ERROR the event names an unsafe tab id'
  const panes = listOf(panesJson, 'panes')
  if (!panes) return 'ERROR pane list is unreadable'

  const watch = panes.find(pane => pane?.label === WATCHMEN_LABEL)
  if (!watch) return 'STOP the watch pane is gone'
  if (!isSafeId(watch.pane_id)) return 'ERROR the watchmen pane has an unsafe id'
  if (watch.tab_id === focus.tab_id) return 'SKIP already in this tab'

  const workspace = focus.workspace_id ?? panes.find(pane => pane?.tab_id === focus.tab_id)?.workspace_id
  if (watch.workspace_id !== undefined && workspace !== undefined && watch.workspace_id !== workspace) {
    return 'SKIP another workspace'
  }

  const tabs = listOf(tabsJson, 'tabs') ?? []
  const tab = tabs.find(one => one?.tab_id === focus.tab_id)
  if (tab?.label === WATCHMEN_LABEL) return 'SKIP the watch\'s own tab'

  const inTab = panes.filter(pane => pane?.tab_id === focus.tab_id)
  const target = inTab.find(pane => pane.focused === true) ?? inTab[0]
  if (!target) return 'SKIP the tab has no pane yet'
  if (!isSafeId(target.pane_id)) return 'ERROR the focused pane has an unsafe id'
  return `MOVE ${watch.pane_id} ${focus.tab_id} ${target.pane_id}`
}
