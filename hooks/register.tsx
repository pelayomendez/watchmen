import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Lane, Park, Vitals, Watch } from '../types'
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
  MASCOT_COLORS,
  BLUE,
  paintAtom,
  sidebarTokens,
  enteredNeedsYou,
  queueWake,
  sanitize,
  hasHidden,
  wakePrompt,
  sidebarToken,
  isSafeHerdrArg,
  vitals,
  isRotationDue,
  ROTATE_PROMPT,
  resumePrompt,
  summary,
  glance,
  BRIEF_PROMPT,
  briefHourOf,
  isBriefDue,
  localDay,
  lanesOf,
  sinceYouLooked,
  dismissedQuestion,
  isDismissed,
  noteDismissed,
  track,
} from './board'
import type { CheckOutcome, CheckResult, Ignored, ItemPatch } from './board'
import { briefing, pickModel, skillCandidates } from './briefing'
import {
  DISCOVERY_TIMEOUT_MS,
  foundSection,
  glabHosts,
  glabLookups,
  glabReviewLookup,
  lookups as lookupsAt,
  notOnBoard,
  parseGh,
  parseGlab,
  parseJira,
  projectDirName,
  RECENT_SESSION_MS,
  recentSessions,
  usernameOf,
} from './discover'
import type { Found } from './discover'
import {
  isInside,
  PARK_GIVE_UP_MS,
  parkedItem,
  parkedReport,
  parkPrompt,
  parseFrontMatter,
  parseInboxEntry,
  parseParkArgs,
  shortId,
  stateDirOf,
} from './park'
import type { InboxEntry } from './park'

// Watchmen keeps the watch in one session: the one the launcher starts (WATCHMEN=1, the briefing
// as --append-system-prompt), or one where the person types /watchmen start (the desktop app can
// pass neither, so the briefing goes in as the first message). Every other session gets only
// /watchmen, which says how to start, so the plugin can be installed everywhere and stay quiet.
// A user-installed plugin's prompt.compose hook is bypassed by Claude Code's built-in security
// plugin, so the briefing never goes through prompt.compose.

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
const HOW_TO_START = `${NOT_WATCH} Type /watchmen start to make this session the watch.`
const COMMAND_IDLE = {
  name: 'watchmen',
  description: 'Start the watch in this session (start), or hand this session to the watch (park)',
  argumentHint: 'start | park [waiting|todo] [note]',
}
const COMMAND_WATCH = {
  name: 'watchmen',
  description: 'The watch: open the board, or track <title> | brief | band | approve <id> <hash> | reload | reset',
  argumentHint: '[track <title> | brief | band | approve <id> <hash> | approve all | reload | reset]',
}
// Who may turn a session into the watch: the person, typing (in a terminal, through the bridge, or
// in a session an SDK host such as the desktop app runs), never the model or another plugin.
const STARTERS: readonly string[] = ['composer', 'bridge', 'sdk']

const WATCH = { plugin: 'watchmen', key: 'watch' } as const
const VITALS = { plugin: 'watchmen', key: 'vitals' } as const
const PARK = { plugin: 'watchmen', key: 'park' } as const
// How fresh a watch's heartbeat must be for a parked session to say the watch has it.
const HEARTBEAT_MS = 60_000
const board = atom({ plugin: 'watchmen', key: 'board' } as const, [])
const vitalsAtom = atom({ plugin: 'watchmen', key: 'vitals' } as const, {} as Vitals)

export function newestHandoff(names: readonly string[]): string | undefined {
  return names
    .filter(name => name.startsWith(HANDOFF_PREFIX) && name.endsWith('.md'))
    .sort()
    .at(-1)
}


const ITEM_PROPERTIES = {
  id: { type: 'string', description: 'Stable id, e.g. ABC-123 or mr-42. Defaults to a slug of the title.' },
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
// The footer button and /watchmen open the board pane with the keyboard, closed with Escape. Open
// again while it is open, it only takes the keyboard back: one way in, never a toggle. A press
// counts as the person asking, so the pane is placed at any width; should it still not be, the
// brief goes into the transcript instead. (It cannot run /watchmen: $.command.run from a plugin
// skips that plugin's own command.run hook, so nothing would answer.)
async function showBoard($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true }).catch(() => undefined)
  if (!opened?.isPlaced) $.ui.log(summary(await read($, board)))
}

/** Puts `text` at the start of the prompt box, keeping what was typed after it (yatsude's fill). */
async function fill($: EngineInterface, text: string) {
  const draft = (await $.prompt.read().catch(() => ({ text: '' }))).text
  const filled = await $.prompt.fill({ text: text + draft.trimStart(), mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) $.ui.toast(`Could not fill the prompt: type ${text.trim()}`)
}

/** The pane's ↻: every check on the board runs now, its interval aside (approval still applies). */
async function checkNow($: EngineInterface) {
  const now = await $.clock.now()
  for (const item of await read($, board)) {
    if (!item.check || item.lane === 'done' || running.has(item.id)) continue
    void runCheck($, item, now).catch(error => $.ui.log(`watchmen: check ${item.id} failed: ${String(error)}`))
  }
}

/** The mascot, block style: an owl with a hydrogen atom on its forehead. Drawn when the pane has room. */
const OWL = [
  '  ▄▀▄▄▄▄▄▄▄▀▄    ',
  '  █   ·⊛·   █    ',
  '  █  ◉   ◉  █    ',
  '  ▀▄   ▾   ▄▀    ',
  '    ▀▀▙▄▟▀▀      ',
]
const ART_WIDTH = 17
const TAGLINE = ['Tell it what to watch.', 'It tells you what needs you.']
const BRIEF_ASK = 'Brief me: what needs me first, then what moved. '
const WATCH_ASK = 'Watch '
const RED = MASCOT_COLORS['needs-you']
const AMBER = MASCOT_COLORS.changed
/** Done items listed one by one up to this many; more fold into a count. */
const DONE_SHOWN = 3

// What the person dismissed unattended, by kind, kept per workspace across sessions.
async function ignoredKey($: EngineInterface): Promise<string> {
  return `ignored:${await sha256(await $.session.cwd())}`
}

async function readIgnored($: EngineInterface): Promise<Ignored> {
  const kept = (await $.store.get(await ignoredKey($))) as Partial<Ignored> | undefined
  return { counts: { ...(kept?.counts ?? {}) }, asked: [...(kept?.asked ?? [])] }
}

// Changes to what was dismissed run one after another, each reading what the last one wrote, so
// two drops at once both count.
let ignoring: Promise<unknown> = Promise.resolve()

function changeIgnored<T>($: EngineInterface, fn: (state: Ignored) => { state?: Ignored; value: T }): Promise<T> {
  const run = ignoring.then(async () => {
    const out = fn(await readIgnored($))
    if (out.state) await $.store.set(await ignoredKey($), out.state)
    return out.value
  })
  ignoring = run.catch(() => undefined)
  return run
}

/** Counts an item dropped while it sat in needs-you. */
async function countDismissed($: EngineInterface, item: Item | undefined) {
  if (!item || !isDismissed(item)) return
  await changeIgnored($, state => ({ state: noteDismissed(state, item.kind!), value: undefined }))
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

/** Every check on the board (not done) whose command is not approved yet, sorted by id. */
async function pendingChecks($: EngineInterface): Promise<{ id: string; argv: string[] }[]> {
  const pending: { id: string; argv: string[] }[] = []
  for (const item of await read($, board)) {
    if (item.check && item.lane !== 'done' && !(await isApproved($, item.check.argv))) pending.push({ id: item.id, argv: [...item.check.argv] })
  }
  return pending.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The short hash the person types to approve exactly this set of checks, in this workspace. */
async function setHash($: EngineInterface, pending: readonly { id: string; argv: readonly string[] }[]): Promise<string> {
  return (await sha256(JSON.stringify([await $.session.cwd(), pending.map(one => [one.id, one.argv])]))).slice(0, 16)
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
 * The morning brief: on the first tick of a new local day at or past the brief hour, the watch is
 * asked to speak first, once that day. It counts as a wake for the wake rate limit.
 */
async function maybeBrief($: EngineInterface, now: number) {
  if (isWaking) return
  const watch = (await $.state.get(WATCH)).value
  if (!watch) return
  const { day, hour } = localDay(now)
  const draft = (await $.prompt.read()).text
  const due = isBriefDue({
    isBriefingPending: watch.isBriefingPending,
    lastFailedAt: watch.briefFailedAt,
    day,
    hour,
    briefHour: watch.briefHour ?? 9,
    lastBriefDay: watch.lastBriefDay,
    now,
    lastWakeAt: watch.wake?.lastWakeAt,
    isTurnRunning,
    isRotating: watch.rotation !== undefined,
    draft,
  })
  if (!due) return
  isWaking = true
  try {
    await $.prompt.submit({ text: BRIEF_PROMPT })
    await patchWatch($, held => ({ ...held, lastBriefDay: day, briefFailedAt: undefined, wake: { pending: held.wake?.pending ?? [], lastWakeAt: now } }))
  } catch (error) {
    $.ui.log(`watchmen: the morning brief was not sent: ${String(error)}`)
    await patchWatch($, held => ({ ...held, briefFailedAt: now }))
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

/** The newest handoff in .companion/, as a path, or undefined. */
async function latestHandoff($: EngineInterface): Promise<string | undefined> {
  const entries = (await $.fs.exists(HANDOFF_DIR)) ? await $.fs.list(HANDOFF_DIR) : []
  const name = newestHandoff(entries.filter(one => one.kind === 'file').map(one => one.name))
  return name && /^[A-Za-z0-9._-]+$/.test(name) ? `${HANDOFF_DIR}/${name}` : undefined
}

/**
 * Rotation: an idle watch with a long conversation writes its handoff, the conversation is
 * cleared, and the watch resumes from that handoff. Three ticks carry it: ask for the handoff;
 * once that turn ended with a new handoff on disk, /clear and send the resume prompt; once the
 * resume turn ended, done. A turn that wrote no handoff, or a /clear refused, gives the
 * rotation up and the watch goes on as it was.
 */
async function maybeRotate($: EngineInterface, now: number, tokens: number | undefined) {
  const watch = (await $.state.get(WATCH)).value
  if (!watch || isWaking) return
  const rotation = watch.rotation
  if (!rotation) {
    // The first turn's context size is the fresh start a rotation is measured from.
    if (watch.baseTokens === undefined) {
      if (watch.lastTurnAt !== undefined && tokens !== undefined) await patchWatch($, held => ({ ...held, baseTokens: tokens }))
      return
    }
    const draft = (await $.prompt.read()).text
    if (!isRotationDue({ now, lastTurnAt: watch.lastTurnAt, tokens, baseTokens: watch.baseTokens, isTurnRunning, draft })) return
    const before = await latestHandoff($)
    await patchWatch($, held => ({ ...held, rotation: { phase: 'handoff', since: now, before } }))
    try {
      await $.prompt.submit({ text: ROTATE_PROMPT })
    } catch (error) {
      $.ui.log(`watchmen: rotation not started: ${String(error)}`)
      await patchWatch($, held => ({ ...held, rotation: undefined, lastTurnAt: now }))
    }
    return
  }
  if (isTurnRunning || (watch.lastTurnAt ?? 0) <= rotation.since) return
  if (rotation.phase === 'resume') {
    await patchWatch($, held => ({ ...held, rotation: undefined }))
    return
  }
  const handoff = await latestHandoff($)
  if (!handoff || handoff === rotation.before) {
    $.ui.log('watchmen: no new handoff was written, so the watch did not rotate.')
    await patchWatch($, held => ({ ...held, rotation: undefined }))
    return
  }
  // The board and the watch are kept across the /clear: restored here if the clear dropped them.
  const kept = { watch, items: await read($, board) }
  try {
    await $.command.run({ command: 'clear', args: '' })
  } catch (error) {
    $.ui.log(`watchmen: could not clear the conversation, so the watch did not rotate: ${String(error)}`)
    await patchWatch($, held => ({ ...held, rotation: undefined }))
    return
  }
  if (!(await $.state.get(WATCH)).value) {
    await $.state.set(WATCH, kept.watch)
    await update($, board, () => kept.items)
  }
  await patchWatch($, held => ({
    ...held,
    handoff,
    baseTokens: undefined,
    lastTurnAt: undefined,
    rotation: { phase: 'resume', since: now },
    wake: { pending: [], lastWakeAt: now },
  }))
  try {
    await $.prompt.submit({ text: resumePrompt(handoff) })
  } catch (error) {
    $.ui.log(`watchmen: the conversation was cleared but the resume prompt failed: ${String(error)}. Tell the watch to read ${handoff}.`)
    await patchWatch($, held => ({ ...held, rotation: undefined }))
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
  await takeInbox($, now).catch(error => $.ui.log(`watchmen: could not read the park inbox: ${String(error)}`))
  await beat($, now).catch(() => undefined)
  if (!watch.rotation) await maybeWake($, now)
  if (!watch.rotation) await maybeBrief($, now)
  const { context } = await $.session.usage()
  const percent = context.percent ?? 0
  // The watch's figures go in the band, where they can be coloured; a plugin's status line is
  // drawn in the engine's notice colour, which reads as a warning.
  const idleMs = watch.lastTurnAt === undefined || isTurnRunning ? undefined : now - watch.lastTurnAt
  const shown = (await $.state.get(VITALS)).value
  const minute = (ms?: number) => (ms === undefined ? undefined : Math.floor(ms / 60_000))
  if (shown?.percent !== context.percent || minute(shown?.idleMs) !== minute(idleMs)) {
    await update($, vitalsAtom, () => ({ percent: context.percent, idleMs }))
  }
  await maybeRotate($, now, context.tokens)
  // Warn once per long window: re-arm when the window drops back, as after /clear or compaction.
  if (!watch.warned && percent >= HANDOFF_AT) {
    $.ui.toast('The watch is long. Write the handoff before the window fills.', { timeoutMs: 10_000 })
    await patchWatch($, held => ({ ...held, warned: true }))
  } else if (watch.warned && percent < HANDOFF_AT) {
    await patchWatch($, held => ({ ...held, warned: false }))
  }
}

// The board tools, registered only in the watch.
const BOARD_TOOLS = [
  {
    name: 'board_track',
    description:
      'Add an item to the watch board, or update the one with the same id. Items are anything worth keeping an eye on (a ticket, an MR, another session, a todo); give one a check command and the watch re-runs it and flags the item when its output changes.',
    inputSchema: { type: 'object', properties: ITEM_PROPERTIES },
  },
  {
    name: 'board_move',
    description: 'Move a board item to another lane and/or set its one-line note. Clears its changed flag: use it to triage.',
    inputSchema: {
      type: 'object',
      properties: { id: ITEM_PROPERTIES.id, lane: ITEM_PROPERTIES.lane, note: ITEM_PROPERTIES.note },
      required: ['id'],
    },
  },
  {
    name: 'board_drop',
    description: 'Remove an item from the watch board.',
    inputSchema: { type: 'object', properties: { id: ITEM_PROPERTIES.id }, required: ['id'] },
  },
  {
    name: 'board_changes',
    description:
      'List the board items whose check output changed since the last triage, with what the check says now. Triage each with board_move.',
    inputSchema: { type: 'object', properties: {} },
  },
]

// Whether this environment's check timer runs: a hot reload starts a fresh environment, whose
// session.start arms it again; a /watchmen start in a session already watching does not.
let isTicking = false

/**
 * Makes this session the watch, or picks the watch up again after a hot reload: the watch and the
 * board in state (board.json loaded only the first time), the command and the board tools
 * registered, and the check timer running. The launcher's session.start and /watchmen start both
 * come here. `skill` is where the ambient-companion skill was found, if it was.
 */
async function startWatch($: EngineInterface, skill: string | undefined, isBriefingPending = false): Promise<Watch> {
  const held = (await $.state.get(WATCH)).value
  // The command and the tools go in first and the watch is written to state last, so a start that
  // fails part way leaves no watch behind: /watchmen still offers start, and a retry runs it all.
  try {
    await $.command.register(COMMAND_WATCH)
    for (const tool of BOARD_TOOLS) await $.tool.register({ ...tool, isDeferred: false })
  } catch (error) {
    if (!held) await $.command.register(COMMAND_IDLE).catch(() => undefined)
    throw error
  }
  let watch = held
  if (!watch) {
    const boardError = await loadBoard($)
    const startedAt = await $.clock.now()
    const briefHour = briefHourOf((await $.env.get('WATCHMEN_BRIEF_HOUR')) || undefined)
    const today = localDay(startedAt)
    watch = {
      handoff: await latestHandoff($),
      briefHour,
      ...(isBriefingPending ? { isBriefingPending } : {}),
      // Started past the brief hour, the watch's opening brief is today's.
      ...(today.hour >= briefHour ? { lastBriefDay: today.day } : {}),
      skill,
      ...(await herdrOf($)),
      startedAt,
      warned: false,
      ...(boardError ? { boardError } : {}),
    } satisfies Watch
    await $.state.set(WATCH, watch)
  }
  // Versions before 0.3 pinned a status line; a reload would leave it on screen, drawn as a warning.
  $.ui.status(undefined)
  if (!isTicking) {
    // The timer is armed before the first tick runs, so a first tick that fails cannot leave it off.
    isTicking = true
    $.clock.every(TICK_MS, () => void tick($).catch(error => $.ui.log(`watchmen: tick failed: ${String(error)}`)))
    void tick($).catch(error => $.ui.log(`watchmen: tick failed: ${String(error)}`))
  }
  return watch
}

/** The directories (or links to them) inside path, as paths; none when it is missing. */
async function subdirs($: EngineInterface, path: string): Promise<string[]> {
  if (!(await $.fs.exists(path))) return []
  const entries = await $.fs.list(path).catch(() => [])
  return entries.filter(one => one.kind === 'dir' || one.isLink).map(one => `${path}/${one.name}`)
}

/**
 * The ambient-companion skill, looked for where the launcher's find_skill looks: WATCHMEN_SKILL,
 * the two skill folders, then the newest copy in any pelayo-skills bucket of the plugin cache.
 */
async function findSkill($: EngineInterface): Promise<string | undefined> {
  try {
    const home = (await $.env.get('HOME')) || undefined
    for (const path of skillCandidates(home, (await $.env.get('WATCHMEN_SKILL')) || undefined)) {
      if (await $.fs.exists(path)) return path
    }
    if (!home) return undefined
    const found: { path: string; mtimeMs: number }[] = []
    for (const market of await subdirs($, `${home}/.claude/plugins/cache`)) {
      for (const version of await subdirs($, `${market}/pelayo-skills`)) {
        for (const bucket of await subdirs($, `${version}/skills`)) {
          const path = `${bucket}/ambient-companion/SKILL.md`
          if (await $.fs.exists(path)) found.push({ path, mtimeMs: (await $.fs.stat(path)).mtimeMs })
        }
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path
  } catch {
    return undefined
  }
}

/** Whether a CLI is installed, by a cheap `which`. */
async function hasCli($: EngineInterface, name: string): Promise<boolean> {
  try {
    return (await $.process.run(['which', name], { timeoutMs: 3_000 })).exitCode === 0
  } catch {
    return false
  }
}

/** One read-only lookup's output, or nothing when it failed or ran out of time. */
async function lookup($: EngineInterface, argv: readonly string[]): Promise<string> {
  try {
    const run = await $.process.run([...argv], { timeoutMs: DISCOVERY_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout : ''
  } catch {
    return ''
  }
}

/** The Claude sessions whose transcripts changed in the last three hours, here or below. */
async function recentClaudeSessions($: EngineInterface): Promise<{ count: number; folders: string[] }> {
  const none = { count: 0, folders: [] }
  try {
    const home = (await $.env.get('HOME')) || undefined
    if (!home) return none
    const cwd = await $.session.cwd()
    const root = `${home}/.claude/projects`
    if (!(await $.fs.exists(root))) return none
    const own = projectDirName(cwd)
    const dirs = (await $.fs.list(root)).filter(one => one.kind === 'dir' && (one.name === own || one.name.startsWith(`${own}-`)))
    const listed = await Promise.all(
      dirs.map(async dir => ({
        name: dir.name,
        mtimes: (await $.fs.list(`${root}/${dir.name}`).catch(() => [])).filter(one => one.kind === 'file' && one.name.endsWith('.jsonl')).map(one => one.mtimeMs),
      })),
    )
    return recentSessions(cwd, listed, (await $.clock.now()) - RECENT_SESSION_MS)
  } catch {
    return none
  }
}

/**
 * First-run discovery: the fixed, read-only lookups (discover.ts), each only where its CLI is
 * installed, failures ignored. Answers the briefing's "Found" section, or undefined.
 */
/**
 * The GitLab hosts glab is set up for, from its config.yml (only the host names: tokens are never
 * read out or shown). glab run directly uses its default host, so each host is asked by name.
 */
async function glabConfigHosts($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('HOME')) || undefined
  const own = (await $.env.get('GLAB_CONFIG_DIR')) || undefined
  const config = (await $.env.get('XDG_CONFIG_HOME')) || (home ? `${home}/.config` : undefined)
  const candidates = [
    ...(own ? [`${own}/config.yml`] : []),
    ...(home ? [`${home}/Library/Application Support/glab-cli/config.yml`] : []),
    ...(config ? [`${config}/glab-cli/config.yml`] : []),
  ]
  for (const path of candidates) {
    if (!(await $.fs.exists(path).catch(() => false))) continue
    return glabHosts(String(await $.fs.read(path).catch(() => '')))
  }
  return []
}

async function discover($: EngineInterface): Promise<string | undefined> {
  const [gh, glab, acli] = await Promise.all(['gh', 'glab', 'acli'].map(name => hasCli($, name)))
  const now = await $.clock.now()
  const searches = lookupsAt(now)
  const jobs: Promise<Found[]>[] = []
  if (gh) {
    jobs.push(lookup($, searches.ghAuthored).then(out => parseGh(out, 'author')))
    jobs.push(lookup($, searches.ghReview).then(out => parseGh(out, 'reviewer')))
  }
  if (glab) {
    const hosts = await glabConfigHosts($)
    for (const host of hosts.length > 0 ? hosts : [undefined]) {
      const on = glabLookups(host, now)
      jobs.push(lookup($, on.authored).then(out => parseGlab(out, 'author')))
      jobs.push(
        lookup($, on.user).then(async out => {
          const argv = glabReviewLookup(usernameOf(out), host, now)
          return argv ? parseGlab(await lookup($, argv), 'reviewer') : []
        }),
      )
    }
  }
  if (acli) jobs.push(lookup($, searches.jira).then(parseJira))
  const found = (await Promise.all(jobs)).flat()
  return foundSection(notOnBoard(found, await read($, board)), await recentClaudeSessions($))
}

// ---- Park: a session hands its work to the watch.

async function stateDir($: EngineInterface): Promise<string | undefined> {
  return stateDirOf((await $.env.get('XDG_STATE_HOME')) || undefined, (await $.env.get('HOME')) || undefined)
}

// This environment's park timer, so a second /watchmen park does not start another.
let isParkTicking = false

/** /watchmen park in a session that is not the watch: ask for the handoff, then wait for it. */
async function startPark($: EngineInterface, args: string): Promise<string> {
  if ((await $.state.get(PARK)).value) return 'This session is already being parked: its handoff is on the way.'
  const dir = await stateDir($)
  if (!dir) return 'Cannot park: neither XDG_STATE_HOME nor HOME is set, so there is nowhere to keep the handoff.'
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  const path = `${dir}/parked/${localDay(now).day}-${shortId(sessionId)}.md`
  const before = (await $.fs.exists(path)) ? String(await $.fs.read(path).catch(() => '')) : undefined
  const { lane, note } = parseParkArgs(args)
  const park: Park = { path, sessionId, since: now, ...(before !== undefined ? { before } : {}), ...(lane ? { lane } : {}), ...(note ? { note } : {}) }
  await $.state.set(PARK, park)
  // A command.run hook cannot submit a prompt: a timer sends it once the command has answered.
  $.clock.after(0, () => {
    void $.prompt.submit({ text: parkPrompt(path, lane, note), asUser: true }).catch(error => $.ui.log(`watchmen: the park request was not sent: ${String(error)}`))
  })
  if (!isParkTicking) {
    isParkTicking = true
    $.clock.every(TICK_MS, () => void checkPark($).catch(error => $.ui.log(`watchmen: park failed: ${String(error)}`)))
  }
  return `Parking: this session writes its handoff to ${path}, then it goes to the watch.`
}

/** Whether a watch whose workspace holds `cwd` has beaten recently. */
async function isWatched($: EngineInterface, dir: string, cwd: string, now: number): Promise<boolean> {
  const beats = await $.fs.list(`${dir}/heartbeat`).catch(() => [])
  for (const one of beats) {
    if (one.kind !== 'file' || !one.name.endsWith('.json')) continue
    try {
      const beat = JSON.parse(String(await $.fs.read(`${dir}/heartbeat/${one.name}`))) as { cwd?: unknown; at?: unknown }
      if (typeof beat.cwd === 'string' && typeof beat.at === 'number' && now - beat.at < HEARTBEAT_MS && isInside(cwd, beat.cwd)) return true
    } catch {
      // A heartbeat that does not read is no watch.
    }
  }
  return false
}

/**
 * Once the parked session's turn has ended with its handoff written, the inbox entry goes in and
 * the person is told they can close the session. Gives up after PARK_GIVE_UP_MS.
 */
// A completion under way: the turn's end and the timer never complete one park twice.
let isCompletingPark = false

async function checkPark($: EngineInterface) {
  if (isCompletingPark) return
  isCompletingPark = true
  try {
    await completePark($)
  } finally {
    isCompletingPark = false
  }
}

async function completePark($: EngineInterface) {
  const park = (await $.state.get(PARK)).value
  if (!park || isTurnRunning) return
  const now = await $.clock.now()
  const text = (await $.fs.exists(park.path)) ? String(await $.fs.read(park.path).catch(() => '')) : undefined
  if (text === undefined || text === '' || text === park.before) {
    if (now - park.since < PARK_GIVE_UP_MS) return
    await $.state.set(PARK, null)
    $.ui.log(`watchmen: no handoff appeared at ${park.path} within ten minutes, so nothing was parked. Type /watchmen park to try again.`)
    return
  }
  const dir = await stateDir($)
  if (!dir) return
  // Cleared before anything else, so this park completes once whatever happens next.
  await $.state.set(PARK, null)
  const front = parseFrontMatter(text)
  const short = shortId(park.sessionId)
  const isRead = !('error' in front)
  const lane = (isRead ? front.lane : undefined) ?? park.lane ?? (isRead && front.waitingOn ? 'waiting' : 'todo')
  const entry: InboxEntry = {
    sessionId: park.sessionId,
    cwd: await $.session.cwd(),
    handoff: park.path,
    at: now,
    title: isRead ? front.title : `Parked session ${short}`,
    lane,
    ...(isRead && front.waitingOn ? { waitingOn: front.waitingOn } : {}),
    ...(isRead && front.link ? { link: front.link } : {}),
    ...(isRead && front.check ? { check: front.check } : {}),
    ...(park.note ? { note: park.note } : {}),
  }
  // Written beside the inbox name and moved into place, so the watch never reads half an entry
  // (it lists only *.json).
  const final = `${dir}/inbox/${short}.json`
  await $.fs.write(`${final}.tmp`, `${JSON.stringify(entry, null, 2)}\n`)
  const moved = await $.process.run(['mv', '-f', `${final}.tmp`, final]).catch(error => ({ exitCode: 1, stderr: String(error) }))
  if (moved.exitCode !== 0) {
    $.ui.log(`watchmen: the park entry could not be put in the inbox (${moved.stderr.trim() || `mv exited ${moved.exitCode}`}); nothing was parked. Type /watchmen park to try again.`)
    return
  }
  const unread = isRead ? '' : ` (its front matter could not be read: ${front.error}; parked with what it had)`
  const watched = await isWatched($, dir, entry.cwd, now)
  const where = watched ? 'Parked in watchmen. You can close this session.' : 'Parked for watchmen: no watch is running here now, so it will be picked up when the watch starts. You can close this session.'
  $.ui.toast(where, { timeoutMs: 10_000 })
  $.ui.log(`${where}${unread}`)
}

/** The watch's heartbeat: parked sessions read it to say whether a watch has them. */
async function beat($: EngineInterface, now: number) {
  const dir = await stateDir($)
  if (!dir) return
  const cwd = await $.session.cwd()
  await $.fs.write(`${dir}/heartbeat/${(await sha256(cwd)).slice(0, 16)}.json`, JSON.stringify({ cwd, at: now }))
}

/**
 * The watch takes parked sessions for its workspace off the inbox: each becomes (or updates) its
 * own park-<id> item, its check awaiting approval, and wakes the watch. Entries for other
 * workspaces are left for their watch; entries that do not validate are moved aside.
 */
async function takeInbox($: EngineInterface, now: number) {
  const dir = await stateDir($)
  if (!dir) return
  const inbox = `${dir}/inbox`
  const names = (await $.fs.list(inbox).catch(() => [])).filter(one => one.kind === 'file' && /^[A-Za-z0-9._-]+\.json$/.test(one.name)).map(one => one.name)
  if (names.length === 0) return
  const cwd = await $.session.cwd()
  const taken: string[] = []
  for (const name of names) {
    const path = `${inbox}/${name}`
    const entry = parseInboxEntry(String(await $.fs.read(path).catch(() => '')), `${dir}/parked`)
    if (!entry) {
      const isMoved = await moveTo($, path, `${inbox}/rejected`, name)
      if (!rejectedSeen.has(path)) {
        rejectedSeen.add(path)
        $.ui.log(`watchmen: a park inbox entry did not validate${isMoved ? ` and was moved to ${inbox}/rejected/${name}` : `; ${path} could not be moved aside`}`)
      }
      continue
    }
    if (!isInside(entry.cwd, cwd)) continue
    // An entry applied before whose move failed is only moved again, never applied twice.
    const key = `${entry.sessionId}:${entry.at}`
    if ((await $.state.get(WATCH)).value?.appliedParks?.includes(key)) {
      await moveTo($, path, `${inbox}/done`, name)
      continue
    }
    const item = parkedItem(entry)
    // An entry only ever writes its own park- item: the id is derived from its session id.
    // Marked changed, so the wake's board_changes reports where it came from.
    const answer = await change(
      $,
      items => track(items, item, item.lane).map(one => (one.id === item.id ? { ...one, isChanged: true, last: parkedReport(entry) } : one)),
      () => 'parked',
    )
    if ('deny' in answer) continue
    await patchWatch($, watch => ({ ...watch, appliedParks: [...(watch.appliedParks ?? []).filter(one => one !== key), key].slice(-100) }))
    if (!(await moveTo($, path, `${inbox}/done`, name))) $.ui.log(`watchmen: ${path} was taken onto the board but could not be moved to ${inbox}/done/`)
    taken.push(item.title)
  }
  if (taken.length > 0) await patchWatch($, watch => ({ ...watch, wake: queueWake(watch.wake ?? { pending: [] }, taken) }))
}

// Rejected inbox entries already reported, so one that cannot be moved aside is reported once.
const rejectedSeen = new Set<string>()

/** Moves an inbox entry into a folder of the inbox; whether it moved. */
async function moveTo($: EngineInterface, from: string, folder: string, name: string): Promise<boolean> {
  await $.process.run(['mkdir', '-p', folder]).catch(() => undefined)
  const moved = await $.process.run(['mv', '-f', from, `${folder}/${name}`]).catch(() => undefined)
  return moved?.exitCode === 0
}

/** The briefing for /watchmen start: the launcher's, built here from the plugin's own persona. */
async function startBriefing($: EngineInterface, watch: Watch): Promise<string> {
  const persona = await $.fs.read(`${$.plugin.root}/prompts/persona.md`).catch(() => '')
  const taskModel = pickModel((await $.env.get('WATCHMEN_TASK_MODEL')) || undefined, 'opus')
  return briefing({ persona: String(persona), skill: watch.skill, handoff: watch.handoff, taskModel })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // The flag is read once and kept in the session's state, then cleared from the environment so
    // a claude started from this session's shell is not taken for the watch. A hot reload runs
    // session.start again and finds the watch, and the board, in state.
    const isLaunched = (await $.env.get('WATCHMEN')) === '1'
    if (!(await isWatch($)) && !isLaunched) {
      await $.command.register(COMMAND_IDLE)
      return result
    }
    const isNew = !(await isWatch($))
    await startWatch($, (await $.env.get('WATCHMEN_SKILL')) || undefined)
    // The launcher's briefing is a system prompt built in bash; what discovery finds goes in as a
    // message of its own, once the session is up.
    if (isNew) {
      $.clock.after(0, async () => {
        const found = await discover($).catch(() => undefined)
        if (found) void $.prompt.submit({ text: found }).catch(error => $.ui.log(`watchmen: what discovery found was not sent: ${String(error)}`))
      })
    }
    await $.env.set('WATCHMEN', undefined)
    await $.env.set('WATCHMEN_SKILL', undefined)
    return result
  })

  // The person typing in the watch: what they see now is recorded, and, back after an hour or
  // more, the band says what happened since they last looked, until they type again. Prompts the
  // plugin or the model submit are not the person looking. No model call.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    if ((kind === 'composer' || kind === 'bridge' || kind === 'sdk') && (await isWatch($))) {
      const now = await $.clock.now()
      const items = await read($, board)
      await patchWatch($, held => ({ ...held, sinceNote: sinceYouLooked(held.looked, items, now), looked: { at: now, lanes: lanesOf(items) } }))
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      void checkPark($).catch(error => $.ui.log(`watchmen: park failed: ${String(error)}`))
      if ((await $.state.get(WATCH)).value) {
        const now = await $.clock.now()
        await patchWatch($, held => ({ ...held, lastTurnAt: now }))
      }
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__watchmen__board_track' }, async ($, e) => {
    if (!(await isWatch($))) return { deny: NOT_WATCH }
    const patch = patchFrom(e as Record<string, unknown>)
    // The approval line must show exactly what would run.
    if (patch.check?.argv.some(hasHidden)) {
      return { deny: 'A check argument holds control or invisible formatting characters. Write the command in plain characters.' }
    }
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
    const item = (await read($, board)).find(one => one.id === id)
    const answer = await change($, items => drop(items, id), items => `Dropped. ${items.length} items left.`)
    if ('result' in answer) await countDismissed($, item)
    return answer
  })

  on('tool.call', { tool: 'mcp__watchmen__board_changes' }, async $ => {
    if (!(await isWatch($))) return { deny: NOT_WATCH }
    const report = changeReport(await read($, board))
    // Once a kind has been dismissed often enough, the report asks the watch to ask, once.
    const line = await changeIgnored($, state => {
      const asked = dismissedQuestion(state)
      return asked.line ? { state: asked.state, value: asked.line } : { value: undefined }
    })
    return { result: line ? `${report}\n\n${line}` : report }
  })

  on('command.run', { command: 'watchmen' }, async ($, e) => {
    const watch = (await $.state.get(WATCH)).value
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'start') {
      if (watch) {
        await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)
        return { text: 'This session already keeps the watch.' }
      }
      if (!STARTERS.includes(e.origin.kind)) return { text: 'Only you can start the watch: type /watchmen start yourself.' }
      let started: Watch
      try {
        started = await startWatch($, await findSkill($), true)
      } catch (error) {
        return { text: `The watch could not start: ${String(error)}. Type /watchmen start to try again.` }
      }
      // Less board, more conversation: on the desktop app the pane starts as a small widget; on any
      // other surface (a terminal, VS Code, a phone) it is not opened at all: the band shows the
      // counts, /watchmen opens it, and the fullscreen layout still docks it by itself.
      const surfaces: readonly string[] = await $.session.surfaces().catch(() => [])
      if (surfaces.includes('desktop')) {
        await $.ui.open({ id: PANE, title: PANE_TITLE, placement: 'widget' }).catch(() => undefined)
      }
      // The briefing is the watch's first message. A command.run hook cannot submit a prompt (it
      // would wait on the turn the hook holds), so a timer sends it once the command has answered;
      // the engine starts that turn when the session is idle, the board tools registered above in it.
      // The person typed /watchmen start, so the model reads the briefing as their own words.
      // Discovery runs in that timer after it, and what it finds goes in as the plugin's own message,
      // never as the person's words: its titles come from other people.
      const text = await startBriefing($, started)
      $.clock.after(0, async () => {
        // The morning brief waits for this one; a failed briefing does not hold it back for good.
        void $.prompt
          .submit({ text, asUser: true })
          .catch(error => $.ui.log(`watchmen: the briefing was not sent: ${String(error)}`))
          .finally(() => patchWatch($, held => ({ ...held, isBriefingPending: undefined })))
        const found = await discover($).catch(() => undefined)
        if (found) void $.prompt.submit({ text: found }).catch(error => $.ui.log(`watchmen: what discovery found was not sent: ${String(error)}`))
      })
      return { text: 'This session keeps the watch now. The briefing goes in as the first message.' }
    }
    if (verb === 'park') {
      if (!STARTERS.includes(e.origin.kind)) return { text: 'Only you can park a session: type /watchmen park yourself.' }
      if (watch) return { text: 'This session keeps the watch: park the sessions beside it.' }
      return { text: await startPark($, rest.join(' ')) }
    }
    if (!watch) return { text: HOW_TO_START }
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
      // approve all, in two steps: `approve all` lists every waiting check and one hash over that
      // exact set; `approve all <hash>` approves the set only while it is still the one listed, so
      // nothing the person did not read is approved.
      if (rest[0] === 'all' && rest.length <= 2) {
        const pending = await pendingChecks($)
        if (pending.length === 0) return { text: 'No check is waiting for approval.' }
        const hash = await setHash($, pending)
        const listed = pending.map(one => `  ${sanitize(one.id)}: ${sanitize(JSON.stringify(one.argv))}`)
        if (rest[1] === undefined) {
          return { text: [`Waiting for approval (${pending.length}):`, ...listed, `To approve exactly these, type /watchmen approve all ${hash}`].join('\n') }
        }
        if (rest[1] !== hash) {
          return { text: ['Not approved: the checks waiting changed since that list. Now waiting:', ...listed, `To approve exactly these, type /watchmen approve all ${hash}`].join('\n') }
        }
        for (const one of pending) {
          await $.store.set(await approvalKey($, one.argv), true)
          await setAwaiting($, one.id, undefined)
        }
        await save($)
        return { text: [`Approved for this workspace (${pending.length}):`, ...listed].join('\n') }
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
    if (verb === 'band') {
      const isHidden = !watch.isBandHidden
      await patchWatch($, held => ({ ...held, isBandHidden: isHidden }))
      return { text: isHidden ? 'The band is hidden. /watchmen band brings it back.' : 'The band is back above the prompt.' }
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
    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true }).catch(() => undefined)
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

  // The footer button, in the watch session only: the way into the board, with a red count when
  // something needs the person.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!(await isWatch($))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const modes = await next(e)
    const needs = (await read($, board)).filter(one => one.lane === 'needs-you').length
    return (
      <Box gap={1}>
        {modes}
        <Button key="watchmen-open" label="watchmen" plain onPress={() => void showBoard($)}>
          <Text color={BLUE} bold>
            {'⚛ watchmen'}
          </Text>
          {needs > 0 && (
            <Text color={RED} bold>
              {` · ${needs}`}
            </Text>
          )}
        </Button>
      </Box>
    )
  })

  // The band: one slim row above the prompt in the watch session, a glance and nothing to press:
  // the mascot, the lane counts, what happened since the person last looked, the watch's figures.
  // The footer button and /watchmen open the board. The pane opens by itself only where it docks
  // beside the transcript (the fullscreen layout); on the main screen it waits to be asked.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const watch = (await $.state.get(WATCH)).value
    if (!watch) return next(e)
    if (!isPaneOffered && e.viewport?.isFullscreen === true) {
      isPaneOffered = true
      void $.ui.open({ id: PANE, title: PANE_TITLE })
    }
    if (watch.isBandHidden || e.props.hasSurvey) return next(e)
    const items = await read($, board)
    const shown = await read($, vitalsAtom)
    const since = watch.sinceNote ? [{ text: watch.sinceNote, color: MASCOT_COLORS.changed }] : []
    const { parts } = bandLayout(items, e.props.bodyColumns, [...since, ...vitals(shown.percent, shown.idleMs, HANDOFF_AT)])
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
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
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const items = await read($, board)
    const width = Math.max(10, e.props.bodyColumns)
    const fit = (text: string, room = width) => (room <= 1 ? '…' : text.length > room ? `${text.slice(0, room - 1)}…` : text)
    // Minimized on the desktop app: a glance, the mascot and the counts, then what needs you first.
    if (e.props.placement === 'widget') {
      const state = mascotState(items)
      const seen = glance(items)
      const Svg = 'Svg' in elements ? elements.Svg : undefined
      const atom = Svg ? await atomSvg($, state) : undefined
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {Svg && atom ? (
              <Svg key="mascot" source={atom} alt="⚛" width={16} height={16} />
            ) : (
              <Text key="mascot" color={MASCOT_COLORS[state]} bold={state === 'needs-you'}>⚛</Text>
            )}
            <Text key="counts">{fit(` ${seen.counts}`)}</Text>
          </Box>
          <Text key="first" color={seen.isNeedsYou ? MASCOT_COLORS['needs-you'] : undefined} dimColor={!seen.isNeedsYou}>
            {fit(seen.first)}
          </Text>
        </Box>
      )
    }
    const watch = (await $.state.get(WATCH)).value
    const hasArt = width >= ART_WIDTH + 24
    const header = (
      <Box key="header" flexDirection="row" marginBottom={1}>
        {hasArt && (
          <Box key="art" flexDirection="column" marginRight={2}>
            {OWL.map((line, at) => (
              <Text key={`art:${at}`} color={BLUE}>
                {line}
              </Text>
            ))}
          </Box>
        )}
        <Box key="brand" flexDirection="column">
          <Text key="name" bold color={BLUE}>
            watchmen
          </Text>
          {TAGLINE.map((line, at) => (
            <Text key={`tag:${at}`} dimColor>
              {fit(line, width - (hasArt ? ART_WIDTH + 2 : 0))}
            </Text>
          ))}
          <Box key="actions" flexDirection="row" marginTop={1}>
            <Button key="brief" label="brief" onPress={() => fill($, BRIEF_ASK)} />
            <Text key="actions:sep1"> </Text>
            <Button key="watch" label="+ watch" onPress={() => fill($, WATCH_ASK)} />
            <Text key="actions:sep2"> </Text>
            <Button key="check" label="↻" plain onPress={() => void checkNow($)} />
          </Box>
        </Box>
      </Box>
    )
    const trouble = watch?.boardError ? (
      <Text key="board-error" color={RED}>
        {fit(`⚠ board.json could not be read; not saving until /watchmen reload or reset.`)}
      </Text>
    ) : null

    if (items.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          {trouble}
          <Text key="empty" dimColor>
            {fit('Nothing watched yet. Tell me what to keep an eye on.')}
          </Text>
          <Box key="empty-actions" flexDirection="row" marginTop={1}>
            <Button key="empty-watch" label="+ watch" onPress={() => fill($, WATCH_ASK)} />
          </Box>
        </Box>
      )
    }

    const LANE_COLOR = (lane: (typeof LANES)[number], count: number) =>
      lane === 'needs-you' ? (count > 0 ? RED : undefined) : lane === 'moving' ? BLUE : undefined
    const row = (one: Item, isDim: boolean) => {
      const mark = one.isChanged ? '◆ ' : '  '
      const tag = one.kind ? `${sanitize(one.kind)} ` : ''
      const note = one.note ? sanitize(one.note) : ''
      const lead = 2 + mark.length + tag.length
      const titleRoom = Math.max(4, width - lead)
      const title = fit(sanitize(one.title), titleRoom)
      const isNoteInline = note !== '' && lead + title.length + 3 + note.length <= width
      return [
        <Box key={one.id} flexDirection="row">
          <Text key="mark" color={AMBER} bold>
            {`  ${mark}`}
          </Text>
          {tag && (
            <Text key="tag" dimColor>
              {tag}
            </Text>
          )}
          <Button key={`about:${one.id}`} label={title} plain onPress={() => fill($, `about ${one.id}: `)}>
            <Text bold={one.isChanged} dimColor={isDim}>
              {title}
            </Text>
          </Button>
          {isNoteInline && (
            <Text key="note" dimColor>
              {` — ${note}`}
            </Text>
          )}
        </Box>,
        ...(note && !isNoteInline
          ? [
              <Text key={`${one.id}:note`} dimColor>
                {fit(`      ${note}`)}
              </Text>,
            ]
          : []),
        ...(one.checkError && !one.isAwaitingApproval
          ? [
              <Text key={`${one.id}:error`} color="yellow">
                {fit(`      ⚠ check failed: ${sanitize(one.checkError)}`)}
              </Text>,
            ]
          : []),
        ...approvalLines(one).map((text, at) => (
          <Text key={`${one.id}:approval:${at}`} color="yellow">
            {fit(`      ${text}`)}
          </Text>
        )),
      ]
    }

    return (
      <Box flexDirection="column">
        {header}
        {trouble}
        {LANES.filter(lane => lane !== 'done' || items.some(one => one.lane === 'done')).map(lane => {
          const inLane = items.filter(one => one.lane === lane)
          const isFolded = lane === 'done' && inLane.length > DONE_SHOWN
          const isDimLane = lane === 'waiting' || lane === 'done'
          return (
            <Box key={lane} flexDirection="column" marginBottom={1}>
              <Text key="title" bold color={LANE_COLOR(lane, inLane.length)} dimColor={isDimLane || (lane === 'needs-you' && inLane.length === 0)}>
                {`${LANE_TITLES[lane]} (${inLane.length})`}
              </Text>
              {inLane.length === 0 && (
                <Text key="none" dimColor>
                  {'    —'}
                </Text>
              )}
              {!isFolded && inLane.flatMap(one => row(one, lane === 'done'))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
