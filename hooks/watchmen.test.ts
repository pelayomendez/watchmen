import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { Item } from '../types'
import { applyCheck, dueChecks, move, parse, serialize, statusLine, summary, track } from './board'
import { newestHandoff } from './register'

const MIN = 60_000

test('picks the newest dated handoff and ignores other files', () => {
  expect(newestHandoff(['notes.md', 'handoff-2026-10-14.md', 'handoff-2026-10-15.md', 'handoff-x.txt'])).toBe(
    'handoff-2026-10-15.md',
  )
  expect(newestHandoff(['memory.md'])).toBeUndefined()
})

test('a check: first output is the baseline, a different one marks the item changed, a failure only notes it', () => {
  const item: Item = { id: 'mr-42', title: 'MR 42', lane: 'moving', check: { argv: ['glab'] } }
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })

  const first = applyCheck(item, ok('opened\n'), 1)
  expect(first.isChanged).toBe(false)
  expect(first.item.last).toBe('opened')

  expect(applyCheck(first.item, ok('opened'), 2).isChanged).toBe(false)

  const failed = applyCheck(first.item, { exitCode: 1, stdout: '', stderr: 'no auth\nmore' }, 3)
  expect(failed.isChanged).toBe(false)
  expect(failed.item.last).toBe('opened')
  expect(failed.item.note).toBe('check failed: no auth')

  const merged = applyCheck(failed.item, ok('merged'), 4)
  expect(merged.isChanged).toBe(true)
  expect(merged.item).toMatchObject({ last: 'merged', changedAt: 4, isChanged: true })
  expect(merged.item.note).toBeUndefined()

  expect(applyCheck(item, { error: 'ENOENT' }, 5).item.note).toBe('check failed: ENOENT')
})

test('checks are due by their own interval, at least a minute, never twice at once, never when done', () => {
  const items: Item[] = [
    { id: 'a', title: 'A', lane: 'moving', check: { argv: ['x'] } },
    { id: 'b', title: 'B', lane: 'moving', check: { argv: ['x'], everyMs: 1_000 }, checkedAt: 0 },
    { id: 'c', title: 'C', lane: 'waiting', check: { argv: ['x'], everyMs: 10 * MIN }, checkedAt: 0 },
    { id: 'd', title: 'D', lane: 'done', check: { argv: ['x'] } },
    { id: 'e', title: 'E', lane: 'needs-you' },
  ]
  const ids = (now: number, running: string[] = []) => dueChecks(items, now, new Set(running)).map(one => one.id)
  expect(ids(30_000)).toEqual(['a'])
  expect(ids(MIN)).toEqual(['a', 'b'])
  expect(ids(MIN, ['a', 'b'])).toEqual([])
  expect(ids(10 * MIN)).toEqual(['a', 'b', 'c'])
})

test('items are flexible: any kind, merged by id, and a new check starts from a fresh baseline', () => {
  let items = track([], { title: 'Review deck v3', kind: 'todo' }, 'needs-you')
  expect(items[0]).toMatchObject({ id: 'review-deck-v3', lane: 'needs-you', kind: 'todo' })
  items = track(items, { id: 'NRV-1', title: 'Frames', kind: 'jira', check: { argv: ['acli'] } })
  items = items.map(one => (one.id === 'NRV-1' ? { ...one, last: 'In Progress', isChanged: true } : one))
  items = track(items, { id: 'NRV-1', note: 'waiting on backend' })
  expect(items[1]).toMatchObject({ title: 'Frames', note: 'waiting on backend', last: 'In Progress' })
  items = track(items, { id: 'NRV-1', check: { argv: ['acli', '--json'] } })
  expect(items[1]?.last).toBeUndefined()
  expect(() => track(items, { id: 'nope' })).toThrow()
  expect(move(items, 'NRV-1', 'waiting', 'blocked')[1]).toMatchObject({ lane: 'waiting', note: 'blocked', isChanged: false })
})

test('the brief groups items by lane and leaves empty lanes out', () => {
  const items: Item[] = [
    { id: 'w', title: 'Backend fields', lane: 'waiting' },
    { id: 'n', title: '!412 review comments', lane: 'needs-you', kind: 'mr', isChanged: true },
    { id: 'm', title: 'Slice 2/4', lane: 'moving', note: 'worker running' },
  ]
  expect(summary(items)).toBe(
    [
      'Needs you (1)',
      '  ◆ [mr] !412 review comments  {n}',
      '',
      'Moving (1)',
      '  • Slice 2/4 — worker running  {m}',
      '',
      'Waiting (1)',
      '  • Backend fields  {w}',
    ].join('\n'),
  )
  expect(summary([])).toContain('empty')
})

test('the status line counts what needs you, what moves and what changed, and asks for the handoff late', () => {
  const items: Item[] = [
    { id: 'a', title: 'A', lane: 'needs-you' },
    { id: 'b', title: 'B', lane: 'needs-you', isChanged: true },
    { id: 'c', title: 'C', lane: 'moving' },
    { id: 'd', title: 'D', lane: 'waiting' },
  ]
  expect(statusLine(items, 42, 3 * 3_600_000 + 7 * MIN, 75)).toBe('⚛ watchmen · 2 need you · 1 moving · 1 changed · 42% · 3h07')
  expect(statusLine([], 80, 0, 75)).toBe('⚛ watchmen · 80% · write the handoff')
  expect(statusLine([], undefined, MIN, 75)).toBe('⚛ watchmen · 0h01')
})

test('the board survives a round trip to board.json, and a broken file gives an empty board', () => {
  const items: Item[] = [
    { id: 'NRV-1', title: 'Frames', lane: 'waiting', kind: 'jira', check: { argv: ['sh', '-c', 'x | y'], everyMs: 120_000 }, last: 'To Do' },
  ]
  expect(parse(serialize(items))).toEqual(items)
  expect(parse('not json')).toEqual([])
  expect(parse('{"items":[{"id":"x","title":"X","lane":"sideways"}]}')).toEqual([])
})

// The engine hands an fs hook the path resolved against the working directory.
const relative = (path: string) => path.slice(path.indexOf('.companion'))

function engine(on: On, files: Record<string, string>, percent: number) {
  const clock = mock.clock(on, { now: 0 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.exists', ($, e) => ({ value: relative(e.path) === '.companion' || relative(e.path) in files }))
  on('fs.list', () => ({
    value: Object.keys(files).map(path => ({ name: path.replace('.companion/', ''), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', ($, e) => ({ value: files[relative(e.path)] ?? '' }))
  const writes: Record<string, string> = {}
  on('fs.write', ($, e) => ((writes[relative(e.path)] = e.text), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent }, rateLimits: [] } }))
  on('command.register', () => ({ value: undefined }) as never)
  const tools: string[] = []
  on('tool.register', ($, e) => (tools.push(e.name), { value: { tool: `mcp__watchmen__${e.name}` } }))
  const cleared: string[] = []
  on('env.set', ($, e) => (cleared.push(e.name), { value: undefined }))
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  on('ui.status', ($, e) => (status.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  const runs: string[][] = []
  let output = 'In Progress'
  on('process.run', ($, e) => (runs.push([...e.argv]), { value: { exitCode: 0, stdout: output, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  return { clock, status, toasts, cleared, tools, writes, runs, setOutput: (text: string) => (output = text) }
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const

test('stays silent when the session was not launched as watchmen', async ($, on) => {
  mock.env(on, {})
  const seen = engine(on, { '.companion/board.json': serialize([{ id: 'a', title: 'A', lane: 'moving', check: { argv: ['x'] } }]) }, 10)
  await $.session.start(START)
  await seen.clock.advance(10 * MIN)
  expect(seen.status).toEqual([])
  expect(seen.tools).toEqual([])
  expect(seen.runs).toEqual([])
})

test('as watchmen: loads the board, runs its checks on their interval, and flags a change', async ($, on) => {
  mock.env(on, { WATCHMEN: '1', WATCHMEN_SKILL: '/skills/ambient-companion/SKILL.md' })
  const saved: Item[] = [
    { id: 'NRV-1', title: 'Frames', lane: 'moving', kind: 'jira', check: { argv: ['acli', 'jira'] } },
    { id: 'deck', title: 'Deck review', lane: 'needs-you', kind: 'todo' },
  ]
  const seen = engine(on, { '.companion/board.json': serialize(saved) }, 80)
  await $.session.start(START)
  await seen.clock.settle()

  expect(seen.tools).toEqual(['board_track', 'board_move', 'board_drop', 'board_changes'])
  expect(seen.cleared).toContain('WATCHMEN')
  expect(seen.runs).toEqual([['acli', 'jira']])
  expect(seen.status.at(-1)).toBe('⚛ watchmen · 1 need you · 1 moving · 80% · write the handoff')
  expect(seen.toasts).toEqual(['The watch is long. Write the handoff before the window fills.'])

  // Ticks every 15 s, but the check waits for its own five minutes.
  await seen.clock.advance(4 * MIN)
  expect(seen.runs).toHaveLength(1)

  seen.setOutput('In Review')
  await seen.clock.advance(MIN)
  expect(seen.runs).toHaveLength(2)
  expect(seen.toasts.at(-1)).toBe('⚛ Frames changed')
  expect(parse(seen.writes['.companion/board.json'] ?? '')[0]).toMatchObject({ last: 'In Review', isChanged: true })
})

test('the model tracks, triages and drops items through the board tools', async ($, on) => {
  mock.env(on, { WATCHMEN: '1' })
  const seen = engine(on, {}, 10)
  await $.session.start(START)
  await seen.clock.settle()

  const tracked = await $.tool.call({ tool: 'mcp__watchmen__board_track', id: 'mr-42', title: '!42 frames', kind: 'mr', lane: 'waiting' })
  expect(tracked.result).toBe('Tracked. 1 items on the board.')
  const moved = await $.tool.call({ tool: 'mcp__watchmen__board_move', id: 'mr-42', lane: 'needs-you', note: 'review comments' })
  expect(moved.result).toBe('Moved.')
  expect(parse(seen.writes['.companion/board.json'] ?? '')).toEqual([
    { id: 'mr-42', title: '!42 frames', kind: 'mr', lane: 'needs-you', note: 'review comments', isChanged: false },
  ])
  expect((await $.tool.call({ tool: 'mcp__watchmen__board_drop', id: 'nope' })).deny).toBe('No item "nope" on the board.')
  expect((await $.tool.call({ tool: 'mcp__watchmen__board_changes' })).result).toBe('Nothing has changed since the last triage.')

  await $.tool.call({ tool: 'mcp__watchmen__board_track', title: 'Review deck v3 before Friday', kind: 'todo' })
  const pane = await $.ui.mount({
    plugin: 'watchmen',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'board',
    props: { title: '⚛ watchmen', isFocused: false, bodyColumns: 24, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const text = JSON.stringify(await pane.drawn())
  expect(text).toContain('Needs you (1)')
  expect(text).toContain('Moving (1)')
  expect(text).toContain('  • [todo] Review deck …')
})
