import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { decide, isFlagSafe } from '../scripts/herdr-board-decision.mjs'

const pane = (pane_id, extra = {}) => ({ pane_id, tab_id: 'w1:t1', focused: false, ...extra })
const list = (...panes) => JSON.stringify({ result: { panes } })

test('opens the board when the focused tab has none', () => {
  assert.equal(decide(list(pane('w1:p1', { focused: true }))), 'OPEN')
  // A board in another tab does not count: the panel belongs to the tab you are on.
  assert.equal(decide(list(pane('w1:p1', { focused: true }), pane('w1:p9', { tab_id: 'w1:t2', label: '⚛ watchmen' }))), 'OPEN')
})

test('focuses an open board, and closes it when it is the focused pane', () => {
  assert.equal(decide(list(pane('w1:p1', { focused: true }), pane('w1:p2', { label: '⚛ watchmen' }))), 'FOCUS w1:p2')
  assert.equal(decide(list(pane('w1:p1'), pane('w1:p2', { label: '⚛ watchmen', focused: true }))), 'CLOSE w1:p2')
  assert.equal(decide(list(pane('w1:p1', { focused: true }), pane('w1:p2', { plugin_id: 'watchmen', entrypoint: 'board' }))), 'FOCUS w1:p2')
  assert.equal(decide(list(pane('w1:p1', { focused: true }), pane('w1:p2', { plugin_id: 'pelayomendez.watchmen', entrypoint: 'board' }))), 'FOCUS w1:p2')
})

test('anything unreadable or unsafe opens instead of acting on a pane id', () => {
  assert.equal(decide('not json'), 'OPEN')
  assert.equal(decide('{"result":{}}'), 'OPEN')
  assert.equal(decide(list(pane('w1:p1'))), 'OPEN')
  assert.equal(decide(list(pane('w1:p1', { focused: true }), pane('--help', { label: '⚛ watchmen' }))), 'OPEN')
  assert.equal(decide(list(pane('w1:p1', { focused: true }), pane('a;rm -rf', { label: '⚛ watchmen' }))), 'OPEN')
  assert.equal(isFlagSafe('w1:p2'), true)
  assert.equal(isFlagSafe('-x'), false)
})

test('the command decides through a symlinked path with a space in it', () => {
  // herdr runs plugins from a folder it chose; the command must not depend on how it is reached.
  const dir = mkdtempSync(join(tmpdir(), 'watch men '))
  try {
    const scripts = fileURLToPath(new URL('../scripts/', import.meta.url))
    const linked = join(dir, 'scripts dir')
    symlinkSync(scripts, linked)
    const input = list(pane('w1:p1'), pane('w1:p2', { label: '⚛ watchmen', focused: true }))
    const out = execFileSync(process.execPath, [join(linked, 'herdr-board-decide.mjs')], { input, encoding: 'utf8' })
    assert.equal(out, 'CLOSE w1:p2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
