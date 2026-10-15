// One follow step, shared by the follower process and the tab.focused hook: read the state, ask
// herdr where everything is, decide, and move the watch beside you without taking focus.
//
// The move lock (a directory) keeps the two, or two runs of either, from moving the pane at once.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { decideFollow } from './herdr-follow-decision.mjs'

const LOCK_STALE_MS = 10_000
const RATIO = '0.35'

export function paths(env = process.env) {
  const dir = join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'watchmen')
  return {
    dir,
    follow: join(dir, 'follow'),
    latest: join(dir, 'follow.latest'),
    lock: join(dir, 'follow.lock'),
    pid: join(dir, 'follower.pid'),
  }
}

export function isFollowing(env = process.env) {
  try {
    return readFileSync(paths(env).follow, 'utf8').trim() === 'on'
  } catch {
    return false
  }
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

/** Takes the move lock, or answers false when another move holds it. A lock left by a dead run is taken after 10 s. */
function lock(env) {
  const { dir, lock: lockDir } = paths(env)
  mkdirSync(dir, { recursive: true })
  try {
    mkdirSync(lockDir)
    return true
  } catch {
    try {
      return Date.now() - statSync(lockDir).mtimeMs >= LOCK_STALE_MS
    } catch {
      return false
    }
  }
}

/**
 * Runs one follow step for a tab-focus event and answers the decision it acted on. STOP turns
 * follow off; MOVE moves the pane with --no-focus; anything else does nothing.
 */
export function followOnce(eventJson, env = process.env) {
  if (!isFollowing(env)) return 'SKIP follow is off'
  if (!lock(env)) return 'SKIP another move is under way'
  try {
    const decision = decideFollow({
      isFollowing: isFollowing(env),
      eventJson,
      panesJson: herdrJson(env, 'pane', 'list'),
      tabsJson: herdrJson(env, 'tab', 'list'),
    })
    const [verb, ...rest] = decision.split(' ')
    if (verb === 'MOVE') {
      const [pane, tab, target] = rest
      execFileSync(
        herdr(env),
        ['pane', 'move', pane, '--tab', tab, '--target-pane', target, '--split', 'right', '--ratio', RATIO, '--label', 'watchmen', '--no-focus'],
        { stdio: 'ignore', timeout: 5_000, env },
      )
    } else if (verb === 'STOP') {
      setFollow(false, env)
    }
    return decision
  } finally {
    try {
      rmdirSync(paths(env).lock)
    } catch {}
  }
}
