// One follow step, shared by the follower process and the tab.focused hook: read the state, ask
// herdr where everything is, decide, and move the watch beside you without taking focus.
//
// The move lock (a directory) keeps the two, or two runs of either, from moving the pane at once.

import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { decideFollow } from './herdr-follow-decision.mjs'

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 5_000
/** How long a "the watch is gone" reading must hold before follow turns off: a pane mid-move or a
 * slow `herdr pane list` under load can look gone for a moment. */
export const STOP_CONFIRM_MS = 2_000
const LOG_MAX_BYTES = 256 * 1024

/**
 * The split ratio: herdr's --ratio is the FIRST pane's share, so 0.7 leaves the person 70% and the
 * watch 30%. WATCHMEN_RATIO overrides it with a number from 0.1 to 0.9; anything else is ignored.
 */
export function ratioOf(env = process.env) {
  const given = env.WATCHMEN_RATIO ?? ''
  const value = Number(given)
  return /^0?\.[0-9]{1,3}$/.test(given) && value >= 0.1 && value <= 0.9 ? given : '0.7'
}

export function paths(env = process.env) {
  const dir = join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'watchmen')
  return {
    dir,
    follow: join(dir, 'follow'),
    latest: join(dir, 'follow.latest'),
    lock: join(dir, 'follow.lock'),
    pid: join(dir, 'follower.pid'),
    log: join(dir, 'follow.log'),
  }
}

export function isFollowing(env = process.env) {
  try {
    return readFileSync(paths(env).follow, 'utf8').trim() === 'on'
  } catch {
    return false
  }
}

/** Appends a timestamped line to follow.log, the one place that says why follow changed. */
export function note(text, env = process.env) {
  const { dir, log } = paths(env)
  try {
    mkdirSync(dir, { recursive: true })
    try {
      if (statSync(log).size > LOG_MAX_BYTES) renameSync(log, `${log}.1`)
    } catch {}
    appendFileSync(log, `${new Date().toISOString()} [${process.pid}] ${text}\n`)
  } catch {}
}

export function setFollow(on, env = process.env) {
  const { dir, follow } = paths(env)
  mkdirSync(dir, { recursive: true })
  writeFileSync(follow, on ? 'on\n' : 'off\n')
}

function herdr(env) {
  return env.HERDR_BIN_PATH || 'herdr'
}

function herdrJson(env, ...args) {
  return execFileSync(herdr(env), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, env })
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Whether the watch in a herdr pane still runs. The launcher records each watch it starts inside
 * herdr in watchmen/panes/<pane id> (its pid, which exec hands to claude, and its folder), so two
 * watches in two places never answer for each other. A pane with no record (one summon has just
 * labelled, before the launcher wrote it) or an unreadable one counts as alive.
 */
export function isPaneAlive(paneId, env = process.env) {
  if (!/^[A-Za-z0-9_:.-]{1,128}$/.test(paneId ?? '') || paneId.startsWith('-')) return true
  try {
    const record = JSON.parse(readFileSync(join(paths(env).dir, 'panes', paneId), 'utf8'))
    return !Number.isInteger(record?.pid) || record.pid <= 0 || isAlive(record.pid)
  } catch {
    return true
  }
}

/**
 * Moves a watch's record to the pane's new id after `herdr pane move`, which may give the pane a
 * new id (its answer names it, as `previous_pane_id` beside the moved `pane`). Without this the
 * moved watch would have no record and could never be found dead.
 */
export function rekeyPane(previousId, moveAnswer, env = process.env) {
  const safe = id => typeof id === 'string' && /^[A-Za-z0-9_:.-]{1,128}$/.test(id) && !id.startsWith('-')
  let next
  try {
    const answer = JSON.parse(moveAnswer)
    next = answer?.result?.pane?.pane_id ?? answer?.pane?.pane_id
  } catch {
    return
  }
  if (!safe(previousId) || !safe(next) || next === previousId) return
  const panes = join(paths(env).dir, 'panes')
  try {
    const record = JSON.parse(readFileSync(join(panes, previousId), 'utf8'))
    writeFileSync(join(panes, next), `${JSON.stringify({ ...record, pane_id: next })}\n`)
    rmSync(join(panes, previousId), { force: true })
  } catch {}
}

/**
 * Takes the move lock: a directory holding an owner file with this run's token. Answers the token,
 * and whether the run had to wait for it; undefined when it stayed held past LOCK_WAIT_MS.
 *
 * A lock whose owner died, or older than LOCK_STALE_MS, is taken over by renaming it aside first:
 * rename is atomic, so of two runs that both judge it stale only one wins, and neither removes a
 * lock the other has just taken.
 */
export function acquireLock(env = process.env, waitMs = LOCK_WAIT_MS) {
  const { dir, lock } = paths(env)
  mkdirSync(dir, { recursive: true })
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + waitMs
  let hasWaited = false
  for (;;) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner'), token)
      return { token, hasWaited }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    let isStale = false
    try {
      const owner = readFileSync(join(lock, 'owner'), 'utf8')
      isStale = !isAlive(Number(owner.split(':')[0]))
    } catch {}
    try {
      isStale ||= Date.now() - statSync(lock).mtimeMs >= LOCK_STALE_MS
    } catch {
      continue // released meanwhile: try again at once
    }
    if (isStale) {
      const aside = `${lock}.stale.${token.replace(/[^A-Za-z0-9]/g, '')}`
      try {
        renameSync(lock, aside)
        rmSync(aside, { recursive: true, force: true })
      } catch {}
      continue
    }
    if (Date.now() >= deadline) return undefined
    hasWaited = true
    sleep(50)
  }
}

/** Releases the lock if this run still owns it. */
export function releaseLock(token, env = process.env) {
  const { lock } = paths(env)
  try {
    if (readFileSync(join(lock, 'owner'), 'utf8') === token) rmSync(lock, { recursive: true, force: true })
  } catch {}
}

/** The tab focused now, as an event: what a run that waited for the lock decides from. */
function focusedNow(panesJson) {
  try {
    const focused = JSON.parse(panesJson)?.result?.panes?.find(pane => pane?.focused === true)
    return focused ? JSON.stringify({ tab_id: focused.tab_id, workspace_id: focused.workspace_id }) : ''
  } catch {
    return ''
  }
}

/**
 * Runs one follow step for a tab-focus event and answers the decision it acted on. STOP turns
 * follow off, but only when a second look STOP_CONFIRM_MS later still finds the watch gone; MOVE moves the pane with --no-focus; anything else does nothing. A run that waited
 * for another move decides from the tab focused once it holds the lock, so the last switch wins.
 */
export function followOnce(eventJson, env = process.env, confirmMs = STOP_CONFIRM_MS) {
  if (!isFollowing(env)) return 'SKIP follow is off'
  const held = acquireLock(env)
  if (!held) return 'SKIP another move is under way'
  try {
    const decide = useFocusedNow => {
      const panesJson = herdrJson(env, 'pane', 'list')
      return decideFollow({
        isFollowing: isFollowing(env),
        isPaneAlive: paneId => isPaneAlive(paneId, env),
        eventJson: useFocusedNow ? focusedNow(panesJson) : eventJson,
        panesJson,
        tabsJson: herdrJson(env, 'tab', 'list'),
      })
    }
    let decision = decide(held.hasWaited)
    if (decision.startsWith('STOP ')) {
      // Look again before giving up on the watch: one reading can catch it mid-move.
      sleep(confirmMs)
      const again = decide(true)
      if (!again.startsWith('STOP ')) note(`kept following: "${decision}" did not hold (${again})`, env)
      decision = again
    }
    const [verb, ...rest] = decision.split(' ')
    if (verb === 'MOVE') {
      const [pane, tab, target] = rest
      const answer = execFileSync(
        herdr(env),
        ['pane', 'move', pane, '--tab', tab, '--target-pane', target, '--split', 'right', '--ratio', ratioOf(env), '--no-focus'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, env },
      )
      rekeyPane(pane, answer ?? '', env)
    } else if (verb === 'STOP') {
      setFollow(false, env)
      note(`follow off: ${decision}`, env)
    } else if (verb === 'ERROR') {
      note(`follow step: ${decision}`, env)
    }
    return decision
  } finally {
    releaseLock(held.token, env)
  }
}
