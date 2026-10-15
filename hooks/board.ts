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

export function statusLine(items: readonly Item[], percent: number | undefined, elapsedMs: number, handoffAt: number): string {
  const hours = Math.floor(elapsedMs / 3_600_000)
  const minutes = Math.floor((elapsedMs % 3_600_000) / 60_000)
  const parts = ['⚛ watchmen']
  const tally = counts(items)
  const changed = items.filter(one => one.isChanged).length
  if (tally['needs-you']) parts.push(`${tally['needs-you']} need you`)
  if (tally.moving) parts.push(`${tally.moving} moving`)
  if (changed) parts.push(`${changed} changed`)
  if (percent !== undefined) parts.push(`${percent}%`)
  parts.push(percent !== undefined && percent >= handoffAt ? 'write the handoff' : `${hours}h${String(minutes).padStart(2, '0')}`)
  return parts.join(' · ')
}

export function itemLine(item: Item): string {
  const mark = item.isChanged ? '◆' : '•'
  const kind = item.kind ? `[${item.kind}] ` : ''
  const note = item.note ? ` — ${item.note}` : ''
  const trouble = item.isAwaitingApproval
    ? ` ⚠ check awaiting approval: /watchmen approve ${item.id} ${item.approvalHash ?? ''}`.trimEnd()
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
          ...(one.isAwaitingApproval && one.check ? [`      would run: ${JSON.stringify(one.check.argv)}`] : []),
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
