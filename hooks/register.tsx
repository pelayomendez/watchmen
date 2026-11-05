import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Watch } from '../types'
import {
  applyToBoard,
  approvalLines,
  attempt,
  changeReport,
  drop,
  dueChecks,
  failureOf,
  isLane,
  itemLine,
  LANE_TITLES,
  LANES,
  move,
  parseBoard,
  serialize,
  bandLayout,
  mascotState,
  paintAtom,
  sidebarTokens,
  enteredNeedsYou,
  queueWake,
  sanitize,
  wakePrompt,
  sidebarToken,
  isSafeHerdrArg,
  statusLine,
  summary,
  track,
} from './board'
import type { CheckOutcome, CheckResult, ItemPatch } from './board'

// Watchmen only wakes in the session the launcher starts (WATCHMEN=1), so the plugin can be
// installed everywhere and stay silent in every other session. The persona and the briefing are
// the launcher's (--append-system-prompt): a user-installed plugin's prompt.compose hook is
// bypassed by Claude Code's built-in security plugin, so this module keeps the board and shows it.

const HANDOFF_DIR = '.companion'
const HANDOFF_PREFIX = 'handoff-'
const BOARD_FILE = `${HANDOFF_DIR}/board.json`
const BOARD_TEMP = `${BOARD_FILE}.tmp`
const TICK_MS = 15_000
// Three ticks: the sidebar token outlives one missed refresh, not a watch that has ended.
const SIDEBAR_TTL_MS = 45_000
const HANDOFF_AT = 75
const PANE = 'board'
const PANE_TITLE = '⚛ watchmen'
const NOT_WATCH = 'Watchmen is not keeping the watch in this session.'

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
      'A host command whose output tells the item\'s state, run every everyMs (default 300000, at least 60000). argv, no shell: use ["sh","-c","..."] for pipes. A new command runs only once the human approves it with /watchmen approve <id> <hash>.',
    properties: { argv: { type: 'array', items: { type: 'string' } }, everyMs: { type: 'number' } },
    required: ['argv'],
  },
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The store key that says the human approved this command in this workspace. A check is host code
 * execution, and a board.json or a board_track call can come from anyone who can write to the repo
 * or the conversation, so no check runs until the human approves its exact argv here.
 */
// The band's board button opens the board pane: lanes and items laid out, closed with Escape. A
// press counts as the person asking, so the pane is placed at any width; should it still not be,
// the brief goes into the transcript instead. (It cannot run /watchmen: $.command.run from a
// plugin skips that plugin's own command.run hook, so nothing would answer.)
async function showBoard($: EngineInterface, items: readonly Item[]): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, closeOnEscape: true }).catch(() => undefined)
  if (!opened?.isPlaced) $.ui.log(summary(items))
}

async function commandHash($: EngineInterface, argv: readonly string[]): Promise<string> {
  return sha256(JSON.stringify([await $.session.cwd(), argv]))
}

async function approvalKey($: EngineInterface, argv: readonly string[]): Promise<string> {
  return `approved:${await commandHash($, argv)}`
}

/**
 * The short hash the human types to approve a command: it names the exact argv they were shown,
 * so a command changed after they read it no longer matches.
 */
async function shortHash($: EngineInterface, argv: readonly string[]): Promise<string> {
  return (await commandHash($, argv)).slice(0, 16)
}

async function isApproved($: EngineInterface, argv: readonly string[]): Promise<boolean> {
  return (await $.store.get(await approvalKey($, argv))) === true
}

// Saves run one after another, each writing the board as it stands when its turn comes, so a slow
// save never lands after a newer one. Each writes a temp file and renames it over board.json.
let saving: Promise<void> = Promise.resolve()

function save($: EngineInterface): Promise<void> {
  saving = saving.then(() => writeBoard($)).catch(() => undefined)
  return saving
}

async function writeBoard($: EngineInterface) {
  const watch = (await $.state.get(WATCH)).value
  // A board.json the watch could not read is never written over until the human reloads or resets.
  if (!watch || watch.boardError) return
  try {
    await $.fs.write(BOARD_TEMP, serialize(await read($, board)))
    const moved = await $.process.run(['mv', '-f', BOARD_TEMP, BOARD_FILE])
    if (moved.exitCode !== 0) throw new Error(moved.stderr.trim() || `mv exited ${moved.exitCode}`)
  } catch (error) {
    $.ui.log(`watchmen: could not save the board: ${String(error)}`)
  }
}

/** The newest board.json.<time>.bak, by its time, if there is one. */
export function newestBackupOf(names: readonly string[]): string | undefined {
  return names
    .map(name => ({ name, at: /^board\.json\.([0-9]+)\.bak$/.exec(name)?.[1] }))
    .filter((one): one is { name: string; at: string } => one.at !== undefined)
    .sort((a, b) => Number(a.at) - Number(b.at))
    .at(-1)?.name
}

async function newestBackup($: EngineInterface): Promise<string | undefined> {
  const entries = (await $.fs.exists(HANDOFF_DIR)) ? await $.fs.list(HANDOFF_DIR) : []
  return newestBackupOf(entries.filter(one => one.kind === 'file').map(one => one.name))
}

/** Loads board.json. One it cannot read is copied to a timestamped .bak and blocks every save. */
async function loadBoard($: EngineInterface): Promise<string | undefined> {
  if (!(await $.fs.exists(BOARD_FILE))) {
    await update($, board, () => [])
    return undefined
  }
  const text = await $.fs.read(BOARD_FILE)
  const parsed = parseBoard(text)
  if ('items' in parsed) {
    await update($, board, () => parsed.items)
    return undefined
  }
  // The board in memory is left as it is: empty at start, and kept when a reload fails. Each
  // unreadable copy gets a backup of its own, so a later failure never replaces an earlier backup.
  const backup = `${BOARD_FILE}.${await $.clock.now()}.bak`
  const newest = await newestBackup($)
  const isKept = newest !== undefined && (await $.fs.read(`${HANDOFF_DIR}/${newest}`)) === text
  if (!isKept && !(await $.fs.exists(backup))) await $.fs.write(backup, text)
  $.ui.toast(
    `board.json could not be read (${parsed.error}). Kept as ${backup}; board.json will not be written over. Fix it and /watchmen reload, or /watchmen reset.`,
    { timeoutMs: 15_000 },
  )
  return parsed.error
}

/** Changes the board, persists it, and answers what the change says or the reason it was refused. */
async function change($: EngineInterface, fn: (items: Item[]) => Item[], ok: (items: Item[]) => string) {
  const step = attempt(fn)
  await update($, board, items => step.run(items ?? []))
  const { error, after } = step.outcome()
  if (error) return { deny: error }
  await save($)
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

/** Marks an item's check as waiting for approval of the command with this short hash, or clears it. */
async function setAwaiting($: EngineInterface, id: string, approvalHash: string | undefined) {
  await update($, board, items =>
    (items ?? []).map(one => {
      if (one.id !== id) return one
      const { isAwaitingApproval: _, approvalHash: __, ...rest } = one
      return approvalHash ? { ...rest, isAwaitingApproval: true, approvalHash } : rest
    }),
  )
}

async function runCheck($: EngineInterface, item: Item, now: number) {
  running.add(item.id)
  try {
    const argv = item.check!.argv
    if (!(await isApproved($, argv))) {
      const hash = await shortHash($, argv)
      if (!item.isAwaitingApproval || item.approvalHash !== hash) {
        await setAwaiting($, item.id, hash)
        await save($)
      }
      return
    }
    if (item.isAwaitingApproval) await setAwaiting($, item.id, undefined)
    await update($, board, items => (items ?? []).map(one => (one.id === item.id ? { ...one, checkedAt: now } : one)))
    let outcome: CheckOutcome
    try {
      outcome = await $.process.run(argv)
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) }
    }
    const failure = failureOf(outcome)
    const result: CheckResult =
      failure !== undefined || 'error' in outcome
        ? { error: failure ?? 'check failed' }
        : { output: outcome.stdout.trim(), hash: await sha256(outcome.stdout.trim()) }
    let changedTitle: string | undefined
    await update($, board, items => {
      const applied = applyToBoard(items ?? [], item, result, now)
      changedTitle = applied.changedTitle
      return applied.items
    })
    await save($)
    if (changedTitle) {
      $.ui.toast(`⚛ ${changedTitle} changed`, { timeoutMs: 8_000 })
      const title = changedTitle
      await patchWatch($, watch => ({ ...watch, wake: queueWake(watch.wake ?? { pending: [] }, [title]) }))
    }
  } finally {
    running.delete(item.id)
  }
}

/** Inside herdr, the workspace and binary the sidebar token is published through. */
async function herdrOf($: EngineInterface): Promise<{ herdr?: { bin: string; workspace: string } }> {
  const workspace = await $.env.get('HERDR_WORKSPACE_ID')
  const bin = (await $.env.get('HERDR_BIN_PATH')) || 'herdr'
  return isSafeHerdrArg(workspace, 'id') && isSafeHerdrArg(bin, 'bin') ? { herdr: { bin, workspace } } : {}
}

/**
 * Shows the watch in herdr's always-visible spaces sidebar as the workspace token `$watchmen`.
 * Every tick refreshes it with a time to live, so it disappears soon after the watch stops.
 */
async function publishSidebar($: EngineInterface, herdr: { bin: string; workspace: string }, items: readonly Item[]) {
  // `$watchmen` plain, and the three state tokens herdr's config styles one colour each: only the
  // current state's carries text, the others are cleared.
  const tokens = Object.entries(sidebarTokens(items)).flatMap(([name, text]) =>
    text ? ['--token', `${name}=${text}`] : ['--clear-token', name],
  )
  const argv = [
    herdr.bin, 'workspace', 'report-metadata', '--source', 'watchmen',
    '--token', `watchmen=${sidebarToken(items)}`, ...tokens, '--ttl-ms', String(SIDEBAR_TTL_MS), herdr.workspace,
  ]
  await $.process.run(argv).catch(() => undefined)
}

// The atom template, read once from the plugin's assets and painted per state.
let atomTemplate: string | undefined

async function atomSvg($: EngineInterface, state: ReturnType<typeof mascotState>): Promise<string | undefined> {
  try {
    atomTemplate ??= await $.fs.read(`${$.plugin.root}/assets/atom.svg`)
    return paintAtom(atomTemplate, state)
  } catch {
    return undefined
  }
}

/**
 * Changes the watch with a versioned read-modify-write, so a write from a concurrent hook (a check
 * queueing a wake while a tick writes `warned`) is never lost to a stale copy.
 */
async function patchWatch($: EngineInterface, fn: (watch: Watch) => Watch) {
  await update($, WATCH, watch => (watch ? fn(watch) : (watch as unknown as Watch)))
}

// Whether the main loop is in a turn: a wake waits for it to end. A reload starts it false, and
// the engine queues a submitted prompt until the session is idle anyway.
let isTurnRunning = false

// A wake under way: the next tick does not start another while submit has not settled.
let isWaking = false

/**
 * Wakes the watch to triage what changed, at most every three minutes and never over the person.
 * The queue is cleared only once the prompt went in, and only of what that prompt covered, so a
 * failed submit or a change queued meanwhile still wakes the watch later.
 */
async function maybeWake($: EngineInterface, now: number) {
  if (isWaking) return
  const watch = (await $.state.get(WATCH)).value
  if (!watch?.wake || watch.wake.pending.length === 0) return
  const draft = (await $.prompt.read()).text
  const decision = wakePrompt(watch.wake, { now, isTurnRunning, draft })
  if (!('text' in decision)) return
  const covered = new Set(watch.wake.pending)
  isWaking = true
  try {
    await $.prompt.submit({ text: decision.text })
    await patchWatch($, held => ({
      ...held,
      wake: { pending: (held.wake?.pending ?? []).filter(title => !covered.has(title)), lastWakeAt: now },
    }))
  } catch (error) {
    $.ui.log(`watchmen: wake failed: ${String(error)}`)
  } finally {
    isWaking = false
  }
}

/**
 * Pings the person about items that just moved into needs-you: a native notification and, inside
 * herdr, a herdr notification, so it reaches them from any tab. Quiet changes never ping.
 */
async function pingNeedsYou($: EngineInterface, items: readonly Item[]) {
  if (items.length === 0) return
  const watch = (await $.state.get(WATCH)).value
  const text = items.map(one => sanitize(one.note ? `${one.title}: ${one.note}` : one.title)).join(' · ')
  void $.ui.notify(text, { title: '⚛ watchmen' }).catch(() => undefined)
  if (watch?.herdr) {
    // --body=<text> in one argument: a body that starts with "--" is not read as a flag.
    const argv = [watch.herdr.bin, 'notification', 'show', '⚛ watchmen', `--body=${text}`, '--sound', 'request']
    void $.process.run(argv).catch(() => undefined)
  }
}

async function tick($: EngineInterface) {
  const watch = (await $.state.get(WATCH)).value
  if (!watch) return
  const now = await $.clock.now()
  const items = await read($, board)
  for (const item of dueChecks(items, now, running)) {
    void runCheck($, item, now).catch(error => $.ui.log(`watchmen: check ${item.id} failed: ${String(error)}`))
  }
  if (watch.herdr) void publishSidebar($, watch.herdr, items)
  await maybeWake($, now)
  const { context } = await $.session.usage()
  const percent = context.percent ?? 0
  $.ui.status(statusLine(items, context.percent, now - watch.startedAt, HANDOFF_AT))
  // Warn once per long window: re-arm when the window drops back, as after /clear or compaction.
  if (!watch.warned && percent >= HANDOFF_AT) {
    $.ui.toast('The watch is long. Write the handoff before the window fills.', { timeoutMs: 10_000 })
    await patchWatch($, held => ({ ...held, warned: true }))
  } else if (watch.warned && percent < HANDOFF_AT) {
    await patchWatch($, held => ({ ...held, warned: false }))
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
      const boardError = await loadBoard($)
      watch = {
        handoff: latest && `${HANDOFF_DIR}/${latest}`,
        skill: (await $.env.get('WATCHMEN_SKILL')) || undefined,
        ...(await herdrOf($)),
        startedAt: await $.clock.now(),
        warned: false,
        ...(boardError ? { boardError } : {}),
      } satisfies Watch
      await $.state.set(WATCH, watch)
    }
    await $.env.set('WATCHMEN', undefined)
    await $.env.set('WATCHMEN_SKILL', undefined)

    await $.command.register({
      name: 'watchmen',
      description: 'The watch: open the board, or track <title> | brief | approve <id> <hash> | reload | reset',
      argumentHint: '[track <title> | brief | approve <id> <hash> | reload | reset]',
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

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = true
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = false
    return next(e)
  })

  on('tool.call', { tool: 'mcp__watchmen__board_track' }, async ($, e) => {
    if (!(await isWatch($))) return { deny: NOT_WATCH }
    const patch = patchFrom(e as Record<string, unknown>)
    const before = await read($, board)
    const answer = await change($, items => track(items, patch), items => `Tracked. ${items.length} items on the board.`)
    if ('result' in answer) await pingNeedsYou($, enteredNeedsYou(before, await read($, board)))
    return answer
  })

  on('tool.call', { tool: 'mcp__watchmen__board_move' }, async ($, e) => {
    if (!(await isWatch($))) return { deny: NOT_WATCH }
    const input = e as Record<string, unknown>
    if (input.lane !== undefined && !isLane(input.lane)) return { deny: `Unknown lane: ${String(input.lane)}` }
    const lane = isLane(input.lane) ? input.lane : undefined
    const note = typeof input.note === 'string' ? input.note : undefined
    const before = await read($, board)
    const answer = await change($, items => move(items, String(input.id), lane, note), () => 'Moved.')
    if ('result' in answer) await pingNeedsYou($, enteredNeedsYou(before, await read($, board)))
    return answer
  })

  on('tool.call', { tool: 'mcp__watchmen__board_drop' }, async ($, e) => {
    if (!(await isWatch($))) return { deny: NOT_WATCH }
    const id = String((e as Record<string, unknown>).id)
    return change($, items => drop(items, id), items => `Dropped. ${items.length} items left.`)
  })

  on('tool.call', { tool: 'mcp__watchmen__board_changes' }, async $ => {
    if (!(await isWatch($))) return { deny: NOT_WATCH }
    return { result: changeReport(await read($, board)) }
  })

  on('command.run', { command: 'watchmen' }, async ($, e) => {
    const watch = (await $.state.get(WATCH)).value
    if (!watch) return { text: NOT_WATCH }
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'track') {
      const title = rest.join(' ')
      if (!title) return { text: 'Usage: /watchmen track <title>' }
      const answer = await change($, items => track(items, { title, kind: 'todo' }, 'needs-you'), () => `Tracked: ${title}`)
      return { text: 'deny' in answer ? answer.deny : answer.result }
    }
    if (verb === 'approve') {
      // Only the human's own typing approves a command: the model, a loop or a plugin running
      // /watchmen approve is refused, so a planted or injected check cannot approve itself.
      if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') {
        return { text: 'Only you can approve a check: type /watchmen approve <id> <hash> yourself.' }
      }
      const item = (await read($, board)).find(one => one.id === rest[0])
      if (!item?.check) return { text: `No item "${rest[0] ?? ''}" with a check on the board.` }
      // The hash names the command the human was shown; a command changed since then is refused.
      const hash = await shortHash($, item.check.argv)
      if (rest[1] !== hash) {
        return {
          text: `Not approved: the hash does not match. ${item.id} would run ${JSON.stringify(item.check.argv)}; to approve exactly that, type /watchmen approve ${item.id} ${hash}`,
        }
      }
      await $.store.set(await approvalKey($, item.check.argv), true)
      await setAwaiting($, item.id, undefined)
      await save($)
      return { text: `Approved for this workspace: ${JSON.stringify(item.check.argv)}` }
    }
    if (verb === 'reload' || verb === 'reset') {
      const boardError = verb === 'reload' ? await loadBoard($) : undefined
      const { boardError: _, ...rest } = watch
      await $.state.set(WATCH, boardError ? { ...rest, boardError } : rest)
      if (boardError) return { text: `board.json still cannot be read: ${boardError}` }
      if (verb === 'reset') await save($)
      return { text: verb === 'reload' ? 'Board reloaded.' : 'Board reset: board.json will be written from the board as it is now.' }
    }
    const items = await read($, board)
    if (verb === 'brief') return { text: summary(items) }
    await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)
    const { context } = await $.session.usage()
    const lines = [
      ...(watch.boardError ? [`⚠ board.json could not be read (${watch.boardError}); not saving until /watchmen reload or reset.`, ''] : []),
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
  // The band: one slim row above the prompt in the watch session, the mascot and the lane counts,
  // with board and hide. It also opens the board pane by itself where it docks beside the transcript
  // (the fullscreen layout); on the main screen the pane waits for /watchmen.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const watch = (await $.state.get(WATCH)).value
    if (!watch) return next(e)
    if (!isPaneOffered && e.viewport?.isFullscreen === true) {
      isPaneOffered = true
      void $.ui.open({ id: PANE, title: PANE_TITLE })
    }
    if (watch.isBandHidden || e.props.hasSurvey) return next(e)
    const items = await read($, board)
    const { parts, hasButtons } = bandLayout(items, e.props.bodyColumns)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const state = mascotState(items)
    // Remote surfaces draw the SVG atom; a terminal has no Svg, so there the mascot is the glyph.
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const atom = Svg ? await atomSvg($, state) : undefined
    return (
      <Box flexDirection="row">
        {parts.map((part, at) =>
          at === 0 && Svg && atom ? (
            <Svg key="mascot" source={atom} alt="⚛" width={16} height={16} />
          ) : (
            <Text key={`part-${at}`} color={part.color} bold={part.bold} dimColor={part.dim}>
              {at === 0 ? part.text : ` ${at === 1 ? '' : '· '}${part.text}`}
            </Text>
          ),
        )}
        {hasButtons && (
          <Box key="actions" flexDirection="row">
            <Text>  </Text>
            <Button key="board" label="board" onPress={() => void showBoard($, items)} />
            <Text> </Text>
            <Button key="hide" label="hide" onPress={() => patchWatch($, held => ({ ...held, isBandHidden: true }))} />
          </Box>
        )}
      </Box>
    )
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
              {inLane.flatMap(one => [
                <Text key={one.id} bold={one.isChanged} dimColor={lane === 'done'}>
                  {fit(`  ${itemLine(one)}`)}
                </Text>,
                ...approvalLines(one).map((text, at) => (
                  <Text key={`${one.id}-approval-${at}`} color="yellow">
                    {fit(`    ${text}`)}
                  </Text>
                )),
              ])}
            </Box>
          )
        })}
      </Box>
    )
  })
}
