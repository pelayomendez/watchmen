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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function sandbox({ follow, panesJson, lock = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'follow '))
  const bin = join(dir, 'herdr')
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
case "$1 $2" in
  "pane list") cat "$FAKE_PANES" ;;
  "tab list") cat "$FAKE_TABS" ;;
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
  if (lock) mkdirSync(join(state, 'follow.lock'))
  const env = { ...process.env, HERDR_BIN_PATH: bin, FAKE_PANES: join(dir, 'panes.json'), FAKE_TABS: join(dir, 'tabs.json'), FAKE_LOG: join(dir, 'log'), XDG_STATE_HOME: join(dir, 'state') }
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
  assert.deepEqual(box.calls(), ['herdr pane move w1:p7 --tab w1:t2 --target-pane w1:p2 --split right --ratio 0.35 --no-focus'])
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

test('the hook does nothing while follow is off or another move holds the lock', async () => {
  const off = sandbox({ follow: 'off', panesJson: BESIDE })
  await off.run(event('w1:t2'))
  assert.deepEqual(off.calls(), [])
  const locked = sandbox({ follow: 'on', panesJson: BESIDE, lock: true })
  await locked.run(event('w1:t2'))
  assert.deepEqual(locked.calls(), [])
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
