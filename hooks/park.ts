// /watchmen park: any session hands its work to the watch so it can be closed. The session writes a
// handoff with a small front matter; the plugin turns it into an inbox entry under the state dir;
// the watch takes entries for its workspace onto the board. Every field here comes from a file a
// model wrote or anyone could drop in the inbox, so all of it is validated, capped and cleaned, and
// a proposed check waits for the person's approval like any other.

import type { Lane } from '../types'
import { sanitize } from './board'

export type ParkLane = 'waiting' | 'todo'
export const PARK_LANES: readonly ParkLane[] = ['waiting', 'todo']

/** How long a parked session waits for its handoff before it gives up. */
export const PARK_GIVE_UP_MS = 10 * 60_000

const MAX = { title: 120, waitingOn: 200, note: 300, link: 300, cwd: 1_000, argv: 20, arg: 500 } as const

/** One line, no control characters, at most `max` characters. */
export function cleanLine(text: string, max: number): string {
  const one = sanitize(text).trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const isHttp = (value: string) => /^https?:\/\/\S+$/.test(value) && value.length <= MAX.link

/** `/watchmen park [waiting|todo] [free note]`: the lane the person asked for, and their note. */
export function parseParkArgs(args: string): { lane?: ParkLane; note?: string } {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const lane = PARK_LANES.find(one => one === words[0])
  const note = cleanLine((lane ? words.slice(1) : words).join(' '), MAX.note)
  return { ...(lane ? { lane } : {}), ...(note ? { note } : {}) }
}

/** A session id as a file-name-safe short form, and whether the id is one we accept at all. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
}
export function shortId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'session'
}

/** Where parked handoffs and the inbox live, under the state dir the launcher already uses. */
export function stateDirOf(xdgStateHome: string | undefined, home: string | undefined): string | undefined {
  if (xdgStateHome && xdgStateHome.startsWith('/')) return `${xdgStateHome.replace(/\/+$/, '')}/watchmen`
  return home && home.startsWith('/') ? `${home.replace(/\/+$/, '')}/.local/state/watchmen` : undefined
}

/** The prompt the parked session answers: write the handoff, front matter first. */
export function parkPrompt(path: string, lane: ParkLane | undefined, note: string | undefined): string {
  return [
    `◆ park — the human is parking this session with watchmen so they can close it. Write a handoff to ${path} (create the folders if needed), and do nothing else.`,
    'Start the file with this front matter, each value on one line:',
    '---',
    'title: <what this work is, a few words>',
    `lane: <waiting if it waits on someone or something, else todo>${lane ? ` (the human chose: ${lane})` : ''}`,
    'waiting_on: <who or what it waits on, if anything>',
    'link: <an http(s) link to the MR, PR or ticket, if there is one>',
    'check: <optional: a JSON array of strings, a read-only command whose output changes when the wait is over, e.g. ["gh","pr","view","7","--repo","owner/repo","--json","state,reviewDecision"]>',
    '---',
    'Then, in a few short sections: what is done, what is left, what it waits on and from whom, and how to resume.',
    ...(note ? [`The human's note: ${JSON.stringify(note)}`] : []),
    'Leave out any line you have nothing for. When the file is written, say so in one sentence.',
  ].join('\n')
}

export type FrontMatter = { title: string; lane?: ParkLane; waitingOn?: string; link?: string; check?: string[] }

/** A proposed check: an array of 1-20 strings, each at most 500 characters, else nothing. */
export function checkOf(value: unknown): string[] | undefined {
  const argv = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX.argv) return undefined
  if (!argv.every(one => typeof one === 'string' && one.length > 0 && one.length <= MAX.arg && !/[\u0000-\u001f\u007f]/.test(one))) return undefined
  return argv as string[]
}

/** The handoff's front matter, fields that do not validate left out; an error without a title. */
export function parseFrontMatter(text: string): FrontMatter | { error: string } {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text)
  if (!match) return { error: 'no front matter' }
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([a-z_]+):[ \t]*(.*)$/.exec(line)
    if (pair && !(pair[1]! in fields)) fields[pair[1]!] = pair[2]!.trim()
  }
  const title = cleanLine(fields.title ?? '', MAX.title)
  if (!title) return { error: 'no title' }
  const lane = PARK_LANES.find(one => one === fields.lane)
  const waitingOn = cleanLine(fields.waiting_on ?? '', MAX.waitingOn)
  const link = fields.link && isHttp(fields.link) ? fields.link : undefined
  const check = fields.check ? checkOf(fields.check) : undefined
  return { title, ...(lane ? { lane } : {}), ...(waitingOn ? { waitingOn } : {}), ...(link ? { link } : {}), ...(check ? { check } : {}) }
}

export type InboxEntry = {
  sessionId: string
  cwd: string
  handoff: string
  at: number
  title: string
  lane: ParkLane
  waitingOn?: string
  link?: string
  check?: string[]
  note?: string
}

/**
 * An inbox entry as read from disk, validated: undefined when it is not one we accept. Its handoff
 * must be a plain file directly inside the parked folder.
 */
export function parseInboxEntry(text: string, parkedDir: string): InboxEntry | undefined {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const { sessionId, cwd, handoff, at } = raw
  if (!isSessionId(sessionId)) return undefined
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > MAX.cwd || /[\u0000-\u001f\u007f]/.test(cwd) || cwd.split('/').includes('..')) return undefined
  if (typeof handoff !== 'string' || !handoff.startsWith(`${parkedDir}/`) || !/^[A-Za-z0-9._-]+\.md$/.test(handoff.slice(parkedDir.length + 1)) || handoff.includes('..')) return undefined
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  const title = typeof raw.title === 'string' ? cleanLine(raw.title, MAX.title) : ''
  if (!title) return undefined
  const lane = PARK_LANES.find(one => one === raw.lane) ?? 'todo'
  const text_ = (value: unknown, max: number) => (typeof value === 'string' ? cleanLine(value, max) : '')
  const waitingOn = text_(raw.waitingOn, MAX.waitingOn)
  const note = text_(raw.note, MAX.note)
  const link = typeof raw.link === 'string' && isHttp(raw.link) ? raw.link : undefined
  const check = checkOf(raw.check)
  return {
    sessionId,
    cwd,
    handoff,
    at,
    title,
    lane,
    ...(waitingOn ? { waitingOn } : {}),
    ...(link ? { link } : {}),
    ...(check ? { check } : {}),
    ...(note ? { note } : {}),
  }
}

/** Whether `cwd` is the workspace or inside it. */
export function isInside(cwd: string, root: string): boolean {
  const base = root.replace(/\/+$/, '') || '/'
  return cwd === base || cwd.startsWith(base === '/' ? '/' : `${base}/`)
}

/** A path as one shell word: as it is when plain, else single-quoted. */
export function shellWord(text: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

export function resumeCommand(entry: Pick<InboxEntry, 'cwd' | 'sessionId'>): string {
  return `cd ${shellWord(entry.cwd)} && claude --resume ${entry.sessionId}`
}

/**
 * The board item a parked session becomes: id park-<short>, kind session, in waiting or needs-you,
 * marked changed so the wake's board_changes reports it; its check, if any, awaits approval.
 */
export function parkedItem(entry: InboxEntry): { id: string; title: string; kind: string; lane: Lane; note: string; link: string; check?: { argv: string[] } } {
  const why = entry.waitingOn ? `waiting on ${entry.waitingOn}` : entry.note ?? 'parked'
  return {
    id: `park-${shortId(entry.sessionId)}`,
    title: entry.title,
    kind: 'session',
    lane: entry.lane === 'waiting' ? 'waiting' : 'needs-you',
    note: `${why} · resume: ${resumeCommand(entry)}`,
    link: entry.link ?? entry.handoff,
    ...(entry.check ? { check: { argv: entry.check } } : {}),
  }
}

/** What board_changes says of a parked session the first time: where it came from, quoted. */
export function parkedReport(entry: InboxEntry): string {
  return `parked from ${JSON.stringify(entry.cwd)}: ${JSON.stringify(entry.title)}${entry.waitingOn ? `, waiting on ${JSON.stringify(entry.waitingOn)}` : ''}`
}
