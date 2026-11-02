// The follower: a small process that keeps the watch beside you while follow is on. It subscribes
// to herdr's tab focus events over the server socket and runs one follow step for each, debounced.
// It exits when follow turns off, when the watchmen pane is gone, or when the socket closes.
//
// Usage: node herdr-follower.mjs           run in the foreground (for testing by hand)
//        node herdr-follower.mjs --spawn   start one detached, unless one already runs
//
// The socket is HERDR_SOCKET_PATH, else ~/.config/herdr/herdr.sock. Wire format: one JSON object
// per line; the request is { id, method: "events.subscribe", params: { subscriptions } }.

import { execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isPaneEnd, isTabFocus } from './herdr-follow-decision.mjs'
import { WATCHMEN_LABEL } from './herdr-summon-decision.mjs'
import { followOnce, isFollowing, isPaneAlive, paths, setFollow } from './herdr-follow-move.mjs'

const DEBOUNCE_MS = 150
const CHECK_MS = 5_000

const { dir, pid: pidFile } = paths()

function say(text) {
  process.stderr.write(`watchmen follower: ${text}\n`)
}

/** Whether a pid runs this follower script: a recycled pid running something else does not count. */
function isFollowerPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return command.includes('herdr-follower.mjs')
  } catch {
    return false
  }
}

/** The follower recorded in the pidfile, if that process is still a follower. */
function runningFollower() {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    return isFollowerPid(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

/**
 * Claims the pidfile. The file is created exclusively, and a stale one (naming a pid that is no
 * follower) is replaced only while holding a claim directory, so of two followers that both find it
 * stale only one removes it and writes its own; the other finds a live follower and gives way. A
 * claim directory left by a crashed claim is moved aside after five seconds.
 */
function claimPidfile() {
  mkdirSync(dir, { recursive: true })
  const claim = `${pidFile}.claim`
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(claim)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(claim).mtimeMs > 5_000) {
          renameSync(claim, `${claim}.stale.${process.pid}`)
          rmSync(`${claim}.stale.${process.pid}`, { recursive: true, force: true })
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      continue
    }
    try {
      if (runningFollower() !== undefined) return false
      try {
        rmSync(pidFile)
      } catch {}
      const fd = openSync(pidFile, 'wx')
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      return true
    } finally {
      rmSync(claim, { recursive: true, force: true })
    }
  }
  return false
}

if (process.argv.includes('--spawn')) {
  if (runningFollower() === undefined && isFollowing()) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore', env: process.env })
    child.unref()
  }
  process.exit(0)
}

if (!isFollowing()) process.exit(0)
if (!claimPidfile()) {
  say('another follower is running')
  process.exit(0)
}

function stop(reason) {
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) rmSync(pidFile)
  } catch {}
  if (reason) say(reason)
  process.exit(0)
}
process.on('SIGTERM', () => stop())
process.on('SIGINT', () => stop())

/** Whether a pane labelled watchmen still holds a running watch (by its record under panes/). */
function isWatchRunning() {
  try {
    const out = execFileSync(process.env.HERDR_BIN_PATH || 'herdr', ['pane', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 })
    const panes = JSON.parse(out)?.result?.panes
    return !Array.isArray(panes) || panes.some(pane => pane?.label === WATCHMEN_LABEL && isPaneAlive(pane.pane_id))
  } catch {
    return true
  }
}

// Follow off, or the watch gone or ended: nothing left to do.
setInterval(() => {
  if (!isFollowing()) stop('follow is off')
  if (!isWatchRunning()) {
    setFollow(false)
    stop('the watch has ended')
  }
}, CHECK_MS)

let pending
let lastEvent
function onTabFocus(message) {
  lastEvent = JSON.stringify(message)
  clearTimeout(pending)
  pending = setTimeout(() => {
    try {
      const decision = followOnce(lastEvent)
      if (decision.startsWith('STOP') || decision === 'SKIP follow is off') stop(decision)
      if (decision.startsWith('ERROR')) say(decision)
    } catch (error) {
      say(error.message)
    }
  }, DEBOUNCE_MS)
}

const socketPath = process.env.HERDR_SOCKET_PATH || join(homedir(), '.config', 'herdr', 'herdr.sock')
const socket = net.createConnection(socketPath, () => {
  const subscriptions = [{ type: 'tab.focused' }, { type: 'pane.closed' }, { type: 'pane.exited' }]
  socket.write(`${JSON.stringify({ id: `watchmen:follower:${process.pid}`, method: 'events.subscribe', params: { subscriptions } })}\n`)
})
socket.setEncoding('utf8')
let buffer = ''
socket.on('data', chunk => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.error) stop(`subscribe refused: ${message.error.message ?? 'unknown error'}`)
    if (isTabFocus(message)) onTabFocus(message)
    else if (isPaneEnd(message) && !isWatchRunning()) {
      setFollow(false)
      stop('the watch pane is gone')
    }
  }
})
socket.on('error', error => stop(`socket: ${error.message}`))
socket.on('close', () => stop('socket closed'))
