// Decides what the toggle key does, from `herdr pane list` JSON: OPEN the board beside the focused
// pane, FOCUS a board already open in the focused tab, or CLOSE it when it is the focused pane.
// Anything unreadable degrades to OPEN. A pane id is printed only when it is safe in an argv.

export const BOARD_TITLE = '⚛ watchmen'

export function isFlagSafe(id) {
  return typeof id === 'string' && id.length > 0 && !id.startsWith('-') && /^[A-Za-z0-9_:.-]+$/.test(id)
}

function isBoard(pane) {
  if (pane.label === BOARD_TITLE || pane.title === BOARD_TITLE) return true
  const plugin = pane.plugin_id ?? pane.plugin?.id ?? pane.plugin
  const entrypoint = pane.entrypoint ?? pane.plugin_entrypoint ?? pane.plugin?.entrypoint
  return plugin === 'watchmen' && (entrypoint === undefined || entrypoint === 'board')
}

export function decide(json) {
  let panes
  try {
    panes = JSON.parse(json)?.result?.panes
  } catch {
    return 'OPEN'
  }
  if (!Array.isArray(panes)) return 'OPEN'
  const focused = panes.find(pane => pane?.focused === true)
  if (!focused) return 'OPEN'
  const board = panes.find(pane => pane && isBoard(pane) && pane.tab_id === focused.tab_id)
  if (!board || !isFlagSafe(board.pane_id)) return 'OPEN'
  return board.pane_id === focused.pane_id ? `CLOSE ${board.pane_id}` : `FOCUS ${board.pane_id}`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => (input += chunk))
  process.stdin.on('end', () => process.stdout.write(decide(input)))
}
