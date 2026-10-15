// The tab.focused event hook: while follow is on, move the watchmen pane beside you in the tab you
// just focused, without taking focus. herdr runs it once per event with HERDR_PLUGIN_EVENT_JSON.
//
// Rapid switches are debounced: each run waits 150 ms and gives way if a newer event arrived. A
// lock keeps two moves from running at once. Follow is a file, so it outlives any one run:
// ${XDG_STATE_HOME:-~/.local/state}/watchmen/follow, "on" or "off".

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { decideFollow } from './herdr-follow-decision.mjs'

const DEBOUNCE_MS = 150
const LOCK_STALE_MS = 10_000
const RATIO = '0.35'

const herdr = process.env.HERDR_BIN_PATH || 'herdr'
const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'watchmen')
const followFile = join(stateDir, 'follow')
const latestFile = join(stateDir, 'follow.latest')
const lockDir = join(stateDir, 'follow.lock')

function say(text) {
  process.stderr.write(`watchmen follow: ${text}\n`)
}

function isFollowing() {
  try {
    return readFileSync(followFile, 'utf8').trim() === 'on'
  } catch {
    return false
  }
}

function herdrJson(...args) {
  return execFileSync(herdr, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 })
}

if (!isFollowing()) process.exit(0)
mkdirSync(stateDir, { recursive: true })

// Debounce: the newest event wins; an older run that wakes to find another stamp gives way.
const stamp = `${process.pid}:${Date.now()}`
writeFileSync(latestFile, stamp)
await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS))
if (readFileSync(latestFile, 'utf8') !== stamp) process.exit(0)

// Never move while another move is under way. A lock left by a run that died is taken after 10 s.
try {
  mkdirSync(lockDir)
} catch {
  try {
    if (Date.now() - statSync(lockDir).mtimeMs < LOCK_STALE_MS) process.exit(0)
  } catch {}
}
try {
  const decision = decideFollow({
    isFollowing: isFollowing(),
    eventJson: process.env.HERDR_PLUGIN_EVENT_JSON ?? '',
    panesJson: herdrJson('pane', 'list'),
    tabsJson: herdrJson('tab', 'list'),
  })
  const [verb, ...rest] = decision.split(' ')
  if (verb === 'MOVE') {
    const [pane, tab, target] = rest
    execFileSync(herdr, ['pane', 'move', pane, '--tab', tab, '--target-pane', target, '--split', 'right', '--ratio', RATIO, '--label', 'watchmen', '--no-focus'], {
      stdio: 'ignore',
      timeout: 5_000,
    })
  } else if (verb === 'STOP') {
    writeFileSync(followFile, 'off\n')
    say(rest.join(' '))
  } else if (verb === 'ERROR') {
    say(rest.join(' '))
  }
} catch (error) {
  say(error.message)
} finally {
  try {
    rmdirSync(lockDir)
  } catch {}
}
