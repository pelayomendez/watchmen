import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Watch } from '../types'
import {
  applyCheck,
  changeReport,
  drop,
  dueChecks,
  isLane,
  itemLine,
  LANE_TITLES,
  LANES,
  move,
  parse,
  serialize,
  statusLine,
  summary,
  track,
} from './board'
import type { CheckOutcome, ItemPatch } from './board'

// Watchmen only wakes in the session the launcher starts (WATCHMEN=1), so the plugin can be
// installed everywhere and stay silent in every other session. The persona and the briefing are
// the launcher's (--append-system-prompt): a user-installed plugin's prompt.compose hook is
// bypassed by Claude Code's built-in security plugin, so this module keeps the board and shows it.

const HANDOFF_DIR = '.companion'
const HANDOFF_PREFIX = 'handoff-'
const BOARD_FILE = `${HANDOFF_DIR}/board.json`
const TICK_MS = 15_000
const HANDOFF_AT = 75
const PANE = 'board'
const PANE_TITLE = '⚛ watchmen'

const WATCH = { plugin: 'watchmen', key: 'watch' } as const
const board = atom({ plugin: 'watchmen', key: 'board' } as const, [])


export function newestHandoff(names: readonly string[]): string | undefined {
  return names
    .filter(name => name.startsWith(HANDOFF_PREFIX) && name.endsWith('.md'))
    .sort()
    .at(-1)
}

export { statusLine } from './board'

const ITEM_PROPERTIES = {
  id: { type: 'string', description: 'Stable id, e.g. NRV-123 or mr-42. Defaults to a slug of the title.' },
  title: { type: 'string', description: 'What the item is, in a few words.' },
  lane: { type: 'string', enum: LANES, description: 'needs-you, moving, waiting or done.' },
  kind: { type: 'string', description: 'A free label: jira, mr, session, todo, anything.' },
  note: { type: 'string', description: 'One line: where it stands and why it is in this lane.' },
  link: { type: 'string', description: 'A URL or path to open it.' },
  check: {
    type: 'object',
    description:
      'A host command whose output tells the item\'s state, run every everyMs (default 300000, at least 60000). argv, no shell: use ["sh","-c","..."] for pipes.',
    properties: { argv: { type: 'array', items: { type: 'string' } }, everyMs: { type: 'number' } },
    required: ['argv'],
  },
}

async function save($: EngineInterface, items: readonly Item[]) {
  try {
    await $.fs.write(BOARD_FILE, serialize(items))
  } catch (error) {
    $.ui.log(`watchmen: could not save the board: ${String(error)}`)
  }
}

/** Changes the board, persists it, and answers what the change says or the reason it was refused. */
async function change($: EngineInterface, fn: (items: Item[]) => Item[], ok: (items: Item[]) => string) {
  let error: string | undefined
  let after: Item[] = []
  await update($, board, items => {
    try {
      after = fn(items ?? [])
      return after
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
      return items ?? []
    }
  })
  if (error) return { deny: error }
  await save($, after)
  return { result: ok(after) }
}

function patchFrom(input: Record<string, unknown>): ItemPatch {
  const patch: ItemPatch = {}
  for (const key of ['id', 'title', 'kind', 'note', 'link'] as const) {
    if (typeof input[key] === 'string') patch[key] = input[key] as string
  }
  if (isLane(input.lane)) patch.lane = input.lane
  const check = input.check as { argv?: unknown; everyMs?: unknown } | undefined
  if (check && Array.isArray(check.argv) && check.argv.length > 0 && check.argv.every(one => typeof one === 'string')) {
    patch.check = { argv: check.argv as string[], ...(typeof check.everyMs === 'number' ? { everyMs: check.everyMs } : {}) }
  }
  return patch
}

// Checks under way, by item id: a slow check is never started twice. A reload starts it empty,
// and the item's checkedAt still holds the next one back until its interval has passed.
const running = new Set<string>()
let isPaneOffered = false

async function isWatch($: EngineInterface) {
  return (await $.state.get(WATCH)).value !== undefined
}

async function runCheck($: EngineInterface, item: Item, now: number) {
  running.add(item.id)
  await update($, board, items => (items ?? []).map(one => (one.id === item.id ? { ...one, checkedAt: now } : one)))
  let outcome: CheckOutcome
  try {
    outcome = await $.process.run(item.check!.argv)
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : String(error) }
  }
  let changedTitle: string | undefined
  let after: Item[] = []
  await update($, board, items => {
    after = (items ?? []).map(one => {
      if (one.id !== item.id) return one
      const applied = applyCheck(one, outcome, now)
      if (applied.isChanged) changedTitle = one.title
      return applied.item
    })
    return after
  })
  running.delete(item.id)
  await save($, after)
  if (changedTitle) $.ui.toast(`⚛ ${changedTitle} changed`, { timeoutMs: 8_000 })
}

async function tick($: EngineInterface) {
  const watch = (await $.state.get(WATCH)).value
  if (!watch) return
  const now = await $.clock.now()
  const items = await read($, board)
  for (const item of dueChecks(items, now, running)) {
    void runCheck($, item, now).catch(() => running.delete(item.id))
  }
  const { context } = await $.session.usage()
  const percent = context.percent ?? 0
  $.ui.status(statusLine(items, context.percent, now - watch.startedAt, HANDOFF_AT))
  // Warn once per long window: re-arm when the window drops back, as after /clear or compaction.
  if (!watch.warned && percent >= HANDOFF_AT) {
    $.ui.toast('The watch is long. Write the handoff before the window fills.', { timeoutMs: 10_000 })
    await $.state.set(WATCH, { ...watch, warned: true })
  } else if (watch.warned && percent < HANDOFF_AT) {
    await $.state.set(WATCH, { ...watch, warned: false })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // The flag is read once and kept in the session's state, then cleared from the environment so
    // a claude started from this session's shell is not taken for the watch. A hot reload runs
    // session.start again and finds the watch, and the board, in state.
    let watch = (await $.state.get(WATCH)).value
    if (!watch) {
      if ((await $.env.get('WATCHMEN')) !== '1') return result
      const entries = (await $.fs.exists(HANDOFF_DIR)) ? await $.fs.list(HANDOFF_DIR) : []
      const latest = newestHandoff(entries.filter(one => one.kind === 'file').map(one => one.name))
      watch = {
        handoff: latest && `${HANDOFF_DIR}/${latest}`,
        skill: (await $.env.get('WATCHMEN_SKILL')) || undefined,
        startedAt: await $.clock.now(),
        warned: false,
      } satisfies Watch
      const saved = (await $.fs.exists(BOARD_FILE)) ? parse(await $.fs.read(BOARD_FILE)) : []
      await update($, board, () => saved)
      await $.state.set(WATCH, watch)
    }
    await $.env.set('WATCHMEN', undefined)
    await $.env.set('WATCHMEN_SKILL', undefined)

    await $.command.register({
      name: 'watchmen',
      description: 'The watch: open the board, or track <title> | brief',
      argumentHint: '[track <title> | brief]',
    })
    await $.tool.register({
      name: 'board_track',
      description:
        'Add an item to the watch board, or update the one with the same id. Items are anything worth keeping an eye on (a ticket, an MR, another session, a todo); give one a check command and the watch re-runs it and flags the item when its output changes.',
      inputSchema: { type: 'object', properties: ITEM_PROPERTIES },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_move',
      description: 'Move a board item to another lane and/or set its one-line note. Clears its changed flag: use it to triage.',
      inputSchema: {
        type: 'object',
        properties: { id: ITEM_PROPERTIES.id, lane: ITEM_PROPERTIES.lane, note: ITEM_PROPERTIES.note },
        required: ['id'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_drop',
      description: 'Remove an item from the watch board.',
      inputSchema: { type: 'object', properties: { id: ITEM_PROPERTIES.id }, required: ['id'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'board_changes',
      description:
        'List the board items whose check output changed since the last triage, with what the check says now. Triage each with board_move.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })

    await tick($)
    $.clock.every(TICK_MS, () => void tick($))

    return result
  })

  on('tool.call', { tool: 'mcp__watchmen__board_track' }, async ($, e) => {
    if (!(await isWatch($))) return { deny: 'Watchmen is not keeping the watch in this session.' }
    const patch = patchFrom(e as Record<string, unknown>)
    return change($, items => track(items, patch), items => `Tracked. ${items.length} items on the board.`)
  })

  on('tool.call', { tool: 'mcp__watchmen__board_move' }, async ($, e) => {
    if (!(await isWatch($))) return { deny: 'Watchmen is not keeping the watch in this session.' }
    const input = e as Record<string, unknown>
    if (input.lane !== undefined && !isLane(input.lane)) return { deny: `Unknown lane: ${String(input.lane)}` }
    const lane = isLane(input.lane) ? input.lane : undefined
    const note = typeof input.note === 'string' ? input.note : undefined
    return change($, items => move(items, String(input.id), lane, note), () => 'Moved.')
  })

  on('tool.call', { tool: 'mcp__watchmen__board_drop' }, async ($, e) => {
    if (!(await isWatch($))) return { deny: 'Watchmen is not keeping the watch in this session.' }
    const id = String((e as Record<string, unknown>).id)
    return change($, items => drop(items, id), items => `Dropped. ${items.length} items left.`)
  })

  on('tool.call', { tool: 'mcp__watchmen__board_changes' }, async $ => {
    if (!(await isWatch($))) return { deny: 'Watchmen is not keeping the watch in this session.' }
    return { result: changeReport(await read($, board)) }
  })

  on('command.run', { command: 'watchmen' }, async ($, e) => {
    const watch = (await $.state.get(WATCH)).value
    if (!watch) return { text: 'Watchmen is not keeping the watch in this session.' }
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'track') {
      const title = rest.join(' ')
      if (!title) return { text: 'Usage: /watchmen track <title>' }
      const answer = await change($, items => track(items, { title, kind: 'todo' }, 'needs-you'), () => `Tracked: ${title}`)
      return { text: 'deny' in answer ? answer.deny : answer.result }
    }
    const items = await read($, board)
    if (verb === 'brief') return { text: summary(items) }
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    const { context } = await $.session.usage()
    const lines = [
      summary(items),
      '',
      `handoff: ${watch.handoff ?? 'none yet'}`,
      `skill:   ${watch.skill ?? 'not found'}`,
      `context: ${context.percent ?? '?'}% of ${context.window} tokens`,
    ]
    return { text: lines.join('\n') }
  })

  // The board opens by itself only where it docks beside the transcript (the fullscreen layout);
  // on the main screen it would push the conversation around, so there it waits for /watchmen.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isPaneOffered && e.viewport?.isFullscreen === true && (await isWatch($))) {
      isPaneOffered = true
      void $.ui.open({ id: PANE, title: PANE_TITLE })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const items = await read($, board)
    const width = Math.max(10, e.props.bodyColumns)
    const fit = (text: string) => (text.length > width ? `${text.slice(0, width - 1)}…` : text)
    if (items.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>The board is empty.</Text>
          <Text dimColor>{fit('Ask the watch to track something, or /watchmen track <title>.')}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {LANES.filter(lane => lane !== 'done' || items.some(one => one.lane === 'done')).map(lane => {
          const inLane = items.filter(one => one.lane === lane)
          return (
            <Box key={lane} flexDirection="column" marginBottom={1}>
              <Text bold color={lane === 'needs-you' && inLane.length > 0 ? 'yellow' : undefined}>
                {`${LANE_TITLES[lane]} (${inLane.length})`}
              </Text>
              {inLane.length === 0 && <Text dimColor>  —</Text>}
              {inLane.map(one => (
                <Text key={one.id} bold={one.isChanged} dimColor={lane === 'done'}>
                  {fit(`  ${itemLine(one)}`)}
                </Text>
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
