import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ago, fit, readBoard, render, wantsColor } from '../bin/board-render.mjs'

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

test('finds the board: argument, then WATCHMEN_BOARD, then the cwd, then the launcher\'s pointer', async () => {
  const { resolveBoardPath } = await import('../bin/board-render.mjs')
  const dirs = new Set(['/ws/a', '/ws/b', '/tab/.companion'])
  const files = { '/state/watchmen/current': '/ws/watch\n' }
  const io = (over = {}) => ({
    arg: undefined,
    env: { XDG_STATE_HOME: '/state' },
    cwd: '/tab',
    home: '/home/me',
    isDir: path => dirs.has(path),
    exists: path => path in files,
    read: path => files[path],
    ...over,
  })
  const env = { XDG_STATE_HOME: '/state', WATCHMEN_BOARD: '/ws/b' }

  assert.deepEqual(resolveBoardPath(io({ arg: '/ws/a', env })), { file: '/ws/a/.companion/board.json', source: 'argument' })
  assert.deepEqual(resolveBoardPath(io({ arg: 'x/board.json' })), { file: '/tab/x/board.json', source: 'argument' })
  assert.deepEqual(resolveBoardPath(io({ env })), { file: '/ws/b/.companion/board.json', source: 'WATCHMEN_BOARD' })
  assert.deepEqual(resolveBoardPath(io()), { file: '/tab/.companion/board.json', source: 'cwd' })
  assert.deepEqual(resolveBoardPath(io({ cwd: '/elsewhere' })), { file: '/ws/watch/.companion/board.json', source: 'pointer' })
  assert.deepEqual(
    resolveBoardPath(io({ cwd: '/elsewhere', env: {}, home: '/home/me' })),
    { file: '/elsewhere/.companion/board.json', source: 'cwd' },
  )
})
