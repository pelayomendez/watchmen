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
      (one.checkedAt === undefined || now - one.checkedAt >= checkInterval(one.check)),
  )
}

export type CheckOutcome = { exitCode: number; stdout: string; stderr: string } | { error: string }

/**
 * Applies a check's outcome to its item. The first output is the baseline; a later different output
 * marks the item changed. A failure leaves the baseline alone and says so in the note.
 */
export function applyCheck(item: Item, outcome: CheckOutcome, now: number): { item: Item; isChanged: boolean } {
  if ('error' in outcome || outcome.exitCode !== 0) {
    const reason =
      'error' in outcome ? outcome.error : (outcome.stderr.trim() || `exit ${outcome.exitCode}`).split('\n')[0]
    return { item: { ...item, note: `check failed: ${reason}`.slice(0, 200) }, isChanged: false }
  }
  const output = outcome.stdout.trim().slice(0, OUTPUT_LIMIT)
  const note = item.note?.startsWith('check failed:') ? undefined : item.note
  if (item.last === undefined) return { item: { ...item, note, last: output }, isChanged: false }
  if (output === item.last) return { item: { ...item, note }, isChanged: false }
  return { item: { ...item, note, last: output, changedAt: now, isChanged: true }, isChanged: true }
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
  return `${mark} ${kind}${item.title}${note}`
}

/** The board as text, grouped by lane, empty lanes left out. */
export function summary(items: readonly Item[]): string {
  if (items.length === 0) return 'The board is empty. Track something with /watchmen track <title>.'
  const blocks: string[] = []
  for (const lane of LANES) {
    const inLane = items.filter(one => one.lane === lane)
    if (inLane.length === 0) continue
    blocks.push([`${LANE_TITLES[lane]} (${inLane.length})`, ...inLane.map(one => `  ${itemLine(one)}  {${one.id}}`)].join('\n'))
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

/** Reads board.json; anything unreadable gives an empty board rather than a broken watch. */
export function parse(text: string): Item[] {
  try {
    const data = JSON.parse(text) as { items?: unknown }
    if (!Array.isArray(data.items)) return []
    return data.items.filter(
      (one): one is Item =>
        typeof one === 'object' && one !== null && typeof one.id === 'string' && typeof one.title === 'string' && isLane(one.lane),
    )
  } catch {
    return []
  }
}
