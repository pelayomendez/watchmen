// The watch board as text for a terminal: pure functions, no I/O, so `node --test` can hold them.
// bin/watchmen-board reads the file and the terminal and calls these.

const LANES = [
  ['needs-you', 'NEEDS YOU'],
  ['moving', 'MOVING'],
  ['waiting', 'WAITING'],
]
const KNOWN_LANES = new Set(['needs-you', 'moving', 'waiting', 'done'])

const STYLES = { bold: [1, 22], dim: [2, 22], red: [31, 39], yellow: [33, 39], cyan: [36, 39] }

/** NO_COLOR, when set to anything but the empty string, turns colour off (no-color.org). */
export function wantsColor(env) {
  return env.NO_COLOR === undefined || env.NO_COLOR === ''
}

/**
 * Reads board.json's text into what the viewer shows. A file that is not a board keeps the last
 * good board, so the screen goes on showing it under the message.
 */
export function readBoard(text, mtimeMs, previous) {
  if (text === undefined) return { kind: 'missing' }
  const lastGood = previous?.kind === 'ok' ? previous : previous?.lastGood
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    return { kind: 'corrupt', error: `not JSON: ${error.message}`, lastGood }
  }
  const items = data?.items
  if (!Array.isArray(items)) return { kind: 'corrupt', error: 'no items list', lastGood }
  const bad = items.findIndex(
    one => typeof one !== 'object' || one === null || typeof one.id !== 'string' || typeof one.title !== 'string' || !KNOWN_LANES.has(one.lane),
  )
  if (bad !== -1) return { kind: 'corrupt', error: `item ${bad + 1} has no id, title or known lane`, lastGood }
  return { kind: 'ok', items, mtimeMs }
}

/** Cuts text to `width` characters, the last one an ellipsis when anything was cut. */
export function fit(text, width) {
  const chars = Array.from(text)
  if (width <= 0) return ''
  return chars.length <= width ? text : `${chars.slice(0, width - 1).join('')}…`
}

export function ago(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function clock(ms) {
  return new Date(ms).toTimeString().slice(0, 8)
}

/**
 * The board as lines for a terminal `columns` wide. Every line is fitted before it is coloured, so
 * escape codes never count against the width.
 *
 * @param state what readBoard answered
 * @param options `columns`, `now` (ms), `color` (boolean), `workspace` (a name for the header)
 */
export function render(state, { columns, now, color, workspace }) {
  const paint = (style, text) => {
    if (!color || !style) return text
    const [on, off] = STYLES[style]
    return `\x1b[${on}m${text}\x1b[${off}m`
  }
  const lines = []
  const line = (text, style, indent = '') => lines.push(paint(style, fit(indent + text, columns)))

  const shown = state.kind === 'ok' ? state : state.lastGood
  const updated = shown ? ` · updated ${clock(shown.mtimeMs)}` : ''
  line(`⚛ watchmen · ${workspace}${updated}`, 'bold')
  lines.push('')

  if (state.kind === 'missing') {
    line('no board yet — start `watchmen` in this folder', 'dim')
    return lines
  }
  if (state.kind === 'corrupt') {
    line(`board.json cannot be read: ${state.error}`, 'red')
    line(shown ? 'showing the last good board; nothing is written' : 'nothing to show yet; nothing is written', 'dim')
    lines.push('')
    if (!shown) return lines
  }

  const items = shown.items
  for (const [lane, title] of LANES) {
    const inLane = items.filter(one => one.lane === lane)
    line(`${title} (${inLane.length})`, lane === 'needs-you' && inLane.length > 0 ? 'yellow' : 'bold')
    if (inLane.length === 0) line('—', 'dim', '  ')
    for (const one of inLane) {
      const mark = one.isChanged ? '◆' : '•'
      const kind = one.kind ? `[${one.kind}] ` : ''
      const note = one.note ? ` — ${one.note}` : ''
      const when = typeof one.changedAt === 'number' ? ` · ${ago(now - one.changedAt)}` : ''
      line(`${mark} ${kind}${one.title}${note}${when}`, one.isChanged ? 'bold' : undefined, '  ')
      if (one.isAwaitingApproval === true) line(`awaiting approval: /watchmen approve ${one.id}`, 'yellow', '    ')
      if (typeof one.checkError === 'string') line(`check failed: ${one.checkError}`, 'red', '    ')
      if (typeof one.link === 'string') line(one.link, 'dim', '    ')
    }
    lines.push('')
  }
  const done = items.filter(one => one.lane === 'done').length
  if (done > 0) line(`DONE (${done})`, 'dim')
  return lines
}

/**
 * Where the board is. The herdr panel opens in whatever tab is focused, so its cwd says little:
 * an explicit argument wins, then WATCHMEN_BOARD, then a .companion folder in the cwd, then the
 * folder the last `watchmen` started in, which the launcher records in the pointer file.
 *
 * @param io `arg`, `env`, `cwd`, `home`, and the lookups `isDir(path)`, `exists(path)`, `read(path)`
 * @returns `{ file, source }`, source naming the rule that chose it
 */
export function resolveBoardPath({ arg, env, cwd, home, isDir, exists, read }) {
  const join = (...parts) => parts.join('/').replace(/\/+/g, '/')
  const inFolder = folder => join(folder, '.companion', 'board.json')
  const absolute = path => (path.startsWith('/') ? path : join(cwd, path))
  if (arg) {
    const path = absolute(arg)
    return { file: isDir(path) ? inFolder(path) : path, source: 'argument' }
  }
  if (env.WATCHMEN_BOARD) {
    const path = absolute(env.WATCHMEN_BOARD)
    return { file: isDir(path) ? inFolder(path) : path, source: 'WATCHMEN_BOARD' }
  }
  if (isDir(join(cwd, '.companion'))) return { file: inFolder(cwd), source: 'cwd' }
  const pointer = join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'watchmen', 'current')
  if (exists(pointer)) {
    const folder = read(pointer).trim()
    if (folder.startsWith('/')) return { file: inFolder(folder), source: 'pointer' }
  }
  return { file: inFolder(cwd), source: 'cwd' }
}
