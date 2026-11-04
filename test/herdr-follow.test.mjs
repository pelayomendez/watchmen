import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decideFollow, focusedTabOf } from '../scripts/herdr-follow-decision.mjs'

const pane = (pane_id, tab_id, extra = {}) => ({ pane_id, tab_id, workspace_id: 'w1', focused: false, ...extra })
const panes = (...list) => JSON.stringify({ result: { panes: list } })
const tabs = (...list) => JSON.stringify({ result: { tabs: list } })
const event = (tab_id, workspace_id = 'w1') => JSON.stringify({ event: 'tab_focused', data: { type: 'tab_focused', tab_id, workspace_id } })
const WATCH = { label: 'watchmen' }
const TABS = tabs({ tab_id: 'w1:t1', label: 'api', workspace_id: 'w1' }, { tab_id: 'w1:t2', label: 'web', workspace_id: 'w1' }, { tab_id: 'w1:t9', label: 'watchmen', workspace_id: 'w1' })

const decide = over => decideFollow({ isFollowing: true, eventJson: event('w1:t2'), tabsJson: TABS, ...over })

test('stops when the watch in the labelled pane has ended, judged by that pane alone', () => {
  const json = panes(pane('w1:p7', 'w1:t1', WATCH), pane('w1:p2', 'w1:t2', { focused: true }))
  assert.equal(decide({ panesJson: json, isPaneAlive: id => id !== 'w1:p7' }), 'STOP the watch has ended')
  assert.equal(decide({ panesJson: json, isPaneAlive: id => id === 'w1:p7' }), 'MOVE w1:p7 w1:t2 w1:p2')
})

test('follows into the newly focused tab, beside the pane that has focus there', () => {
  const json = panes(pane('w1:p7', 'w1:t1', WATCH), pane('w1:p1', 'w1:t1'), pane('w1:p2', 'w1:t2'), pane('w1:p3', 'w1:t2', { focused: true }))
  assert.equal(decide({ panesJson: json }), 'MOVE w1:p7 w1:t2 w1:p3')
})

test('skips the tab it is already in', () => {
  const json = panes(pane('w1:p7', 'w1:t2', WATCH), pane('w1:p2', 'w1:t2', { focused: true }))
  assert.equal(decide({ panesJson: json }), 'SKIP already in this tab')
})

test('skips its own home tab', () => {
  const json = panes(pane('w1:p7', 'w1:t1', WATCH), pane('w1:p8', 'w1:t9', { focused: true }))
  assert.equal(decide({ panesJson: json, eventJson: event('w1:t9') }), "SKIP the watch's own tab")
})

test('follows only within its own workspace', () => {
  const json = panes(pane('w1:p7', 'w1:t1', WATCH), pane('w2:p1', 'w2:t1', { workspace_id: 'w2', focused: true }))
  assert.equal(decide({ panesJson: json, eventJson: event('w2:t1', 'w2') }), 'SKIP another workspace')
})

test('does nothing while follow is off', () => {
  const json = panes(pane('w1:p7', 'w1:t1', WATCH), pane('w1:p2', 'w1:t2', { focused: true }))
  assert.equal(decide({ panesJson: json, isFollowing: false }), 'SKIP follow is off')
})

test('stops following once the watch pane is gone', () => {
  assert.equal(decide({ panesJson: panes(pane('w1:p2', 'w1:t2', { focused: true })) }), 'STOP the watch pane is gone')
})

test('untrusted input decides nothing', () => {
  const json = panes(pane('w1:p7', 'w1:t1', WATCH), pane('w1:p2', 'w1:t2', { focused: true }))
  assert.equal(decide({ panesJson: json, eventJson: 'nope' }), 'ERROR the event names no tab')
  assert.equal(decide({ panesJson: json, eventJson: event('--tab') }), 'ERROR the event names an unsafe tab id')
  assert.equal(decide({ panesJson: 'garbage' }), 'ERROR pane list is unreadable')
  assert.equal(decide({ panesJson: panes(pane('a b', 'w1:t1', WATCH), pane('w1:p2', 'w1:t2', { focused: true })) }), 'ERROR the watchmen pane has an unsafe id')
})

test('reads the focused tab wherever herdr nests it in the event', () => {
  assert.deepEqual(focusedTabOf('{"tab_id":"w1:t2","workspace_id":"w1"}'), { tab_id: 'w1:t2', workspace_id: 'w1' })
  assert.deepEqual(focusedTabOf(event('w1:t3')), { tab_id: 'w1:t3', workspace_id: 'w1' })
  assert.equal(focusedTabOf('{}'), undefined)
})

// The hook itself against a fake herdr: what it would run, never a live session.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function sandbox({ follow, panesJson, lockOwner, pointer, records = {}, moveAnswer = '' }) {
  const dir = mkdtempSync(join(tmpdir(), 'follow '))
  const bin = join(dir, 'herdr')
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
case "$1 $2" in
  "pane list") cat "$FAKE_PANES" ;;
  "tab list") cat "$FAKE_TABS" ;;
  "pane move") printf '%s\\n' "herdr $*" >> "$FAKE_LOG"; cat "$FAKE_MOVE" ;;
  *) printf '%s\\n' "herdr $*" >> "$FAKE_LOG" ;;
esac
`,
  )
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'panes.json'), panesJson)
  writeFileSync(join(dir, 'tabs.json'), TABS)
  writeFileSync(join(dir, 'log'), '')
  const state = join(dir, 'state', 'watchmen')
  mkdirSync(state, { recursive: true })
  if (follow) writeFileSync(join(state, 'follow'), `${follow}\n`)
  if (lockOwner) {
    mkdirSync(join(state, 'follow.lock'))
    writeFileSync(join(state, 'follow.lock', 'owner'), lockOwner)
  }
  if (pointer) writeFileSync(join(state, 'current'), pointer)
  mkdirSync(join(state, 'panes'), { recursive: true })
  for (const [id, pid] of Object.entries(records)) writeFileSync(join(state, 'panes', id), JSON.stringify({ pane_id: id, pid, cwd: '/ws' }))
  writeFileSync(join(dir, 'move.json'), moveAnswer)
  const env = { ...process.env, HERDR_BIN_PATH: bin, FAKE_PANES: join(dir, 'panes.json'), FAKE_TABS: join(dir, 'tabs.json'), FAKE_LOG: join(dir, 'log'), FAKE_MOVE: join(dir, 'move.json'), XDG_STATE_HOME: join(dir, 'state') }
  const run = eventJson =>
    new Promise(resolve => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/herdr-follow.mjs', import.meta.url))], {
        env: { ...env, HERDR_PLUGIN_EVENT_JSON: eventJson },
      })
      child.on('exit', resolve)
    })
  const calls = () => readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').filter(Boolean)
  const followState = () => (existsSync(join(state, 'follow')) ? readFileSync(join(state, 'follow'), 'utf8').trim() : undefined)
  return { run, calls, followState, state }
}

const BESIDE = panes(pane('w1:p7', 'w1:t1', WATCH), pane('w1:p2', 'w1:t2', { focused: true }))

test('the hook moves the watch without taking focus', async () => {
  const box = sandbox({ follow: 'on', panesJson: BESIDE })
  await box.run(event('w1:t2'))
  assert.deepEqual(box.calls(), ['herdr pane move w1:p7 --tab w1:t2 --target-pane w1:p2 --split right --ratio 0.7 --no-focus'])
})

test('the hook gives way when a newer event arrives within the debounce', async () => {
  const box = sandbox({ follow: 'on', panesJson: BESIDE })
  const done = box.run(event('w1:t2'))
  // As soon as this run has stamped itself, a newer event stamps over it.
  const latest = join(box.state, 'follow.latest')
  while (!existsSync(latest)) await new Promise(r => setTimeout(r, 2))
  writeFileSync(latest, 'newer:event')
  await done
  assert.deepEqual(box.calls(), [])
})

test('the hook does nothing while follow is off', async () => {
  const off = sandbox({ follow: 'off', panesJson: BESIDE })
  await off.run(event('w1:t2'))
  assert.deepEqual(off.calls(), [])
})

test('a run that waits for the lock follows the tab focused once it holds it', async () => {
  // A live owner (this test process) holds the lock; the event names the watch's own tab, but by
  // the time the lock frees the person is in w1:t2, and that is where the watch goes.
  const box = sandbox({ follow: 'on', panesJson: BESIDE, lockOwner: `${process.pid}:held` })
  const done = box.run(event('w1:t1'))
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.deepEqual(box.calls(), [])
  rmSync(join(box.state, 'follow.lock'), { recursive: true, force: true })
  await done
  assert.deepEqual(box.calls(), ['herdr pane move w1:p7 --tab w1:t2 --target-pane w1:p2 --split right --ratio 0.7 --no-focus'])
})

test('a lock whose owner died is taken over at once', async () => {
  const box = sandbox({ follow: 'on', panesJson: BESIDE, lockOwner: '999999:dead' })
  await box.run(event('w1:t2'))
  assert.equal(box.calls().length, 1)
  assert.equal(existsSync(join(box.state, 'follow.lock')), false)
})

test('follow stops once the watch in its pane has ended; another watch elsewhere does not count', async () => {
  // The global pointer names a dead launcher (a second watch that quit): it no longer decides.
  const alive = sandbox({ follow: 'on', panesJson: BESIDE, pointer: '/elsewhere\n999999\n', records: { 'w1:p7': process.pid } })
  await alive.run(event('w1:t2'))
  assert.equal(alive.calls().length, 1)
  assert.equal(alive.followState(), 'on')

  const dead = sandbox({ follow: 'on', panesJson: BESIDE, records: { 'w1:p7': 999999 } })
  await dead.run(event('w1:t2'))
  assert.deepEqual(dead.calls(), [])
  assert.equal(dead.followState(), 'off')
})

test('a move that gives the pane a new id moves its record with it', async () => {
  const moveAnswer = JSON.stringify({ result: { type: 'pane_moved', previous_pane_id: 'w1:p7', pane: { pane_id: 'w1:p8', tab_id: 'w1:t2' } } })
  const box = sandbox({ follow: 'on', panesJson: BESIDE, records: { 'w1:p7': process.pid }, moveAnswer })
  await box.run(event('w1:t2'))
  assert.equal(existsSync(join(box.state, 'panes', 'w1:p7')), false)
  assert.equal(JSON.parse(readFileSync(join(box.state, 'panes', 'w1:p8'), 'utf8')).pid, process.pid)
})

test('the split ratio is the person\'s share, 0.7 unless WATCHMEN_RATIO gives a sane one', async () => {
  const { ratioOf } = await import('../scripts/herdr-follow-move.mjs')
  assert.equal(ratioOf({}), '0.7')
  assert.equal(ratioOf({ WATCHMEN_RATIO: '0.6' }), '0.6')
  assert.equal(ratioOf({ WATCHMEN_RATIO: '.75' }), '.75')
  for (const bad of ['0.05', '0.95', '1', '0.5abc', '--help', '0.5 --focus', '']) assert.equal(ratioOf({ WATCHMEN_RATIO: bad }), '0.7', bad)
})
test('the hook turns follow off once the watch pane is gone', async () => {
  const box = sandbox({ follow: 'on', panesJson: panes(pane('w1:p2', 'w1:t2', { focused: true })) })
  await box.run(event('w1:t2'))
  assert.equal(box.followState(), 'off')
  assert.deepEqual(box.calls(), [])
})

test('a split move never passes --label: herdr accepts it only with --new-tab or --new-workspace', async () => {
  const box = sandbox({ follow: 'on', panesJson: BESIDE })
  await box.run(event('w1:t2'))
  const [move] = box.calls()
  assert.match(move, /--split right/)
  assert.doesNotMatch(move, /--label/)
})

test('the hook and the follower both firing for one switch move the pane once', async () => {
  const { followOnce } = await import('../scripts/herdr-follow-move.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'both '))
  const panesFile = join(dir, 'panes.json')
  const log = join(dir, 'log')
  const bin = join(dir, 'herdr')
  // A fake herdr whose move really moves: the watch pane's tab becomes the target's.
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
case "$1 $2" in
  "pane list") cat "$FAKE_PANES" ;;
  "tab list") cat "$FAKE_TABS" ;;
  "pane move")
    printf '%s\\n' "herdr $*" >> "$FAKE_LOG"
    node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f));for(const p of d.result.panes){if(p.pane_id===process.argv[2])p.tab_id=process.argv[3]}fs.writeFileSync(f,JSON.stringify(d))' "$FAKE_PANES" "$3" "$5" ;;
esac
`,
  )
  chmodSync(bin, 0o755)
  writeFileSync(panesFile, BESIDE)
  writeFileSync(join(dir, 'tabs.json'), TABS)
  writeFileSync(log, '')
  mkdirSync(join(dir, 'state', 'watchmen'), { recursive: true })
  writeFileSync(join(dir, 'state', 'watchmen', 'follow'), 'on\n')
  const env = { ...process.env, HERDR_BIN_PATH: bin, FAKE_PANES: panesFile, FAKE_TABS: join(dir, 'tabs.json'), FAKE_LOG: log, XDG_STATE_HOME: join(dir, 'state') }

  assert.equal(followOnce(event('w1:t2'), env), 'MOVE w1:p7 w1:t2 w1:p2')
  assert.equal(followOnce(event('w1:t2'), env), 'SKIP already in this tab')
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1)
})

// A fake herdr whose pane list answers from a sequence of files, one per call, the last repeating.
function flickerWorld(sequence) {
  const dir = mkdtempSync(join(tmpdir(), 'flicker '))
  const bin = join(dir, 'herdr')
  sequence.forEach((json, at) => writeFileSync(join(dir, `panes.${at}.json`), json))
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
case "$1 $2" in
  "pane list")
    n=$(cat "$FAKE_DIR/count" 2>/dev/null || echo 0)
    f="$FAKE_DIR/panes.$n.json"; [ -f "$f" ] || f="$FAKE_DIR/panes.${sequence.length - 1}.json"
    echo $((n + 1)) > "$FAKE_DIR/count"; cat "$f" ;;
  "tab list") cat "$FAKE_DIR/tabs.json" ;;
  *) printf '%s\\n' "herdr $*" >> "$FAKE_DIR/log" ;;
esac
`,
  )
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'tabs.json'), TABS)
  mkdirSync(join(dir, 'state', 'watchmen'), { recursive: true })
  writeFileSync(join(dir, 'state', 'watchmen', 'follow'), 'on\n')
  const env = { ...process.env, HERDR_BIN_PATH: bin, FAKE_DIR: dir, XDG_STATE_HOME: join(dir, 'state') }
  const follow = () => readFileSync(join(dir, 'state', 'watchmen', 'follow'), 'utf8').trim()
  const log = () => (existsSync(join(dir, 'state', 'watchmen', 'follow.log')) ? readFileSync(join(dir, 'state', 'watchmen', 'follow.log'), 'utf8') : '')
  return { env, follow, log }
}

test('a watch missing from one pane list does not turn follow off: a second look finds it and moves it', async () => {
  const { followOnce } = await import('../scripts/herdr-follow-move.mjs')
  const gone = panes(pane('w1:p2', 'w1:t2', { focused: true }))
  const world = flickerWorld([gone, BESIDE])
  assert.equal(followOnce(event('w1:t2'), world.env, 10), 'MOVE w1:p7 w1:t2 w1:p2')
  assert.equal(world.follow(), 'on')
  assert.match(world.log(), /kept following/)
})

test('a watch gone on both looks turns follow off and says why in follow.log', async () => {
  const { followOnce } = await import('../scripts/herdr-follow-move.mjs')
  const world = flickerWorld([panes(pane('w1:p2', 'w1:t2', { focused: true }))])
  assert.equal(followOnce(event('w1:t2'), world.env, 10), 'STOP the watch pane is gone')
  assert.equal(world.follow(), 'off')
  assert.match(world.log(), /follow off: STOP the watch pane is gone/)
})
