import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { decideSummon, isSafeId } from '../scripts/herdr-summon-decision.mjs'

const pane = (pane_id, tab_id, extra = {}) => ({ pane_id, tab_id, workspace_id: tab_id.split(':')[0], focused: false, ...extra })
const list = (...panes) => JSON.stringify({ result: { panes } })
const WATCH = { label: 'watchmen' }

test('none running: spawn beside the focused pane, in its folder', () => {
  assert.equal(decideSummon(list(pane('w1:p1', 'w1:t1', { focused: true, cwd: '/repo/my app' }))), 'SPAWN w1:t1 w1:p1 /repo/my app')
  assert.equal(decideSummon(list(pane('w1:p1', 'w1:t1', { focused: true }))), 'SPAWN w1:t1 w1:p1')
})

test('running in another tab: bring it beside the focused pane', () => {
  const json = list(pane('w1:p1', 'w1:t1', { focused: true }), pane('w1:p7', 'w1:t3', WATCH))
  assert.equal(decideSummon(json), 'BRING w1:p7 w1:t1 w1:p1')
})

test('running in this tab, focused or not: send it back to a tab of its own', () => {
  assert.equal(decideSummon(list(pane('w1:p1', 'w1:t1'), pane('w1:p7', 'w1:t1', { ...WATCH, focused: true }))), 'SEND w1:p7')
  assert.equal(decideSummon(list(pane('w1:p1', 'w1:t1', { focused: true }), pane('w1:p7', 'w1:t1', WATCH))), 'SEND w1:p7')
})

test('a watch is never brought across spaces', () => {
  const json = list(pane('w2:p1', 'w2:t1', { focused: true }), pane('w1:p7', 'w1:t3', WATCH))
  assert.equal(decideSummon(json), 'ERROR the watch runs in another space; summon it from there')
})

test('a labelled pane whose watch has ended is replaced, not brought; a live one elsewhere is brought', () => {
  const json = list(pane('w1:p1', 'w1:t1', { focused: true, cwd: '/repo' }), pane('w1:p7', 'w1:t3', WATCH))
  assert.equal(decideSummon(json, { isPaneAlive: () => false }), 'RESPAWN w1:p7 w1:t1 w1:p1 /repo')
  const two = list(pane('w1:p1', 'w1:t1', { focused: true }), pane('w1:p6', 'w1:t2', WATCH), pane('w1:p7', 'w1:t3', WATCH))
  assert.equal(decideSummon(two, { isPaneAlive: id => id === 'w1:p7' }), 'BRING w1:p7 w1:t1 w1:p1')
})

test('garbage or unsafe ids decide nothing', () => {
  assert.match(decideSummon('not json'), /^ERROR pane list is not JSON/)
  assert.equal(decideSummon('{"result":{}}'), 'ERROR pane list has no panes')
  assert.equal(decideSummon(list(pane('w1:p1', 'w1:t1'))), 'ERROR no focused pane')
  assert.equal(decideSummon(list(pane('--help', 'w1:t1', { focused: true }))), 'ERROR the focused pane has an unsafe id')
  assert.equal(
    decideSummon(list(pane('w1:p1', 'w1:t1', { focused: true }), pane('a;rm -rf ~', 'w1:t2', WATCH))),
    'ERROR the watchmen pane has an unsafe id',
  )
  assert.equal(isSafeId('w1:p1'), true)
  assert.equal(isSafeId('-x'), false)
})

// The action script against a fake herdr: what it would run, never a live session.
function summon(panes, { pointer, pid = '123', ratio, records = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'summon '))
  try {
    const bin = join(dir, 'herdr')
    writeFileSync(
      bin,
      `#!/usr/bin/env bash
if [ "$1 $2" = "pane list" ]; then cat "$FAKE_PANES"; exit 0; fi
printf '%s\\n' "herdr $*" >> "$FAKE_LOG"
if [ "$1 $2" = "pane split" ]; then echo '{"result":{"type":"pane_created","pane":{"pane_id":"w1:p9","tab_id":"w1:t1"}}}'; fi
`,
    )
    chmodSync(bin, 0o755)
    writeFileSync(join(dir, 'panes.json'), panes)
    writeFileSync(join(dir, 'log'), '')
    const state = join(dir, 'state')
    if (pointer) {
      mkdirSync(join(state, 'watchmen'), { recursive: true })
      writeFileSync(join(state, 'watchmen', 'current'), `${pointer}\n${pid}\n`)
    }
    mkdirSync(join(state, 'watchmen', 'panes'), { recursive: true })
    for (const [id, recordPid] of Object.entries(records)) {
      writeFileSync(join(state, 'watchmen', 'panes', id), JSON.stringify({ pane_id: id, pid: recordPid, cwd: '/ws' }))
    }
    const script = fileURLToPath(new URL('../scripts/herdr-summon.sh', import.meta.url))
    const run = spawnSync('bash', [script], {
      env: { ...process.env, WATCHMEN_RATIO: ratio ?? '', HERDR_SOCKET_PATH: join(dir, 'no.sock'), HERDR_BIN_PATH: bin, FAKE_PANES: join(dir, 'panes.json'), FAKE_LOG: join(dir, 'log'), XDG_STATE_HOME: state },
      encoding: 'utf8',
    })
    const followFile = join(state, 'watchmen', 'follow')
    const follow = existsSync(followFile) ? readFileSync(followFile, 'utf8').trim() : undefined
    return { status: run.status, stderr: run.stderr, follow, calls: readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').filter(Boolean) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the summon script spawns, brings and sends through the herdr CLI', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  const spawned = summon(list(pane('w1:p1', 'w1:t1', { focused: true, cwd: tmpdir() })), { pointer: root })
  assert.equal(spawned.status, 0, spawned.stderr)
  assert.deepEqual(spawned.calls.slice(0, 2), [
    `herdr pane split w1:p1 --direction right --ratio 0.7 --focus --cwd ${root}`,
    'herdr pane rename w1:p9 watchmen',
  ])
  assert.match(spawned.calls[2], /^herdr pane run w1:p9 .*bin\/watchmen$/)
  assert.equal(spawned.follow, 'on')

  // With no pointer, the focused pane's folder, spaces and all.
  const spaced = mkdtempSync(join(tmpdir(), 'my app '))
  try {
    const here = summon(list(pane('w1:p1', 'w1:t1', { focused: true, cwd: spaced })))
    assert.equal(here.calls[0], `herdr pane split w1:p1 --direction right --ratio 0.7 --focus --cwd ${spaced}`)
  } finally {
    rmSync(spaced, { recursive: true, force: true })
  }

  const brought = summon(list(pane('w1:p1', 'w1:t1', { focused: true }), pane('w1:p7', 'w1:t3', WATCH)))
  assert.deepEqual(brought.calls, ['herdr pane move w1:p7 --tab w1:t1 --target-pane w1:p1 --split right --ratio 0.7 --focus'])
  assert.equal(brought.follow, 'on')

  const sent = summon(list(pane('w1:p1', 'w1:t1', { focused: true }), pane('w1:p7', 'w1:t1', WATCH)))
  assert.deepEqual(sent.calls, ['herdr pane move w1:p7 --new-tab --tab-label watchmen --label watchmen --no-focus'])
  assert.equal(sent.follow, 'off')
})

test('the summon script replaces a dead watch and honours a sane WATCHMEN_RATIO', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  // The pane's own record names a pid that is gone: claude exited and left a labelled shell.
  const dead = summon(list(pane('w1:p1', 'w1:t1', { focused: true }), pane('w1:p7', 'w1:t3', WATCH)), { pointer: root, records: { 'w1:p7': 999999 } })
  assert.equal(dead.status, 0, dead.stderr)
  assert.deepEqual(dead.calls.slice(0, 3), [
    'herdr pane rename w1:p7 --clear',
    `herdr pane split w1:p1 --direction right --ratio 0.7 --focus --cwd ${root}`,
    'herdr pane rename w1:p9 watchmen',
  ])

  // A dead pid in the global pointer (another watch that quit) does not make this one dead.
  const other = summon(list(pane('w1:p1', 'w1:t1', { focused: true }), pane('w1:p7', 'w1:t3', WATCH)), { pointer: root, pid: '999999', records: { 'w1:p7': process.pid } })
  assert.match(other.calls[0], /^herdr pane move w1:p7 --tab w1:t1/)

  const wider = summon(list(pane('w1:p1', 'w1:t1', { focused: true }), pane('w1:p7', 'w1:t3', WATCH)), { ratio: '0.6' })
  assert.match(wider.calls[0], /--ratio 0\.6 /)
  for (const bad of ['0.5abc', '1', '--focus', '0.95']) {
    const run = summon(list(pane('w1:p1', 'w1:t1', { focused: true }), pane('w1:p7', 'w1:t3', WATCH)), { ratio: bad })
    assert.match(run.calls[0], /--ratio 0\.7 /, bad)
  }
})

test('the summon script does nothing on garbage and says why', () => {
  const run = summon('garbage')
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /watchmen summon: pane list is not JSON/)
  assert.deepEqual(run.calls, [])
  assert.equal(run.follow, undefined)
})
