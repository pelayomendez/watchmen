import type { Check, Item, Lane } from '../types'

// The board's rules, kept free of the engine so they can be tested as plain functions. The module
// in register.tsx wires them to state, the clock, processes and the screen.

export const LANES: readonly Lane[] = ['needs-you', 'moving', 'waiting', 'done']
export const LANE_TITLES: Record<Lane, string> = {
  'needs-you': 'Needs you',
  moving: 'Moving',
  waiting: 'Waiting',
  done: 'Done',
}

export const CHECK_DEFAULT_MS = 300_000
export const CHECK_MIN_MS = 60_000
const OUTPUT_LIMIT = 2_000

export function isLane(value: unknown): value is Lane {
  return typeof value === 'string' && (LANES as readonly string[]).includes(value)
}

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'item'
  )
}

export function checkInterval(check: Check): number {
  return Math.max(CHECK_MIN_MS, check.everyMs ?? CHECK_DEFAULT_MS)
}

export type ItemPatch = Partial<Omit<Item, 'last' | 'checkedAt' | 'changedAt' | 'isChanged'>> & { title?: string }

/** Adds an item, or merges the patch into the one with the same id. A new check starts fresh. */
export function track(items: readonly Item[], patch: ItemPatch, defaultLane: Lane = 'moving'): Item[] {
  const id = patch.id || (patch.title ? slug(patch.title) : undefined)
  if (!id) throw new Error('An item needs an id or a title.')
  const index = items.findIndex(one => one.id === id)
  if (index === -1) {
    if (!patch.title) throw new Error(`No item "${id}" on the board, and a new one needs a title.`)
    return [...items, { ...clean(patch), id, title: patch.title, lane: patch.lane ?? defaultLane }]
  }
  const old = items[index]!
  const isNewCheck = patch.check !== undefined && JSON.stringify(patch.check) !== JSON.stringify(old.check)
  const merged: Item = { ...old, ...clean(patch), id, title: patch.title ?? old.title, lane: patch.lane ?? old.lane }
  if (isNewCheck) {
    delete merged.last
    delete merged.checkedAt
    delete merged.isChanged
  }
  return items.map((one, at) => (at === index ? merged : one))
}

function clean(patch: ItemPatch): ItemPatch {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as ItemPatch
}

export function move(items: readonly Item[], id: string, lane?: Lane, note?: string): Item[] {
  if (!items.some(one => one.id === id)) throw new Error(`No item "${id}" on the board.`)
  return items.map(one =>
    one.id === id
      ? { ...one, ...(lane ? { lane } : {}), ...(note !== undefined ? { note } : {}), isChanged: false }
      : one,
  )
}

export function drop(items: readonly Item[], id: string): Item[] {
  if (!items.some(one => one.id === id)) throw new Error(`No item "${id}" on the board.`)
  return items.filter(one => one.id !== id)
}

/** The items whose check is due now and not already running. Done items are not checked. */
export function dueChecks(items: readonly Item[], now: number, running: ReadonlySet<string>): Item[] {
  return items.filter(
    one =>
      one.check &&
      one.lane !== 'done' &&
      !running.has(one.id) &&
      (one.checkedAt === undefined || one.checkedAt > now || now - one.checkedAt >= checkInterval(one.check)),
  )
}

export type CheckOutcome = { exitCode: number; stdout: string; stderr: string } | { error: string }

/** What a check's outcome comes to once the watch has hashed a successful output. */
export type CheckResult = { output: string; hash: string } | { error: string }

/** Reads a process outcome as a result: a non-zero exit is a failure, its first stderr line the reason. */
export function failureOf(outcome: CheckOutcome): string | undefined {
  if ('error' in outcome) return outcome.error
  if (outcome.exitCode === 0) return undefined
  return (outcome.stderr.trim() || `exit ${outcome.exitCode}`).split('\n')[0]
}

/**
 * Applies a check's result to its item. The first output is the baseline; a later output whose hash
 * differs marks the item changed. The hash covers the whole output, the stored text only its head.
 * A failure is kept apart from the note, which is the model's.
 */
export function applyCheck(item: Item, result: CheckResult, now: number): { item: Item; isChanged: boolean } {
  if ('error' in result) return { item: { ...item, checkError: result.error.slice(0, 200) }, isChanged: false }
  const { checkError: _, ...rest } = item
  const last = result.output.slice(0, OUTPUT_LIMIT)
  if (item.lastHash === undefined || item.lastHash === result.hash) {
    return { item: { ...rest, last, lastHash: result.hash }, isChanged: false }
  }
  return { item: { ...rest, last, lastHash: result.hash, changedAt: now, isChanged: true }, isChanged: true }
}

/**
 * Applies one check's result to the board. Each call stands alone, so a state update that retries
 * after a version miss carries nothing over from its earlier attempt. An item dropped meanwhile,
 * or given another check, is left alone: the result no longer describes it.
 */
export function applyToBoard(items: readonly Item[], checked: Item, result: CheckResult, now: number): { items: Item[]; changedTitle?: string } {
  let changedTitle: string | undefined
  const after = items.map(one => {
    if (one.id !== checked.id || JSON.stringify(one.check) !== JSON.stringify(checked.check)) return one
    const applied = applyCheck(one, result, now)
    if (applied.isChanged) changedTitle = one.title
    return applied.item
  })
  return { items: after, changedTitle }
}

/**
 * Wraps a board change for a state update that may call it more than once: every attempt starts
 * clean, and the outcome is the last attempt's (the one that landed).
 */
export function attempt(fn: (items: Item[]) => Item[]) {
  let error: string | undefined
  let after: Item[] = []
  return {
    run(items: Item[]): Item[] {
      error = undefined
      try {
        after = fn(items)
        return after
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown)
        after = items
        return items
      }
    },
    outcome: () => ({ error, after }),
  }
}

export function counts(items: readonly Item[]): Record<Lane, number> {
  const tally: Record<Lane, number> = { 'needs-you': 0, moving: 0, waiting: 0, done: 0 }
  for (const one of items) tally[one.lane] += 1
  return tally
}

/**
 * The watch's own figures for the band: how full its context is and how long it has been idle,
 * or, past handoffAt, the reminder to write the handoff.
 */
export function vitals(percent: number | undefined, idleMs: number | undefined, handoffAt: number): BandPart[] {
  if (percent !== undefined && percent >= handoffAt) return [{ text: `${percent}% · write the handoff`, color: MASCOT_COLORS.changed, bold: true }]
  const parts: BandPart[] = []
  if (percent !== undefined) parts.push({ text: `${percent}%`, dim: true })
  if (idleMs !== undefined && idleMs >= 60_000) parts.push({ text: `idle ${duration(idleMs)}`, dim: true })
  return parts
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}` : `${minutes}m`
}

/** Idle this long, the watch rotates before its prompt cache (an hour) goes cold. */
export const ROTATE_IDLE_MS = 50 * 60_000
/** Rotate only once the conversation has grown this far past where it started. */
export const ROTATE_GROWTH_TOKENS = 40_000

/**
 * Whether the watch should rotate now: write its handoff and start over on a cleared conversation.
 * An idle watch's cache goes cold within the hour, and its next wake then pays to cache the whole
 * conversation again; rotating first means that wake finds a small one. Only when the
 * conversation has grown well past a fresh start, and never over a turn or the person typing.
 */
export function isRotationDue(input: {
  now: number
  lastTurnAt?: number
  tokens?: number
  baseTokens?: number
  isTurnRunning: boolean
  draft: string
}): boolean {
  const { now, lastTurnAt, tokens, baseTokens, isTurnRunning, draft } = input
  if (isTurnRunning || draft.trim() !== '') return false
  if (lastTurnAt === undefined || tokens === undefined || baseTokens === undefined) return false
  return now - lastTurnAt >= ROTATE_IDLE_MS && tokens - baseTokens >= ROTATE_GROWTH_TOKENS
}

/** The prompt that asks the watch for its handoff before a rotation. Constant: no board text. */
export const ROTATE_PROMPT =
  '◆ rotate — the watch has been idle and its conversation is long. Write the handoff now, as your skill describes, to .companion/handoff-<YYYY-MM-DD-HHMM>.md. Do not triage or speak to the human; end the turn once the file is written.'

/** The prompt that starts the watch again on a cleared conversation, from the handoff it wrote. */
export function resumePrompt(handoff: string): string {
  return `◆ resumed — the conversation was cleared to keep the watch light. Read ${handoff}, then call board_changes and triage. Speak only if something needs the human.`
}

/** Removes control characters and DEL, so text from a board.json cannot drive the terminal. */
export function sanitize(text: string): string {
  return text.replace(/[\t\n\r\v\f]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
}

/**
 * What an item awaiting approval shows under it: the exact command first, then how to approve
 * that command, so the human reads what they are approving before the line they copy.
 */
export function approvalLines(item: Item): string[] {
  if (!item.isAwaitingApproval || !item.check) return []
  return [
    `would run: ${sanitize(JSON.stringify(item.check.argv))}`,
    sanitize(`to approve: /watchmen approve ${item.id} ${item.approvalHash ?? ''}`).trimEnd(),
  ]
}

export function itemLine(item: Item): string {
  const mark = item.isChanged ? '◆' : '•'
  const kind = item.kind ? `[${item.kind}] ` : ''
  const note = item.note ? ` — ${item.note}` : ''
  const trouble = item.isAwaitingApproval
    ? ' ⚠ check awaiting approval'
    : item.checkError
      ? ` ⚠ check failed: ${item.checkError}`
      : ''
  return `${mark} ${kind}${item.title}${note}${trouble}`
}

/** The board as text, grouped by lane, empty lanes left out. */
export function summary(items: readonly Item[]): string {
  if (items.length === 0) return 'The board is empty. Track something with /watchmen track <title>.'
  const blocks: string[] = []
  for (const lane of LANES) {
    const inLane = items.filter(one => one.lane === lane)
    if (inLane.length === 0) continue
    blocks.push(
      [
        `${LANE_TITLES[lane]} (${inLane.length})`,
        ...inLane.flatMap(one => [
          `  ${itemLine(one)}  {${one.id}}`,
          ...approvalLines(one).map(line => `      ${line}`),
        ]),
      ].join('\n'),
    )
  }
  return blocks.join('\n\n')
}

/** The items as the model reads them after a change: id, lane, title, and what the check says now. */
export function changeReport(items: readonly Item[]): string {
  const changed = items.filter(one => one.isChanged)
  if (changed.length === 0) return 'Nothing has changed since the last triage.'
  return changed
    .map(one => [`${one.id} (${one.lane}) ${one.title}`, ...(one.link ? [`  link: ${one.link}`] : []), `  now: ${one.last ?? ''}`].join('\n'))
    .join('\n\n')
}

export function serialize(items: readonly Item[]): string {
  return JSON.stringify({ version: 1, items }, null, 2) + '\n'
}

function isItem(one: unknown): one is Item {
  if (typeof one !== 'object' || one === null) return false
  const item = one as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.title === 'string' && isLane(item.lane)
}

/** A check as read from a file: argv must be strings, and an everyMs that is not a number is dropped. */
function checkOf(value: unknown): Check | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { argv, everyMs } = value as Record<string, unknown>
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(one => typeof one === 'string')) return undefined
  return { argv, ...(typeof everyMs === 'number' && Number.isFinite(everyMs) ? { everyMs } : {}) }
}

/**
 * Reads board.json. A file that is not a board, or holds an item without an id, title or lane, is
 * an error rather than an empty board, so the watch never writes over what it could not read.
 */
export function parseBoard(text: string): { items: Item[] } | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    return { error: `not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const items = (data as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return { error: 'no items list' }
  const bad = items.findIndex(one => !isItem(one))
  if (bad !== -1) return { error: `item ${bad + 1} has no id, title or known lane` }
  return {
    items: items.map((one: Item) => {
      const { check, ...rest } = one
      const valid = checkOf(check)
      return valid ? { ...rest, check: valid } : rest
    }),
  }
}

export function parse(text: string): Item[] {
  const read = parseBoard(text)
  return 'items' in read ? read.items : []
}

/** The short line the herdr spaces sidebar shows for the watch, as the `$watchmen` token. */
export function sidebarToken(items: readonly Item[]): string {
  const tally = counts(items)
  const changed = items.filter(one => one.isChanged).length
  if (tally['needs-you'] > 0) return `⚛ ${tally['needs-you']} need you`
  if (changed > 0) return `⚛ ${changed} changed`
  return '⚛ quiet'
}

/** A herdr id or binary path safe to hand to a process: no option-like or shell-special text. */
export function isSafeHerdrArg(value: string | undefined, kind: 'id' | 'bin'): value is string {
  if (!value || value.startsWith('-')) return false
  return kind === 'id' ? /^[A-Za-z0-9_:.-]{1,128}$/.test(value) : value === 'herdr' || /^\/[^\0\n]*$/.test(value)
}

/** At most one wake every three minutes: changes in between are batched into the next one. */
export const WAKE_EVERY_MS = 180_000

export type WakeState = { pending: string[]; lastWakeAt?: number }

/** Queues changed titles for the next wake, each once. */
export function queueWake(state: WakeState, titles: readonly string[]): WakeState {
  return { ...state, pending: [...new Set([...state.pending, ...titles])] }
}

/**
 * The prompt that wakes the watch to triage, or why not now: nothing queued, too soon after the
 * last wake, a turn running, or the person in the middle of typing. A held wake stays queued.
 */
export function wakePrompt(
  state: WakeState,
  { now, isTurnRunning, draft }: { now: number; isTurnRunning: boolean; draft: string },
): { text: string } | { wait: string } {
  if (state.pending.length === 0) return { wait: 'nothing changed' }
  if (state.lastWakeAt !== undefined && now - state.lastWakeAt < WAKE_EVERY_MS) return { wait: 'woke recently' }
  if (isTurnRunning) return { wait: 'a turn is running' }
  if (draft.trim() !== '') return { wait: 'the person is typing' }
  // A constant prompt: titles come from check output and board.json, so they reach the model only
  // as tool data through board_changes, never as words in a user turn.
  const count = state.pending.length
  return { text: `◆ ${count} ${count === 1 ? 'item' : 'items'} changed — call board_changes` }
}

/** Whether a board change moved an item into needs-you: the one kind of change that pings. */
export function enteredNeedsYou(before: readonly Item[], after: readonly Item[]): Item[] {
  return after.filter(one => one.lane === 'needs-you' && before.find(old => old.id === one.id)?.lane !== 'needs-you')
}

/** The mascot's mood: calm, something changed, or something needs the person. */
export type MascotState = 'calm' | 'changed' | 'needs-you'

export function mascotState(items: readonly Item[]): MascotState {
  if (items.some(one => one.lane === 'needs-you')) return 'needs-you'
  if (items.some(one => one.isChanged)) return 'changed'
  return 'calm'
}

/** One colour per state, shared by the band, the status line, the SVG and the herdr sidebar. */
export const MASCOT_COLORS: Record<MascotState, string> = {
  calm: '#4C8DFF',
  changed: '#F5A524',
  'needs-you': '#E5484D',
}

/** Fills the atom's colour slots for a state; on `changed` the electron alone lights up. */
export function paintAtom(template: string, state: MascotState): string {
  const color = MASCOT_COLORS[state]
  const electron = state === 'calm' ? MASCOT_COLORS.calm : color
  const body = state === 'changed' ? MASCOT_COLORS.calm : color
  return template.replaceAll('__ORBIT__', body).replaceAll('__NUCLEUS__', body).replaceAll('__ELECTRON__', electron)
}

export type BandPart = { text: string; color?: string; bold?: boolean; dim?: boolean }

/**
 * The band's counts, fitted to the columns it has: full words when wide, short words when not,
 * and the mascot alone at the narrowest. Answers whether the buttons fit too.
 */
export function bandLayout(items: readonly Item[], columns: number, extra: readonly BandPart[] = []): { parts: BandPart[]; hasButtons: boolean } {
  const tally = counts(items)
  const state = mascotState(items)
  const mascot: BandPart = { text: '⚛', color: MASCOT_COLORS[state], bold: state === 'needs-you' }
  const words = columns >= 56
    ? { need: 'need you', moving: 'moving', waiting: 'waiting' }
    : { need: 'need', moving: 'mov', waiting: 'wait' }
  const counted: BandPart[] = [
    { text: `${tally['needs-you']} ${words.need}`, color: tally['needs-you'] ? MASCOT_COLORS['needs-you'] : undefined, bold: tally['needs-you'] > 0, dim: tally['needs-you'] === 0 },
    { text: `${tally.moving} ${words.moving}`, color: 'cyan' },
    { text: `${tally.waiting} ${words.waiting}`, dim: true },
  ]
  const line = (parts: BandPart[]) => parts.map(one => one.text).join(' · ').length + 2
  const hasButtons = columns >= 44
  const room = columns - (hasButtons ? 18 : 0)
  if (extra.length > 0 && line([...counted, ...extra]) <= room) return { parts: [mascot, ...counted, ...extra], hasButtons }
  if (line(counted) <= room) return { parts: [mascot, ...counted], hasButtons }
  if (columns >= 12) return { parts: [mascot, counted[0]!], hasButtons: false }
  return { parts: [mascot], hasButtons: false }
}

/**
 * The herdr spaces sidebar, coloured by state: three tokens, of which only the one for the current
 * state carries text, each styled by its own row entry in herdr's config (SIDEBAR_ROW).
 */
export function sidebarTokens(items: readonly Item[]): Record<'watchmen_alert' | 'watchmen_changed' | 'watchmen_quiet', string> {
  const state = mascotState(items)
  const text = sidebarToken(items)
  return {
    watchmen_alert: state === 'needs-you' ? text : '',
    watchmen_changed: state === 'changed' ? text : '',
    watchmen_quiet: state === 'calm' ? text : '',
  }
}

/** The row to add to `[ui.sidebar.spaces] rows` in herdr's config.toml (checked with `herdr config check`). */
export const SIDEBAR_ROW =
  `[{ token = "$watchmen_alert", fg = "${MASCOT_COLORS['needs-you']}", bold = true }, ` +
  `{ token = "$watchmen_changed", fg = "${MASCOT_COLORS.changed}" }, ` +
  `{ token = "$watchmen_quiet", dim = true }]`
